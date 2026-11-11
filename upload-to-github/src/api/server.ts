import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { marketplaceStatus, type App } from "../app";
import { CONDITIONS, MARKETPLACES, parseJson, type Actor, type ListingRow, type MarketplaceId, type ProductRow, type Role } from "../core/types";
import { AppError, clock } from "../core/util";
import { importSpreadsheet } from "../ingest/import";
import { hmacHex, randomToken, safeEqual } from "../security/crypto";
import { redactSecrets } from "../security/sanitize";
import { canChangeAutomation } from "../policy/engine";
import { SPECS } from "../marketplaces/specs";
import type { UserRow } from "../auth/service";

const SESSION_COOKIE = "rs_session";
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(here, "..", "..", "web", "dist");

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
    rawBody?: string;
  }
}

export interface ServerOptions {
  cookieSecure?: boolean;
  logger?: boolean;
}

const marketplaceEnum = z.enum(MARKETPLACES);
const cents = z.number().int().min(0).max(100_000_000);
const productBody = z
  .object({
    title: z.string().max(200).nullish(),
    brand: z.string().max(200).nullish(),
    model: z.string().max(200).nullish(),
    category: z.string().max(200).nullish(),
    department: z.string().max(40).nullish(),
    size: z.string().max(40).nullish(),
    color: z.string().max(80).nullish(),
    material: z.string().max(200).nullish(),
    condition: z.enum(CONDITIONS).nullish(),
    condition_notes: z.string().max(2000).nullish(),
    style_number: z.string().max(80).nullish(),
    upc: z.string().max(40).nullish(),
    notes: z.string().max(2000).nullish(),
    storage_location: z.string().max(120).nullish(),
    acquisition_cost_cents: cents.nullish(),
    extra_cost_cents: cents.optional(),
    min_price_cents: cents.nullish(),
    quantity: z.number().int().min(1).max(9999).optional(),
    attributes: z.record(z.string().max(60), z.string().max(300)).optional(),
  })
  .strict();

function productView(p: ProductRow) {
  return { ...p, attributes: parseJson(p.attributes, {}), identification: parseJson(p.identification, null), risk_flags: parseJson<string[]>(p.risk_flags, []) };
}
function listingView(l: ListingRow) {
  return { ...l, attributes: parseJson(l.attributes, {}), quality: parseJson(l.quality, {}), validation: parseJson(l.validation, {}), simulated: l.simulated === 1, marketplaceName: SPECS[l.marketplace].name };
}

export async function buildServer(app: App, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const f = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024, trustProxy: false });

  await f.register(cookie);
  await f.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 40 } });
  await f.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });

  // Keep the raw JSON body so webhook signatures can be verified over the exact bytes received.
  f.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new AppError("bad_json", "Request body is not valid JSON.", 400), undefined);
    }
  });

  f.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });

  f.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send({ error: error.code, message: error.message, detail: error.detail });
    if (error instanceof z.ZodError) return reply.status(400).send({ error: "invalid_input", message: "Some fields are not valid.", detail: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const e = error as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: "bad_request", message: e.message });
    console.error("request failed:", redactSecrets(String(e.message ?? error)));
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong on the server. The error was logged." });
  });

  // ---- authentication and authorisation ------------------------------------------------
  const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\/login$/, /^\/api\/auth\/setup-state$/, /^\/api\/webhooks\//, /^\/api\/connections\/ebay\/callback/];
  f.addHook("preHandler", async (req) => {
    const url = req.url.split("?")[0]!;
    if (!url.startsWith("/api/")) return;
    if (PUBLIC.some((re) => re.test(url))) return;
    const user = app.auth.authenticate(req.cookies[SESSION_COOKIE]);
    if (!user) throw new AppError("unauthenticated", "Sign in to continue.", 401);
    req.user = user;
    // Cross-site request forgery: state-changing requests must carry a header a cross-site form cannot set.
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== "resale-ops") {
      throw new AppError("csrf", "Request rejected.", 403);
    }
  });

  const rank: Record<Role, number> = { viewer: 0, manager: 1, owner: 2 };
  const need = (req: FastifyRequest, role: Role): Actor => {
    const user = req.user!;
    if (rank[user.role] < rank[role]) throw new AppError("forbidden", `This needs the ${role} role.`, 403);
    return app.auth.actorFor(user);
  };
  const actor = (req: FastifyRequest): Actor => app.auth.actorFor(req.user!);

  // ---- health & auth ---------------------------------------------------------------------
  f.get("/api/health", async () => ({ ok: true, time: clock.iso() }));
  f.get("/api/auth/setup-state", async () => ({ needsSetup: app.auth.userCount() === 0 }));

  f.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().max(200), password: z.string().max(500) }).parse(req.body);
    const { token, user } = app.auth.login(body.email, body.password);
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: opts.cookieSecure ?? false, path: "/", maxAge: 14 * 24 * 3600 });
    return { user: { id: user.id, email: user.email, role: user.role } };
  });
  f.post("/api/auth/logout", async (req, reply) => {
    app.auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
  f.get("/api/auth/me", async (req) => ({ user: { id: req.user!.id, email: req.user!.email, role: req.user!.role } }));

  // ---- overview --------------------------------------------------------------------------
  f.get("/api/overview", async () => {
    const s = app.settings.get();
    return {
      overview: app.analytics.overview(false),
      automation: s.automation,
      marketplaces: app.analytics.byMarketplace(false),
      jobs: app.queue.counts(),
      unreadNotifications: app.notifications.unreadCount(),
      ai: { provider: s.ai.provider, available: app.ai().available(), simulated: app.ai().simulated },
    };
  });

  // ---- products --------------------------------------------------------------------------
  f.get("/api/products", async (req) => {
    const q = z.object({ status: z.string().optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    const products = app.products.list(q);
    const ids = products.map((p) => p.id);
    const byProduct = new Map<string, { listings: ReturnType<typeof listingView>[]; image: string | null }>();
    for (const id of ids) byProduct.set(id, { listings: [], image: null });
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      for (const l of app.db.prepare(`SELECT * FROM listings WHERE product_id IN (${marks}) AND status != 'archived'`).all(...ids) as ListingRow[]) byProduct.get(l.product_id)!.listings.push(listingView(l));
      for (const i of app.db.prepare(`SELECT product_id, id FROM product_images WHERE product_id IN (${marks}) AND position = 0`).all(...ids) as { product_id: string; id: string }[]) byProduct.get(i.product_id)!.image = i.id;
    }
    return {
      products: products.map((p) => {
        const extra = byProduct.get(p.id)!;
        const rec = app.research.latestRecommendation(p.id);
        return {
          ...productView(p),
          imageId: extra.image,
          listings: extra.listings.map((l) => ({ id: l.id, marketplace: l.marketplace, status: l.status, price_cents: l.price_cents, simulated: l.simulated })),
          expectedSellingCents: rec?.expectedSellingCents ?? null,
          estimatedProfitCents: rec?.perMarketplace.length ? Math.max(...rec.perMarketplace.map((m) => m.atExpectedPrice.netProfitCents)) : null,
        };
      }),
    };
  });

  f.post("/api/products", async (req) => {
    const a = need(req, "manager");
    const body = productBody.parse(req.body);
    const product = app.products.create(body, a, "manual");
    app.queue.enqueue("product.process", { productId: product.id }, { idempotencyKey: `process:${product.id}:v${product.version}` });
    return { product: productView(product) };
  });

  /** Upload photos. mode=single → one product with all photos; mode=each → one product per photo. */
  f.post("/api/products/upload", async (req) => {
    const a = need(req, "manager");
    const files: { filename: string; buffer: Buffer }[] = [];
    const fields: Record<string, string> = {};
    for await (const part of req.parts()) {
      if (part.type === "file") files.push({ filename: part.filename, buffer: await part.toBuffer() });
      else fields[part.fieldname] = String(part.value);
    }
    if (files.length === 0) throw new AppError("no_files", "Choose at least one photo.", 400);
    const mode = fields.mode === "each" ? "each" : "single";
    const cost = fields.cost_cents ? Number(fields.cost_cents) : null;
    if (cost !== null && (!Number.isInteger(cost) || cost < 0)) throw new AppError("bad_cost", "Cost is not valid.", 400);
    const groups = mode === "each" ? files.map((file) => [file]) : [files];
    const created: { id: string; sku: string; photos: number; possibleDuplicateOf: string | null }[] = [];
    const skipped: { filename: string; reason: string }[] = [];

    for (const group of groups) {
      let product: ProductRow | null = null;
      let possibleDuplicateOf: string | null = null;
      let photos = 0;
      for (const file of group) {
        let analysis;
        try {
          const { analyzeImage } = await import("../images/process");
          analysis = await analyzeImage(file.buffer, app.settings.get().images);
        } catch (error) {
          const message = (error as Error).message;
          skipped.push({ filename: file.filename, reason: /HEIC/.test(message) ? message : "Not a readable image" });
          continue;
        }
        const dup = app.products.findDuplicate(analysis.sha256, analysis.phash, product?.id);
        if (dup?.kind === "exact") {
          skipped.push({ filename: file.filename, reason: `This exact photo is already on ${dup.sku}` });
          continue;
        }
        if (dup) possibleDuplicateOf = dup.sku;
        product ??= app.products.create({ acquisition_cost_cents: cost, notes: fields.notes || null, storage_location: fields.storage_location || null }, a, "upload");
        const added = await app.products.addImage(product.id, file.buffer, a);
        if (added.added) photos++;
      }
      if (product) {
        if (possibleDuplicateOf) app.audit.record({ actor: a, action: "product.possible_duplicate", entityType: "product", entityId: product.id, productId: product.id, detail: { similarTo: possibleDuplicateOf } });
        if (fields.process !== "false") app.queue.enqueue("product.process", { productId: product.id }, { idempotencyKey: `process:${product.id}:v${product.version}` });
        created.push({ id: product.id, sku: product.sku, photos, possibleDuplicateOf });
      }
    }
    return { created, skipped };
  });

  f.post("/api/products/import", async (req) => {
    const a = need(req, "manager");
    const file = await req.file();
    if (!file) throw new AppError("no_file", "Choose a CSV or Excel file.", 400);
    if (!/\.(csv|xlsx)$/i.test(file.filename)) throw new AppError("bad_type", "Only .csv and .xlsx files can be imported.", 400);
    const result = await importSpreadsheet(app, await file.toBuffer(), file.filename, a);
    for (const p of result.created) app.queue.enqueue("product.process", { productId: p.id }, { idempotencyKey: `process:${p.id}:v1` });
    return result;
  });

  f.get("/api/products/:id", async (req) => {
    const { id } = req.params as { id: string };
    const p = app.products.get(id);
    const images = app.products.images(p.id);
    return {
      product: productView(p),
      images: images.map((i) => ({ id: i.id, position: i.position, width: i.width, height: i.height, blur_score: i.blur_score, view_label: i.view_label, quality: parseJson(i.quality, {}) })),
      suggestedPhotos: app.products.suggestedPhotos(p.id),
      criticalMissing: app.products.criticalMissing(p, images.length),
      listings: app.listings.forProduct(p.id).map(listingView),
      comps: app.research.comps(p.id),
      pricing: app.research.latestRecommendation(p.id),
      stages: app.products.stages(p.id),
      orders: app.sales.orders({ productId: p.id }),
      audit: app.audit.list({ productId: p.id, limit: 200 }).map((r) => ({ ...r, detail: parseJson(r.detail, null) })),
    };
  });

  f.patch("/api/products/:id", async (req) => {
    const a = need(req, "manager");
    const { id } = req.params as { id: string };
    return { product: productView(app.products.update(id, productBody.parse(req.body), a)) };
  });

  f.post("/api/products/:id/images", async (req) => {
    const a = need(req, "manager");
    const { id } = req.params as { id: string };
    const p = app.products.get(id);
    let added = 0;
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      try {
        if ((await app.products.addImage(p.id, await part.toBuffer(), a)).added) added++;
      } catch (error) {
        const message = (error as Error).message;
        throw new AppError("bad_image", /HEIC/.test(message) ? message : `${part.filename} is not a readable image.`, 400);
      }
    }
    return { added };
  });

  f.post("/api/products/:id/confirm", async (req) => {
    const a = need(req, "manager");
    return { product: productView(app.products.confirmIdentification((req.params as { id: string }).id, a)) };
  });

  f.post("/api/products/:id/process", async (req) => {
    need(req, "manager");
    const p = app.products.get((req.params as { id: string }).id);
    const jobId = app.queue.enqueue("product.process", { productId: p.id }, { idempotencyKey: `process:${p.id}:v${p.version}:${Date.now()}` });
    return { jobId };
  });

  f.post("/api/products/:id/comps", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ kind: z.enum(["sold", "active"]), title: z.string().min(2).max(200), priceCents: cents.min(1), marketplace: marketplaceEnum.nullish(), condition: z.string().max(60).nullish(), soldAt: z.string().max(40).nullish(), url: z.string().max(500).nullish() }).parse(req.body);
    const comp = app.research.addManualComp((req.params as { id: string }).id, { ...body, marketplace: body.marketplace ?? null }, a);
    return { comp, pricing: app.research.recommend(comp.product_id, a) };
  });

  f.delete("/api/comps/:id", async (req) => {
    app.research.removeComp((req.params as { id: string }).id, need(req, "manager"));
    return { ok: true };
  });

  f.post("/api/products/:id/reprice-recommendation", async (req) => {
    const a = need(req, "manager");
    return { pricing: app.research.recommend((req.params as { id: string }).id, a) };
  });

  f.post("/api/products/:id/archive", async (req) => {
    app.products.archive((req.params as { id: string }).id, need(req, "manager"));
    return { ok: true };
  });

  // ---- images ----------------------------------------------------------------------------
  const sendImage = (reply: FastifyReply, id: string, variant: string) => {
    const row = app.db.prepare("SELECT original_path, optimized_path FROM product_images WHERE id = ?").get(id) as { original_path: string; optimized_path: string | null } | undefined;
    const file = row ? (variant === "original" ? row.original_path : (row.optimized_path ?? row.original_path)) : null;
    // Paths come from the database, never from the request, and must sit inside the data directory.
    if (!file || !path.resolve(file).startsWith(path.resolve(app.dataDir)) || !existsSync(file)) throw new AppError("not_found", "Image not found", 404);
    reply.header("Cache-Control", "private, max-age=3600");
    const types: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic", ".avif": "image/avif", ".gif": "image/gif", ".tiff": "image/tiff" };
    reply.type(types[path.extname(file).toLowerCase()] ?? "image/jpeg");
    return reply.send(createReadStream(file));
  };
  f.get("/api/images/:id", async (req, reply) => sendImage(reply, (req.params as { id: string }).id, (req.query as { variant?: string }).variant ?? "optimized"));
  /** Signed, unauthenticated link to an optimised photo, for marketplaces that fetch photos by URL. */
  f.get("/public/img/:file", async (req, reply) => {
    const id = (req.params as { file: string }).file.replace(/\.jpg$/, "");
    const sig = (req.query as { s?: string }).s ?? "";
    if (!app.box.verify(id, sig)) throw new AppError("not_found", "Not found", 404);
    return sendImage(reply, id, "optimized");
  });

  // ---- listings --------------------------------------------------------------------------
  f.get("/api/listings", async (req) => {
    const q = z.object({ status: z.string().optional(), marketplace: z.string().optional() }).parse(req.query);
    const rows = app.listings.list(q);
    const skus = new Map((app.db.prepare("SELECT id, sku, title FROM products").all() as { id: string; sku: string; title: string | null }[]).map((p) => [p.id, p]));
    return { listings: rows.map((l) => ({ ...listingView(l), sku: skus.get(l.product_id)?.sku, productTitle: skus.get(l.product_id)?.title, metrics: app.listings.latestMetrics(l.id) })) };
  });

  f.get("/api/listings/:id", async (req) => {
    const l = app.listings.get((req.params as { id: string }).id);
    return { listing: listingView(l), revisions: app.listings.revisions(l.id), metrics: app.listings.latestMetrics(l.id), spec: SPECS[l.marketplace] };
  });

  f.post("/api/products/:id/listings/generate", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ marketplaces: z.array(marketplaceEnum).optional() }).parse(req.body ?? {});
    return { listings: (await app.listings.generate((req.params as { id: string }).id, a, body.marketplaces)).map(listingView) };
  });

  f.patch("/api/listings/:id", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ title: z.string().max(200).optional(), description: z.string().max(6000).optional(), priceCents: cents.min(100).optional() }).strict().parse(req.body);
    const result = await app.listings.edit((req.params as { id: string }).id, body, a);
    return { result, listing: listingView(app.listings.get((req.params as { id: string }).id)) };
  });

  f.post("/api/listings/:id/publish", async (req) => {
    const a = need(req, "manager");
    const result = app.listings.requestPublish((req.params as { id: string }).id, a);
    return { result, listing: listingView(app.listings.get((req.params as { id: string }).id)) };
  });

  f.post("/api/listings/:id/end", async (req) => {
    const a = need(req, "manager");
    const result = app.listings.requestEnd((req.params as { id: string }).id, a, "operator", `operator:${Date.now()}`);
    return { result };
  });

  f.post("/api/listings/:id/reprice", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ priceCents: cents.min(1), reason: z.string().max(200).optional() }).parse(req.body);
    return { result: await app.listings.reprice((req.params as { id: string }).id, body.priceCents, a, body.reason ?? "Operator price change") };
  });

  f.post("/api/listings/:id/metrics", async (req) => {
    need(req, "manager");
    const body = z.object({ views: z.number().int().min(0).optional(), likes: z.number().int().min(0).optional(), watchers: z.number().int().min(0).optional(), offers: z.number().int().min(0).optional(), impressions: z.number().int().min(0).optional() }).parse(req.body);
    app.optimizer.recordManualMetrics(app.listings.get((req.params as { id: string }).id).id, body);
    return { ok: true };
  });

  // ---- review queue ----------------------------------------------------------------------
  f.get("/api/review", async () => {
    const titles = new Map((app.db.prepare("SELECT id, sku, title FROM products").all() as { id: string; sku: string; title: string | null }[]).map((p) => [p.id, p]));
    const label = (productId: string | null) => (productId ? { sku: titles.get(productId)?.sku ?? null, productTitle: titles.get(productId)?.title ?? null } : { sku: null, productTitle: null });
    return {
      approvals: app.approvals.list("pending").map((r) => ({ ...app.approvals.view(r), ...label(r.product_id) })),
      tasks: app.listings.tasks("open").map((t) => ({ ...t, payload: parseJson(t.payload, {}), marketplaceName: SPECS[t.marketplace as MarketplaceId]?.name, ...label(t.product_id) })),
      products: app.db.prepare("SELECT * FROM products WHERE status IN ('identification_required','needs_review') ORDER BY updated_at DESC").all().map((p) => {
        const row = p as ProductRow;
        return { ...productView(row), criticalMissing: app.products.criticalMissing(row) };
      }),
      failedListings: app.listings.list({ status: "publication_failed" }).map((l) => ({ ...listingView(l), ...label(l.product_id) })),
      discrepancies: app.reconciler.list(true).map((d) => ({ ...d, ...label(d.product_id) })),
      deadJobs: app.queue.list({ status: "dead", limit: 50 }),
      recentDecisions: app.approvals.list(undefined, 30).filter((r) => r.status !== "pending").map((r) => ({ ...app.approvals.view(r), ...label(r.product_id) })),
    };
  });

  f.post("/api/approvals/:id/decide", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional() }).parse(req.body);
    return { approval: app.approvals.view(await app.approvals.decide((req.params as { id: string }).id, body.decision, a, body.note)) };
  });

  f.post("/api/tasks/:id/complete", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ externalUrl: z.string().max(500).optional(), externalId: z.string().max(200).optional() }).parse(req.body ?? {});
    return { task: app.listings.completeTask((req.params as { id: string }).id, a, body) };
  });

  f.post("/api/discrepancies/:id/resolve", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ resolution: z.string().min(2).max(300) }).parse(req.body);
    app.reconciler.resolve((req.params as { id: string }).id, body.resolution, a.id);
    return { ok: true };
  });

  f.post("/api/reconcile", async (req) => {
    need(req, "manager");
    return { summary: await app.reconciler.run() };
  });

  f.post("/api/jobs/:id/retry", async (req) => {
    need(req, "manager");
    return { retried: app.queue.retryDead((req.params as { id: string }).id) };
  });
  f.get("/api/jobs", async (req) => ({ counts: app.queue.counts(), jobs: app.queue.list({ status: (req.query as { status?: string }).status, limit: 100 }).map((j) => ({ ...j, payload: undefined })) }));

  // ---- sales -----------------------------------------------------------------------------
  const saleBody = z.object({
    marketplace: marketplaceEnum,
    externalOrderId: z.string().min(1).max(120),
    sku: z.string().min(1).max(60),
    quantity: z.number().int().min(1).max(999).default(1),
    salePriceCents: cents,
    shippingChargedCents: cents.optional(),
    feesCents: cents.nullish(),
    shippingCostCents: cents.optional(),
    soldAt: z.string().max(40).optional(),
  });

  f.get("/api/sales", async () => ({ orders: app.sales.orders({ limit: 300 }) }));

  /** A sale reported by a signed-in operator (for marketplaces without an orders API). */
  f.post("/api/sales", async (req) => {
    const a = need(req, "manager");
    return app.sales.recordSale(saleBody.parse(req.body), "operator", a);
  });

  /** A sale reported by an external system. The HMAC-SHA256 signature of the raw body must match. */
  f.post("/api/webhooks/sale", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const secret = app.config.saleWebhookSecret;
    const signature = String(req.headers["x-signature"] ?? "");
    if (!secret || !req.rawBody || !safeEqual(hmacHex(secret, req.rawBody), signature)) {
      app.audit.record({ actor: { type: "system", id: "webhook" }, action: "webhook.rejected", outcome: "denied", detail: { reason: secret ? "bad signature" : "webhook secret not configured" } });
      throw new AppError("bad_signature", "Signature check failed.", 401);
    }
    const result = app.sales.recordSale(saleBody.parse(req.body), "signed_webhook");
    return { status: result.status };
  });

  /** Demo control: make the SIMULATED marketplace report a sale. Refused for real listings. */
  f.post("/api/simulate/sale", async (req) => {
    need(req, "manager");
    const body = z.object({ listingId: z.string() }).parse(req.body);
    const listing = app.listings.get(body.listingId);
    if (listing.simulated !== 1 || app.connections.get(listing.marketplace).mode !== "simulated" || !listing.external_id) throw new AppError("not_simulated", "Only listings on a simulated marketplace can have a simulated sale.", 400);
    const order = app.adapters.sim(listing.marketplace).simulateSale(listing.external_id);
    const poll = await app.sales.pollOrders(listing.marketplace);
    return { order, poll };
  });

  // ---- analytics -------------------------------------------------------------------------
  f.get("/api/analytics", async (req) => {
    const sim = (req.query as { simulated?: string }).simulated === "1";
    return {
      overview: app.analytics.overview(sim),
      marketplaces: app.analytics.byMarketplace(sim),
      categories: app.analytics.byCategory(sim),
      products: app.analytics.byProduct(100, sim),
      aging: app.analytics.aging(),
      velocity: app.analytics.velocity(30, sim),
      insights: app.analytics.insights(sim),
      metricSupport: app.optimizer.marketplaceMetricSupport(),
    };
  });
  f.get("/api/reports", async () => ({ reports: app.analytics.reports() }));
  f.post("/api/reports", async (req) => {
    need(req, "manager");
    const body = z.object({ days: z.number().int().min(1).max(366).default(7), includeSimulated: z.boolean().default(false) }).parse(req.body ?? {});
    return { report: app.analytics.generateReport(body.days, body.includeSimulated) };
  });

  f.get("/api/optimization", async () => ({ ...(await app.optimizer.run({ apply: false })), evaluations: app.optimizer.evaluations(50) }));
  f.post("/api/optimization/run", async (req) => {
    need(req, "manager");
    return app.optimizer.run({ apply: true });
  });

  // ---- activity --------------------------------------------------------------------------
  f.get("/api/audit", async (req) => {
    const q = z.object({ action: z.string().max(60).optional(), outcome: z.string().max(20).optional(), productId: z.string().optional(), before: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { entries: app.audit.list(q).map((r) => ({ ...r, detail: parseJson(r.detail, null) })) };
  });
  f.get("/api/notifications", async () => ({ notifications: app.notifications.list({ limit: 100 }), unread: app.notifications.unreadCount() }));
  f.post("/api/notifications/read", async (req) => {
    const body = z.object({ id: z.string().default("all") }).parse(req.body ?? {});
    app.notifications.markRead(body.id as "all");
    return { ok: true };
  });

  // ---- automation controls ---------------------------------------------------------------
  f.post("/api/automation/emergency-stop", async (req) => {
    const a = need(req, "manager"); // anyone who operates the system can stop it
    const body = z.object({ reason: z.string().max(300).default("") }).parse(req.body ?? {});
    app.settings.update({ automation: { emergencyStop: true, emergencyStopReason: body.reason } }, a.id ?? "user");
    app.audit.record({ actor: a, action: "automation.emergency_stop", detail: { reason: body.reason } });
    app.notifications.notify({ type: "agent_failure", severity: "critical", title: "Emergency stop engaged", body: `All automatic publishing, price changes and edits are blocked. ${body.reason}`.trim() });
    return { automation: app.settings.get().automation };
  });
  f.post("/api/automation/release", async (req) => {
    const a = need(req, "owner"); // only an owner can release it
    app.settings.update({ automation: { emergencyStop: false, emergencyStopReason: "" } }, a.id ?? "user");
    app.audit.record({ actor: a, action: "automation.emergency_stop_released" });
    return { automation: app.settings.get().automation };
  });
  f.post("/api/automation/pause", async (req) => {
    const a = need(req, "manager");
    const body = z.object({ paused: z.boolean() }).parse(req.body);
    app.settings.update({ automation: { paused: body.paused } }, a.id ?? "user");
    app.audit.record({ actor: a, action: body.paused ? "automation.paused" : "automation.resumed" });
    return { automation: app.settings.get().automation };
  });
  f.post("/api/automation/mode", async (req) => {
    const a = need(req, "owner");
    if (!canChangeAutomation(a)) throw new AppError("forbidden", "Only an owner can change the automation mode.", 403);
    const body = z.object({ mode: z.enum(["review_only", "semi_autonomous", "full_autonomous"]), acknowledge: z.boolean().default(false) }).parse(req.body);
    if (body.mode === "full_autonomous" && !body.acknowledge) throw new AppError("acknowledge_required", "Confirm that you have reviewed the price floors, thresholds and marketplace permissions before activating full autonomous mode.", 400);
    app.settings.update({ automation: { mode: body.mode, ...(body.mode === "full_autonomous" ? { fullAutonomyAcknowledgedAt: clock.iso() } : {}) } }, a.id ?? "user");
    app.audit.record({ actor: a, action: "automation.mode_changed", detail: { mode: body.mode } });
    return { automation: app.settings.get().automation };
  });

  // ---- settings, connections, users --------------------------------------------------------
  f.get("/api/settings", async () => ({ settings: app.settings.get(), specs: SPECS }));
  f.put("/api/settings", async (req) => {
    const a = need(req, "owner");
    const patch = (req.body ?? {}) as Record<string, unknown>;
    // Mode and the stop/pause switches have their own audited endpoints with their own checks.
    if (patch.automation && typeof patch.automation === "object") {
      for (const k of ["mode", "emergencyStop", "paused", "fullAutonomyAcknowledgedAt"]) delete (patch.automation as Record<string, unknown>)[k];
    }
    const before = app.settings.get();
    const next = app.settings.update(patch, a.id ?? "user");
    app.audit.record({ actor: a, action: "settings.updated", detail: { sections: Object.keys(patch), pricingBefore: before.pricing, pricingAfter: next.pricing } });
    return { settings: next };
  });

  f.get("/api/connections", async () => ({ connections: marketplaceStatus(app), publicBaseUrl: !!app.publicBaseUrl, ebayKeysConfigured: !!(app.config.ebay?.clientId && app.config.ebay?.clientSecret), anthropicKeyConfigured: !!app.config.anthropicApiKey }));

  f.put("/api/connections/:marketplace", async (req) => {
    const a = need(req, "owner");
    const marketplace = marketplaceEnum.parse((req.params as { marketplace: string }).marketplace);
    const body = z.object({ mode: z.enum(["api", "assisted", "simulated", "disabled"]).optional(), apiKey: z.string().max(400).optional(), account: z.record(z.string(), z.string().max(200)).optional() }).parse(req.body);
    if (body.mode === "api" && !app.adapters.hasApiAdapter(marketplace)) throw new AppError("no_api_adapter", `${SPECS[marketplace].name} cannot be connected by API: ${SPECS[marketplace].apiNotes}`, 400);
    if (body.mode) app.connections.setMode(marketplace, body.mode, marketplace === "ebay" ? app.config.ebay?.env : marketplace === "depop" ? app.config.depop?.env : undefined);
    if (body.apiKey !== undefined) {
      if (marketplace !== "depop") throw new AppError("not_supported", "Only Depop uses an API key here; eBay connects with its sign-in flow.", 400);
      app.connections.saveCredentials(marketplace, body.apiKey ? { apiKey: body.apiKey } : null);
    }
    if (body.account) app.connections.setAccount(marketplace, { ...app.connections.get(marketplace).account, ...body.account });
    // This is the audited account-credential change; the key itself is never logged.
    app.audit.record({ actor: a, action: "connection.updated", marketplace, detail: { mode: body.mode, credentialsChanged: body.apiKey !== undefined, accountFields: Object.keys(body.account ?? {}) } });
    return { connection: marketplaceStatus(app).find((c) => c.marketplace === marketplace) };
  });

  f.post("/api/connections/:marketplace/validate", async (req) => {
    need(req, "owner");
    const marketplace = marketplaceEnum.parse((req.params as { marketplace: string }).marketplace);
    const result = await app.adapters.get(marketplace).validateConnection();
    const conn = app.connections.get(marketplace);
    app.connections.setStatus(marketplace, result.ok ? (conn.mode === "api" ? "connected" : conn.mode) : "error", result.ok ? null : result.message, result.ok);
    return { result };
  });

  f.get("/api/connections/ebay/authorize", async (req) => {
    need(req, "owner");
    const state = randomToken(16);
    app.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('ebay_oauth_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(state, clock.iso());
    return { url: app.adapters.ebay().authorizeUrl(state) };
  });
  f.get("/api/connections/ebay/callback", async (req, reply) => {
    const q = z.object({ code: z.string().max(2000), state: z.string().max(200) }).parse(req.query);
    const row = app.db.prepare("SELECT value, updated_at FROM settings WHERE key = 'ebay_oauth_state'").get() as { value: string; updated_at: string } | undefined;
    const fresh = row && Date.now() - new Date(row.updated_at).getTime() < 15 * 60_000;
    if (!row || !fresh || !safeEqual(row.value, q.state)) throw new AppError("bad_state", "This eBay sign-in link has expired. Start again from Settings.", 400);
    app.db.prepare("DELETE FROM settings WHERE key = 'ebay_oauth_state'").run();
    await app.adapters.ebay().completeAuthorization(q.code);
    app.connections.setMode("ebay", "api", app.config.ebay?.env);
    app.audit.record({ actor: { type: "system", id: "oauth" }, action: "connection.updated", marketplace: "ebay", detail: { credentialsChanged: true, via: "oauth" } });
    return reply.redirect("/#/settings");
  });

  f.get("/api/users", async (req) => {
    need(req, "owner");
    return { users: app.auth.users() };
  });
  f.post("/api/users", async (req) => {
    const a = need(req, "owner");
    const body = z.object({ email: z.string().max(200), password: z.string().min(12).max(200), role: z.enum(["owner", "manager", "viewer"]) }).parse(req.body);
    const user = app.auth.createUser(body.email, body.password, body.role, a);
    return { user: { id: user.id, email: user.email, role: user.role } };
  });
  f.post("/api/users/:id/disabled", async (req) => {
    const a = need(req, "owner");
    const body = z.object({ disabled: z.boolean() }).parse(req.body);
    app.auth.setDisabled((req.params as { id: string }).id, body.disabled, a);
    return { ok: true };
  });

  // ---- dashboard (built single-page app) ---------------------------------------------------
  if (existsSync(WEB_DIST)) {
    await f.register(fastifyStatic, { root: WEB_DIST, wildcard: false });
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/public/")) return reply.status(404).send({ error: "not_found", message: "Not found" });
      return reply.sendFile("index.html");
    });
  } else {
    f.get("/", async (_req, reply) => reply.type("text/plain").send("The dashboard has not been built yet. Run: npm run web:build"));
  }

  return f;
}
