import type { Ctx } from "../context";
import { writeTx } from "../db";
import { AGENT, LIVE_LISTING_STATUSES, MARKETPLACES, parseJson, type Actor, type AttributeValue, type ListingRow, type ListingStatus, type MarketplaceId, type ProductRow, type ProductStatus } from "../core/types";
import { AppError, clock, newId, PermanentError, sha256Hex } from "../core/util";
import type { Identification, ListingFacts, ListingText } from "../ai/provider";
import type { ApprovalRow } from "../approvals/service";
import { DeferJob, type JobRow } from "../jobs/queue";
import { actionFingerprint, authorize, type ActionRequest, type ActionType, type Decision } from "../policy/engine";
import type { ListingPayload, MarketplaceAdapter } from "../marketplaces/adapter";
import { mapCategory, normaliseDepartment, normaliseProductType, SPECS, type CategoryMapping } from "../marketplaces/specs";
import { templateListing } from "./generator";
import { checkListingText } from "./guard";
import { scoreListing, validateListing, type ListingDraft, type Validation } from "./quality";

export interface TaskRow {
  id: string;
  kind: "post_listing" | "end_listing" | "update_listing";
  listing_id: string;
  product_id: string;
  marketplace: string;
  status: "open" | "done" | "cancelled";
  urgent: number;
  payload: string;
  dedupe_key: string;
  created_at: string;
  done_at: string | null;
  done_by: string | null;
}

export interface ActionResult {
  outcome: "executed" | "queued" | "needs_approval" | "deferred" | "denied";
  decision: Decision;
  approvalId?: string;
  jobId?: string;
}

const PUBLISHABLE: ListingStatus[] = ["draft", "needs_review", "ready_to_publish", "approved", "publication_failed"];

export class ListingService {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  // ---- reads --------------------------------------------------------------------
  get(id: string): ListingRow {
    const row = this.db.prepare("SELECT * FROM listings WHERE id = ?").get(id) as ListingRow | undefined;
    if (!row) throw new AppError("not_found", "Listing not found", 404);
    return row;
  }

  forProduct(productId: string): ListingRow[] {
    return this.db.prepare("SELECT * FROM listings WHERE product_id = ? ORDER BY created_at").all(productId) as ListingRow[];
  }

  list(filter: { status?: string; marketplace?: string; limit?: number } = {}): ListingRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) { where.push("status = ?"); args.push(filter.status); }
    if (filter.marketplace) { where.push("marketplace = ?"); args.push(filter.marketplace); }
    return this.db.prepare(`SELECT * FROM listings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`).all(...args, filter.limit ?? 300) as ListingRow[];
  }

  contentHash(l: Pick<ListingRow, "title" | "description" | "category_name">): string {
    return sha256Hex(`${l.title}\n${l.description}\n${l.category_name ?? ""}`).slice(0, 16);
  }

  /** The fingerprint an approval for this action would have if it were requested right now. */
  currentFingerprint(approval: Pick<ApprovalRow, "kind" | "listing_id" | "action">): string | null {
    if (!approval.listing_id) return null;
    const listing = this.get(approval.listing_id);
    const action = parseJson<Record<string, unknown>>(approval.action, {});
    if (approval.kind === "listing.update_content") {
      const next = { title: String(action.title ?? listing.title), description: String(action.description ?? listing.description), category_name: listing.category_name };
      return actionFingerprint("listing.update_content", listing.id, listing.price_cents, this.contentHash(next));
    }
    const price = approval.kind === "listing.reprice" ? Number(action.newPriceCents) : listing.price_cents;
    return actionFingerprint(approval.kind as ActionType, listing.id, price, this.contentHash(listing));
  }

  // ---- generation ---------------------------------------------------------------
  factsFor(product: ProductRow): ListingFacts {
    const ident = parseJson<Partial<Identification>>(product.identification, {});
    const attrs = parseJson<Record<string, AttributeValue>>(product.attributes, {});
    const measurements: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("measure_")) measurements[k.slice(8).replace(/_/g, " ")] = v.value;
    return {
      brand: product.brand,
      model: product.model,
      productType: product.category,
      department: product.department,
      size: product.size,
      color: product.color,
      material: product.material,
      condition: product.condition,
      conditionNotes: product.condition_notes,
      styleNumber: product.style_number,
      defects: ident.defects ?? [],
      accessories: ident.accessories ?? [],
      measurements,
      notes: product.notes,
    };
  }

  private async categoryFor(adapter: MarketplaceAdapter, product: ProductRow): Promise<CategoryMapping> {
    const type = normaliseProductType(product.category);
    const fallback = mapCategory(adapter.marketplace, type, normaliseDepartment(product.department));
    if (!adapter.capabilities.categoryLookup) return fallback;
    try {
      // Ask the marketplace's own taxonomy when it offers one.
      const query = [product.department === "menswear" ? "men's" : product.department === "womenswear" ? "women's" : "", product.brand, product.category].filter(Boolean).join(" ");
      const live = (await adapter.getCategories(query))[0];
      return live ?? fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Create or refresh one draft per enabled marketplace. Listings that are
   * already live are left alone. Text comes from the AI writer only if it
   * passes the claim guard; otherwise the deterministic template is used.
   */
  async generate(productId: string, actor: Actor, only?: MarketplaceId[]): Promise<ListingRow[]> {
    const product = this.ctx.products.get(productId);
    const settings = this.ctx.settings.get();
    const rec = this.ctx.research.latestRecommendation(product.id);
    if (!rec || rec.perMarketplace.length === 0) throw new AppError("no_price", "A price recommendation is needed before listings can be generated.", 409);
    const images = this.ctx.products.images(product.id);
    const facts = this.factsFor(product);

    const targets = MARKETPLACES.filter((m) => settings.marketplaces[m].enabled && this.ctx.connections.get(m).mode !== "disabled" && (!only || only.includes(m)));
    const existing = new Map(this.forProduct(product.id).filter((l) => !["delisted", "sold", "archived"].includes(l.status)).map((l) => [l.marketplace, l]));
    const todo = targets.filter((m) => !LIVE_LISTING_STATUSES.includes(existing.get(m)?.status as ListingStatus));

    // One AI call for all marketplaces; any failure falls back to templates.
    const aiText = new Map<MarketplaceId, ListingText>();
    const ai = this.ctx.ai();
    let aiNote: string | null = null;
    if (settings.ai.useAiWriter && ai.available() && !ai.simulated && todo.length) {
      try {
        const out = await ai.writeListings({ facts, targets: todo.map((m) => ({ marketplace: m, titleMax: SPECS[m].titleMax, descriptionMax: SPECS[m].descriptionMax, style: SPECS[m].tone })) });
        for (const t of out) aiText.set(t.marketplace, t);
      } catch (error) {
        aiNote = `AI writer unavailable (${(error as Error).message.slice(0, 120)}); template text used.`;
      }
    }

    const results: ListingRow[] = [];
    for (const marketplace of todo) {
      const price = rec.perMarketplace.find((p) => p.marketplace === marketplace);
      if (!price) continue;
      const shippingNote = settings.marketplaces[marketplace].shipping.payer === "seller" ? "Free shipping." : undefined;
      let text = templateListing(facts, marketplace, shippingNote);
      let writer = "template";
      let guardProblems: string[] = [];
      const candidate = aiText.get(marketplace);
      if (candidate) {
        const guard = checkListingText(candidate, facts);
        if (guard.ok) { text = candidate; writer = "ai"; }
        else guardProblems = guard.problems;
      }
      const conn = this.ctx.connections.get(marketplace);
      const adapter = this.ctx.adapters.get(marketplace);
      const category = await this.categoryFor(adapter, product);
      const draft: ListingDraft = { marketplace, title: text.title, description: text.description, priceCents: price.listPriceCents, category };
      const validation = validateListing(draft, product, images, settings);
      const quality = scoreListing({ draft, product, images, pricing: rec, validation });
      const status: ListingStatus = validation.ok ? "ready_to_publish" : "needs_review";
      const now = clock.iso();
      const attributes = JSON.stringify({ keywords: text.keywords, categorySource: category.source, aiRejected: guardProblems, aiNote });
      const prior = existing.get(marketplace);
      let id: string;
      if (prior) {
        id = prior.id;
        if (prior.price_cents !== price.listPriceCents || this.contentHash(prior) !== this.contentHash({ title: text.title, description: text.description, category_name: category.categoryName })) {
          this.ctx.approvals.invalidateForListing(prior.id, "The draft was regenerated with a different price or text.");
        }
        this.db
          .prepare(
            `UPDATE listings SET status = ?, title = ?, description = ?, category_id = ?, category_name = ?, attributes = ?, price_cents = ?, original_price_cents = ?, min_price_cents = ?,
               quality_score = ?, quality = ?, validation = ?, writer = ?, simulated = ?, integration_mode = ?, last_error = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(status, text.title, text.description, category.categoryId, category.categoryName, attributes, price.listPriceCents, price.listPriceCents, price.minAcceptableCents, quality.score, JSON.stringify(quality), JSON.stringify(validation), writer, adapter.simulated ? 1 : 0, conn.mode, now, id);
      } else {
        id = newId("lst");
        this.db
          .prepare(
            `INSERT INTO listings (id, product_id, marketplace, status, title, description, category_id, category_name, attributes, price_cents, original_price_cents, min_price_cents,
               quality_score, quality, validation, writer, idempotency_key, simulated, integration_mode, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, product.id, marketplace, status, text.title, text.description, category.categoryId, category.categoryName, attributes, price.listPriceCents, price.listPriceCents, price.minAcceptableCents, quality.score, JSON.stringify(quality), JSON.stringify(validation), writer, `${product.sku}:${marketplace}:${id}`, adapter.simulated ? 1 : 0, conn.mode, now, now);
      }
      this.ctx.audit.record({ actor, action: "listing.generated", entityType: "listing", entityId: id, productId: product.id, marketplace, detail: { writer, quality: quality.score, validationOk: validation.ok, errors: validation.errors, aiRejected: guardProblems, priceCents: price.listPriceCents, floorCents: price.minAcceptableCents } });
      results.push(this.get(id));
    }
    this.refreshProductStatus(product.id);
    return results;
  }

  // ---- policy plumbing -------------------------------------------------------------
  private request(type: ActionType, listing: ListingRow, actor: Actor, extra: Partial<ActionRequest> = {}): { req: ActionRequest; fingerprint: string; approval?: ApprovalRow } {
    const product = this.ctx.products.get(listing.product_id);
    const settings = this.ctx.settings.get();
    const rec = this.ctx.research.latestRecommendation(product.id);
    const ident = parseJson<Partial<Identification>>(product.identification, {});
    const sim = listing.integration_mode === "simulated";
    const riskFlags = [...parseJson<string[]>(product.risk_flags, [])];
    const price = extra.newPriceCents ?? listing.price_cents;
    if (price > settings.risk.authenticityReviewAboveCents) riskFlags.push("authenticity_review:high_value");
    // Demo identifications and demo comparables may only ever feed the simulated marketplace.
    if (ident.simulated && !sim) riskFlags.push("simulated_identification");
    const fingerprint = actionFingerprint(type, listing.id, price, this.contentHash(listing));
    const approval = this.ctx.approvals.findValid(fingerprint);
    const req: ActionRequest = {
      type,
      actor,
      marketplace: listing.marketplace,
      listing: {
        id: listing.id,
        priceCents: listing.price_cents,
        originalPriceCents: listing.original_price_cents,
        minPriceCents: listing.min_price_cents,
        qualityScore: listing.quality_score,
        validationOk: parseJson<Validation>(listing.validation, { ok: false, errors: [], warnings: [] }).ok,
        integrationMode: listing.integration_mode,
        lastRepricedAt: listing.last_repriced_at,
        contentHash: this.contentHash(listing),
      },
      product: {
        identificationConfidence: product.identification_confidence,
        riskFlags,
        criticalMissing: this.ctx.products.criticalMissing(product),
        costKnown: product.acquisition_cost_cents !== null,
      },
      pricing: rec ? { confidence: rec.confidence, basis: rec.basis, simulatedData: rec.simulatedData && !sim, soldCompsUsed: rec.soldCompsUsed } : null,
      humanApproved: !!approval,
      ...extra,
    };
    return { req, fingerprint, approval };
  }

  /** Decide, record the decision in the audit log, and return it. Every action goes through here. */
  private decide(type: ActionType, listing: ListingRow, actor: Actor, extra: Partial<ActionRequest> = {}) {
    const built = this.request(type, listing, actor, extra);
    const decision = authorize(built.req, this.ctx.settings.get(), clock.now());
    this.ctx.audit.record({
      actor,
      action: "authorization.check",
      outcome: decision.outcome === "allow" ? "ok" : decision.outcome === "deny" ? "denied" : "pending",
      entityType: "listing",
      entityId: listing.id,
      productId: listing.product_id,
      marketplace: listing.marketplace,
      detail: { action: type, outcome: decision.outcome, reasons: decision.reasons.map((r) => r.code), checked: decision.checked, humanApproved: built.req.humanApproved, newPriceCents: extra.newPriceCents },
    });
    return { ...built, decision };
  }

  private askApproval(kind: ActionType, listing: ListingRow, actor: Actor, decision: Decision, fingerprint: string, action: Record<string, unknown>): ApprovalRow {
    return this.ctx.approvals.request({ kind, productId: listing.product_id, listingId: listing.id, marketplace: listing.marketplace, action, fingerprint, reasons: decision.reasons, risk: decision.risk, requestedBy: actor });
  }

  // ---- publish ----------------------------------------------------------------------
  /** Ask to publish a listing. The policy engine decides whether it runs now, waits for a human, waits for later, or is refused. */
  requestPublish(listingId: string, actor: Actor): ActionResult {
    let listing = this.get(listingId);
    if (!PUBLISHABLE.includes(listing.status)) throw new AppError("bad_status", `A listing that is ${listing.status} cannot be published.`, 409);
    // The connection may have changed since the draft was generated.
    const conn = this.ctx.connections.get(listing.marketplace);
    if (conn.mode === "disabled") throw new AppError("marketplace_disabled", `${SPECS[listing.marketplace].name} is disabled.`, 409);
    if (conn.mode !== listing.integration_mode) {
      this.db.prepare("UPDATE listings SET integration_mode = ?, simulated = ? WHERE id = ?").run(conn.mode, conn.mode === "simulated" ? 1 : 0, listing.id);
      listing = this.get(listingId);
    }
    if (listing.status === "publication_failed") {
      // A fresh attempt after a failure gets a fresh job key; the marketplace-side idempotency key is unchanged.
      this.db.prepare("UPDATE listings SET version = version + 1 WHERE id = ?").run(listing.id);
      listing = this.get(listingId);
    }
    const { decision, fingerprint } = this.decide("listing.publish", listing, actor);
    switch (decision.outcome) {
      case "allow": {
        this.setStatus(listing, "approved");
        const jobId = this.ctx.queue.enqueue("listing.publish", { listingId: listing.id, actor }, { idempotencyKey: `publish:${listing.id}:v${listing.version}`, priority: 3 });
        this.refreshProductStatus(listing.product_id);
        return { outcome: "queued", decision, jobId };
      }
      case "needs_approval": {
        const approval = this.askApproval("listing.publish", listing, actor, decision, fingerprint, { priceCents: listing.price_cents, title: listing.title });
        this.setStatus(listing, "needs_review");
        this.refreshProductStatus(listing.product_id);
        return { outcome: "needs_approval", decision, approvalId: approval.id };
      }
      case "defer": {
        const jobId = this.ctx.queue.enqueue("listing.request_publish", { listingId: listing.id }, { idempotencyKey: `request-publish:${listing.id}:v${listing.version}`, delaySeconds: 300 });
        return { outcome: "deferred", decision, jobId };
      }
      default: {
        this.db.prepare("UPDATE listings SET last_error = ?, status = CASE WHEN status = 'approved' THEN 'needs_review' ELSE status END, updated_at = ? WHERE id = ?").run(decision.reasons.map((r) => r.message).join(" "), clock.iso(), listing.id);
        this.refreshProductStatus(listing.product_id);
        return { outcome: "denied", decision };
      }
    }
  }

  private setStatus(listing: ListingRow, status: ListingStatus, fields: Record<string, unknown> = {}): void {
    const sets = ["status = ?", "updated_at = ?", ...Object.keys(fields).map((k) => `${k} = ?`)];
    this.db.prepare(`UPDATE listings SET ${sets.join(", ")} WHERE id = ?`).run(status, clock.iso(), ...Object.values(fields), listing.id);
  }

  publicImageUrl(imageId: string): string | null {
    if (!this.ctx.publicBaseUrl) return null;
    return `${this.ctx.publicBaseUrl.replace(/\/$/, "")}/public/img/${imageId}.jpg?s=${this.ctx.box.sign(imageId)}`;
  }

  payloadFor(listing: ListingRow, product: ProductRow, overrides: { priceCents?: number } = {}): ListingPayload {
    const settings = this.ctx.settings.get();
    const spec = SPECS[listing.marketplace];
    const images = this.ctx.products.images(product.id).slice(0, spec.maxPhotos);
    const attrs = parseJson<Record<string, AttributeValue>>(product.attributes, {});
    const meta = parseJson<{ keywords?: string[]; categorySource?: "static" | "live" }>(listing.attributes, {});
    if (!product.condition) throw new PermanentError("Product has no condition set");
    return {
      sku: product.sku,
      idempotencyKey: listing.idempotency_key,
      title: listing.title,
      description: listing.description,
      priceCents: overrides.priceCents ?? listing.price_cents,
      quantity: product.quantity_available,
      currency: settings.location.currency,
      category: { categoryId: listing.category_id, categoryName: listing.category_name ?? "", source: meta.categorySource ?? "static" },
      condition: product.condition,
      conditionNotes: product.condition_notes,
      brand: product.brand,
      size: product.size,
      color: product.color,
      material: product.material,
      department: product.department,
      productType: normaliseProductType(product.category),
      keywords: meta.keywords ?? [],
      imagePaths: images.map((i) => i.optimized_path ?? i.original_path),
      imageUrls: images.map((i) => this.publicImageUrl(i.id)).filter((u): u is string => !!u),
      shipping: { payer: settings.marketplaces[listing.marketplace].shipping.payer, buyerChargeCents: settings.marketplaces[listing.marketplace].shipping.buyerChargeCents },
      location: { countryCode: settings.location.countryCode, state: settings.location.state },
      extra: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith(`${listing.marketplace}_`)).map(([k, v]) => [k, v.value])),
    };
  }

  /**
   * Job handler: put an approved listing on its marketplace.
   *
   * Safe to run more than once. Authorisation is re-checked at execution time
   * (an emergency stop pressed after approval still wins), the marketplace
   * create call is idempotent on the listing's key / SKU, and the external id
   * is saved as soon as it is known, so a crash at any point resumes without
   * creating a second listing.
   */
  async executePublish(listingId: string, actor: Actor, job?: JobRow): Promise<{ status: string }> {
    let listing = this.get(listingId);
    if (listing.status === "published" || listing.status === "awaiting_operator") return { status: listing.status };
    if (!["approved", "publishing"].includes(listing.status)) return { status: `skipped:${listing.status}` };
    const product = this.ctx.products.get(listing.product_id);

    const { decision, approval } = this.decide("listing.publish", listing, actor);
    if (decision.outcome === "defer") throw new DeferJob(decision.reasons[0]?.message ?? "Deferred", 300);
    if (decision.outcome !== "allow") {
      this.setStatus(listing, "needs_review", { last_error: decision.reasons.map((r) => r.message).join(" ") });
      this.refreshProductStatus(product.id);
      return { status: `blocked:${decision.outcome}` };
    }
    if (product.quantity_available < 1) {
      this.setStatus(listing, "archived", { last_error: "Nothing left to sell." });
      return { status: "skipped:no_stock" };
    }

    this.setStatus(listing, "publishing");
    this.ctx.products.setStage(product.id, "publication", "running", { marketplace: listing.marketplace });
    this.refreshProductStatus(product.id);
    const adapter = this.ctx.adapters.get(listing.marketplace);
    try {
      const payload = this.payloadFor(listing, product);
      const created = await adapter.createListing(payload);
      this.db.prepare("UPDATE listings SET external_id = ?, external_url = COALESCE(?, external_url), updated_at = ? WHERE id = ?").run(created.externalId, created.url, clock.iso(), listing.id);
      this.ctx.audit.record({ actor, action: "listing.created_on_marketplace", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { externalId: created.externalId, state: created.state, simulated: adapter.simulated, mode: adapter.mode } });

      if (created.state === "awaiting_operator") {
        this.setStatus(listing, "awaiting_operator");
        this.createTask("post_listing", this.get(listing.id), false, `post:${listing.id}:v${listing.version}`, { title: listing.title, description: listing.description, priceCents: listing.price_cents, category: listing.category_name, sku: product.sku });
        this.ctx.products.setStage(product.id, "publication", "blocked", { marketplace: listing.marketplace, waitingFor: "operator to post the listing" });
        this.ctx.notifications.notify({ type: "operator_task", title: `Ready to post on ${SPECS[listing.marketplace].name}: ${listing.title || product.sku}`, body: `${SPECS[listing.marketplace].name} has no listing API here. The listing is prepared — post it and record the link in the Review queue.`, productId: product.id });
      } else {
        const live = created.state === "live" ? created : await adapter.publishListing(created.externalId, payload);
        if (live.url) this.db.prepare("UPDATE listings SET external_url = ? WHERE id = ?").run(live.url, listing.id);
        // Verify against the marketplace rather than trusting the call's return value.
        let verified = "not_supported";
        if (adapter.capabilities.retrieveListing) {
          const remote = await adapter.retrieveListing(created.externalId, product.sku);
          if (!remote || remote.status !== "active") throw new Error(`Publication could not be verified on ${listing.marketplace} (remote status: ${remote?.status ?? "missing"})`);
          verified = "verified";
        }
        this.setStatus(listing, "published", { published_at: clock.iso(), last_synced_at: clock.iso(), last_error: null });
        this.ctx.products.setStage(product.id, "publication", "done", { marketplace: listing.marketplace });
        this.ctx.products.setStage(product.id, "publication_verification", verified === "verified" ? "done" : "skipped", { marketplace: listing.marketplace, verified });
        this.ctx.products.setStage(product.id, "inventory_sync", "done", { quantity: product.quantity_available });
        this.ctx.products.setStage(product.id, "monitoring", "running");
        this.ctx.audit.record({ actor, action: "listing.published", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { externalId: created.externalId, verified, simulated: adapter.simulated, priceCents: listing.price_cents } });
        this.ctx.notifications.notify({ type: "listing_published", title: `${adapter.simulated ? "[SIMULATED] " : ""}Listed on ${SPECS[listing.marketplace].name}: ${listing.title || product.sku}`, body: `Price $${(listing.price_cents / 100).toFixed(2)}. SKU ${product.sku}.`, productId: product.id });
      }
      if (approval) this.ctx.approvals.consume(approval.id);
      this.refreshProductStatus(product.id);
      return { status: this.get(listing.id).status };
    } catch (error) {
      const final = error instanceof PermanentError || (job !== undefined && job.attempts >= job.max_attempts);
      const message = (error as Error).message.slice(0, 500);
      listing = this.get(listing.id);
      if (final) {
        this.setStatus(listing, "publication_failed", { last_error: message });
        this.ctx.products.setStage(product.id, "publication", "failed", { marketplace: listing.marketplace, error: message });
        this.ctx.audit.record({ actor, action: "listing.publish_failed", outcome: "failed", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { error: message } });
        this.ctx.notifications.notify({ type: "listing_failed", severity: "warning", title: `Listing failed on ${SPECS[listing.marketplace].name}: ${listing.title || product.sku}`, body: message, productId: product.id });
        this.refreshProductStatus(product.id);
      } else {
        this.db.prepare("UPDATE listings SET last_error = ?, updated_at = ? WHERE id = ?").run(message, clock.iso(), listing.id);
      }
      throw error;
    }
  }

  // ---- operator tasks (assisted marketplaces) ----------------------------------------
  private createTask(kind: TaskRow["kind"], listing: ListingRow, urgent: boolean, dedupeKey: string, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO manual_tasks (id, kind, listing_id, product_id, marketplace, status, urgent, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING")
      .run(newId("tsk"), kind, listing.id, listing.product_id, listing.marketplace, urgent ? 1 : 0, JSON.stringify(payload), dedupeKey, clock.iso());
  }

  tasks(status: "open" | "done" | "cancelled" | "all" = "open"): TaskRow[] {
    return this.db.prepare(`SELECT * FROM manual_tasks ${status === "all" ? "" : "WHERE status = ?"} ORDER BY urgent DESC, created_at`).all(...(status === "all" ? [] : [status])) as TaskRow[];
  }

  /** The operator confirms they did the thing by hand (posted, ended or updated the listing). */
  completeTask(taskId: string, actor: Actor, info: { externalUrl?: string; externalId?: string } = {}): TaskRow {
    const task = this.db.prepare("SELECT * FROM manual_tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!task) throw new AppError("not_found", "Task not found", 404);
    if (task.status !== "open") throw new AppError("not_open", `Task is already ${task.status}.`, 409);
    const listing = this.get(task.listing_id);
    writeTx(this.db, () => {
      this.db.prepare("UPDATE manual_tasks SET status = 'done', done_at = ?, done_by = ? WHERE id = ?").run(clock.iso(), actor.id ?? null, taskId);
      if (task.kind === "post_listing") {
        if (!info.externalUrl && !info.externalId) throw new AppError("link_required", "Record the listing's link or ID so it can be tracked and ended later.", 400);
        if (info.externalUrl && !/^https:\/\//i.test(info.externalUrl)) throw new AppError("bad_link", "The listing link must start with https://", 400);
        this.setStatus(listing, "published", { published_at: clock.iso(), external_url: info.externalUrl ?? null, external_id: info.externalId ?? info.externalUrl ?? listing.external_id });
        this.ctx.products.setStage(listing.product_id, "publication", "done", { marketplace: listing.marketplace, by: "operator" });
        this.ctx.products.setStage(listing.product_id, "publication_verification", "done", { marketplace: listing.marketplace, verified: "operator_confirmed" });
        this.ctx.products.setStage(listing.product_id, "monitoring", "running");
        this.ctx.audit.record({ actor, action: "listing.published", entityType: "listing", entityId: listing.id, productId: listing.product_id, marketplace: listing.marketplace, detail: { by: "operator", externalUrl: info.externalUrl } });
      } else if (task.kind === "end_listing") {
        this.setStatus(listing, "delisted", { ended_at: clock.iso() });
        this.ctx.audit.record({ actor, action: "listing.ended", entityType: "listing", entityId: listing.id, productId: listing.product_id, marketplace: listing.marketplace, detail: { by: "operator", verified: "operator_confirmed" } });
      } else {
        this.ctx.audit.record({ actor, action: "listing.updated_on_marketplace", entityType: "listing", entityId: listing.id, productId: listing.product_id, marketplace: listing.marketplace, detail: { by: "operator" } });
      }
    });
    this.refreshProductStatus(listing.product_id);
    return this.db.prepare("SELECT * FROM manual_tasks WHERE id = ?").get(taskId) as TaskRow;
  }

  // ---- end / cross-delist --------------------------------------------------------------
  /** Ask to end a live listing. */
  requestEnd(listingId: string, actor: Actor, reason: "verified_sale" | "operator" | "optimization", ref?: string): ActionResult {
    const listing = this.get(listingId);
    if (!LIVE_LISTING_STATUSES.includes(listing.status)) throw new AppError("not_live", `Listing is ${listing.status}; there is nothing to end.`, 409);
    const { decision, fingerprint } = this.decide("listing.end", listing, actor, { endReason: reason });
    if (decision.outcome === "allow") {
      this.setStatus(listing, "delisting_pending");
      const jobId = this.ctx.queue.enqueue("listing.end", { listingId: listing.id, reason, ref, actor }, { idempotencyKey: `end:${listing.id}:${ref ?? reason}`, priority: 1, maxAttempts: 8 });
      this.refreshProductStatus(listing.product_id);
      return { outcome: "queued", decision, jobId };
    }
    if (decision.outcome === "needs_approval") {
      const approval = this.askApproval("listing.end", listing, actor, decision, fingerprint, { reason });
      if (reason === "verified_sale") {
        // The agent lacks permission to end this listing but the item is sold: a human must act quickly.
        this.ctx.notifications.notify({ type: "cross_delist_failed", severity: "critical", title: `Sold item still listed on ${SPECS[listing.marketplace].name}`, body: `The agent is not permitted to end listings on ${listing.marketplace}. Approve the request or end "${listing.title}" by hand to avoid a double sale.`, productId: listing.product_id });
      }
      return { outcome: "needs_approval", decision, approvalId: approval.id };
    }
    return { outcome: decision.outcome === "defer" ? "deferred" : "denied", decision };
  }

  /** Job handler: end the listing on its marketplace and verify it is gone. Idempotent. */
  async executeEnd(listingId: string, reason: "verified_sale" | "operator" | "optimization", actor: Actor, job?: JobRow): Promise<{ status: string }> {
    const listing = this.get(listingId);
    if (["delisted", "sold", "archived"].includes(listing.status)) return { status: listing.status };
    const product = this.ctx.products.get(listing.product_id);
    const adapter = this.ctx.adapters.get(listing.marketplace);

    // Never posted (no marketplace id, or an assisted listing the operator has not confirmed posting):
    // cancel the pending "post it" task; nothing is live.
    if (!listing.external_id || (adapter.mode === "assisted" && !listing.published_at)) {
      this.db.prepare("UPDATE manual_tasks SET status = 'cancelled', done_at = ? WHERE listing_id = ? AND kind = 'post_listing' AND status = 'open'").run(clock.iso(), listing.id);
      this.setStatus(listing, "delisted", { ended_at: clock.iso() });
      this.ctx.audit.record({ actor, action: "listing.ended", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { reason, note: "never posted; posting task cancelled" } });
      this.refreshProductStatus(product.id);
      return { status: "delisted" };
    }

    if (listing.status !== "delisting_pending") this.setStatus(listing, "delisting_pending");
    if (adapter.mode === "assisted") {
      this.createTask("end_listing", listing, reason === "verified_sale", `end:${listing.id}`, { title: listing.title, url: listing.external_url, reason, sku: product.sku });
      this.ctx.notifications.notify({
        type: "operator_task",
        severity: reason === "verified_sale" ? "critical" : "info",
        title: `${reason === "verified_sale" ? "SOLD ELSEWHERE — " : ""}End listing on ${SPECS[listing.marketplace].name}: ${listing.title}`,
        body: `${SPECS[listing.marketplace].name} has no API here, so this listing must be ended by hand${listing.external_url ? `: ${listing.external_url}` : ""}. Confirm in the Review queue when done.`,
        productId: product.id,
      });
      this.ctx.audit.record({ actor, action: "listing.end_task_created", outcome: "pending", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { reason } });
      this.refreshProductStatus(product.id);
      return { status: "delisting_pending" };
    }

    try {
      await adapter.endListing(listing.external_id, product.sku, reason === "verified_sale" ? "sold_elsewhere" : "operator");
      let verified = "not_supported";
      if (adapter.capabilities.retrieveListing) {
        const remote = await adapter.retrieveListing(listing.external_id, product.sku);
        if (remote && remote.status === "active") throw new Error(`${listing.marketplace} still shows the listing as active after ending it`);
        verified = "verified";
      }
      this.setStatus(listing, "delisted", { ended_at: clock.iso(), last_synced_at: clock.iso(), last_error: null });
      this.ctx.audit.record({ actor, action: "listing.ended", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { reason, verified, simulated: adapter.simulated } });
      if (reason === "verified_sale") {
        this.ctx.notifications.notify({ type: "cross_delist_ok", title: `${adapter.simulated ? "[SIMULATED] " : ""}Ended on ${SPECS[listing.marketplace].name} after sale: ${listing.title}`, body: `SKU ${product.sku} sold elsewhere; this listing was ended and the result was ${verified === "verified" ? "verified with the marketplace" : "accepted by the marketplace"}.`, productId: product.id });
      }
      this.refreshProductStatus(product.id);
      return { status: "delisted" };
    } catch (error) {
      const final = error instanceof PermanentError || (job !== undefined && job.attempts >= job.max_attempts);
      const message = (error as Error).message.slice(0, 500);
      this.db.prepare("UPDATE listings SET last_error = ?, updated_at = ? WHERE id = ?").run(message, clock.iso(), listing.id);
      if (final) {
        this.ctx.audit.record({ actor, action: "listing.end_failed", outcome: "failed", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { reason, error: message } });
        this.ctx.notifications.notify({ type: "cross_delist_failed", severity: "critical", title: `Could not end listing on ${SPECS[listing.marketplace].name}: ${listing.title}`, body: `${message}\n\nEnd it by hand now to avoid selling the same item twice.`, productId: product.id });
        this.ctx.reconciler.raise({ productId: product.id, listingId: listing.id, marketplace: listing.marketplace, kind: "cross_delist_failed", expected: "ended", actual: "still live" });
      }
      throw error;
    }
  }

  // ---- price changes ---------------------------------------------------------------------
  /** Change the price of a live listing, subject to floor, discount, change-size and frequency rules. */
  async reprice(listingId: string, newPriceCents: number, actor: Actor, reason: string): Promise<ActionResult> {
    const listing = this.get(listingId);
    if (!Number.isInteger(newPriceCents) || newPriceCents <= 0) throw new AppError("bad_price", "Price must be a positive amount.", 400);
    if (newPriceCents === listing.price_cents) throw new AppError("no_change", "That is already the price.", 409);
    if (!["published", "awaiting_operator"].includes(listing.status)) throw new AppError("not_live", "Only live listings are repriced; edit a draft instead.", 409);
    const { decision, fingerprint, approval } = this.decide("listing.reprice", listing, actor, { newPriceCents });
    if (decision.outcome === "needs_approval") {
      const row = this.askApproval("listing.reprice", listing, actor, decision, fingerprint, { newPriceCents, fromCents: listing.price_cents, reason });
      return { outcome: "needs_approval", decision, approvalId: row.id };
    }
    if (decision.outcome !== "allow") return { outcome: decision.outcome === "defer" ? "deferred" : "denied", decision };
    await this.applyPrice(listing, newPriceCents, actor, reason);
    if (approval) this.ctx.approvals.consume(approval.id);
    return { outcome: "executed", decision };
  }

  private async applyPrice(listing: ListingRow, newPriceCents: number, actor: Actor, reason: string): Promise<void> {
    const product = this.ctx.products.get(listing.product_id);
    const adapter = this.ctx.adapters.get(listing.marketplace);
    if (listing.status === "published" && listing.external_id) {
      if (adapter.mode === "assisted") {
        this.createTask("update_listing", listing, false, `price:${listing.id}:${newPriceCents}`, { title: listing.title, url: listing.external_url, change: `Change price to $${(newPriceCents / 100).toFixed(2)}`, sku: product.sku });
      } else {
        await adapter.updateListing(listing.external_id, this.payloadFor(listing, product, { priceCents: newPriceCents }));
      }
    }
    writeTx(this.db, () => {
      this.db
        .prepare("INSERT INTO listing_revisions (id, listing_id, at, actor, field, before, after, reason, metrics_before) VALUES (?, ?, ?, ?, 'price_cents', ?, ?, ?, ?)")
        .run(newId("rev"), listing.id, clock.iso(), `${actor.type}:${actor.id ?? ""}`, String(listing.price_cents), String(newPriceCents), reason, JSON.stringify(this.latestMetrics(listing.id)));
      this.db.prepare("UPDATE listings SET price_cents = ?, last_repriced_at = ?, version = version + 1, updated_at = ? WHERE id = ?").run(newPriceCents, clock.iso(), clock.iso(), listing.id);
    });
    this.ctx.audit.record({ actor, action: "listing.repriced", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { from: listing.price_cents, to: newPriceCents, reason, floor: listing.min_price_cents, simulated: adapter.simulated } });
  }

  // ---- content edits ------------------------------------------------------------------------
  /** Edit a listing's text or draft price. Drafts are simply re-validated; live listings go through the policy engine. */
  async edit(listingId: string, patch: { title?: string; description?: string; priceCents?: number }, actor: Actor, reason = "edit"): Promise<ActionResult | { outcome: "saved" }> {
    const listing = this.get(listingId);
    const product = this.ctx.products.get(listing.product_id);
    const next = { ...listing, title: patch.title?.trim() ?? listing.title, description: patch.description?.trim() ?? listing.description };
    const live = listing.status === "published";
    if (patch.priceCents !== undefined && live) throw new AppError("use_reprice", "Use reprice to change the price of a live listing.", 409);
    const price = patch.priceCents ?? listing.price_cents;
    const images = this.ctx.products.images(product.id);
    const meta = parseJson<{ categorySource?: "static" | "live" }>(listing.attributes, {});
    const draft: ListingDraft = { marketplace: listing.marketplace, title: next.title, description: next.description, priceCents: price, category: { categoryId: listing.category_id, categoryName: listing.category_name ?? "", source: meta.categorySource ?? "static" } };
    const validation = validateListing(draft, product, images, this.ctx.settings.get());
    const quality = scoreListing({ draft, product, images, pricing: this.ctx.research.latestRecommendation(product.id), validation });

    const save = (status: ListingStatus) => {
      writeTx(this.db, () => {
        const metrics = JSON.stringify(this.latestMetrics(listing.id));
        for (const field of ["title", "description"] as const) {
          if (next[field] !== listing[field]) {
            this.db.prepare("INSERT INTO listing_revisions (id, listing_id, at, actor, field, before, after, reason, metrics_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(newId("rev"), listing.id, clock.iso(), `${actor.type}:${actor.id ?? ""}`, field, listing[field], next[field], reason, metrics);
          }
        }
        this.db
          .prepare("UPDATE listings SET title = ?, description = ?, price_cents = ?, original_price_cents = CASE WHEN ? THEN original_price_cents ELSE ? END, quality_score = ?, quality = ?, validation = ?, writer = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(next.title, next.description, price, live ? 1 : 0, price, quality.score, JSON.stringify(quality), JSON.stringify(validation), actor.type === "user" ? "operator" : listing.writer, status, clock.iso(), listing.id);
      });
      this.ctx.audit.record({ actor, action: "listing.edited", entityType: "listing", entityId: listing.id, productId: product.id, marketplace: listing.marketplace, detail: { fields: Object.keys(patch), validationOk: validation.ok, quality: quality.score, reason } });
    };

    if (!live) {
      if (!PUBLISHABLE.includes(listing.status)) throw new AppError("bad_status", `A listing that is ${listing.status} cannot be edited.`, 409);
      save(validation.ok ? "ready_to_publish" : "needs_review");
      this.ctx.approvals.invalidateForListing(listing.id, "The listing was edited.");
      this.refreshProductStatus(product.id);
      return { outcome: "saved" };
    }

    const pending = { ...listing, ...next };
    const { decision, fingerprint } = this.decide("listing.update_content", { ...pending, validation: JSON.stringify(validation) }, actor);
    if (decision.outcome === "needs_approval") {
      const row = this.askApproval("listing.update_content", pending, actor, decision, fingerprint, { title: next.title, description: next.description, reason });
      return { outcome: "needs_approval", decision, approvalId: row.id };
    }
    if (decision.outcome !== "allow") return { outcome: decision.outcome === "defer" ? "deferred" : "denied", decision };
    const adapter = this.ctx.adapters.get(listing.marketplace);
    if (adapter.mode === "assisted") this.createTask("update_listing", listing, false, `content:${listing.id}:v${listing.version + 1}`, { title: next.title, description: next.description, url: listing.external_url, change: "Update title/description", sku: product.sku });
    else if (listing.external_id) await adapter.updateListing(listing.external_id, this.payloadFor({ ...listing, ...next }, product));
    save("published");
    return { outcome: "executed", decision };
  }

  // ---- approvals callbacks ----------------------------------------------------------------
  /** Carry out an action a human has just approved. */
  async onApproved(approval: ApprovalRow, actor: Actor): Promise<void> {
    if (!approval.listing_id) return;
    const listing = this.get(approval.listing_id);
    const action = parseJson<Record<string, unknown>>(approval.action, {});
    switch (approval.kind) {
      case "listing.publish": {
        if (!PUBLISHABLE.includes(listing.status)) return;
        // The approval covers the exceptions; hard rules (validation, emergency stop) are still enforced.
        const result = this.requestPublish(listing.id, actor);
        if (result.outcome === "denied") throw new AppError("still_blocked", result.decision.reasons.map((r) => r.message).join(" "), 409);
        break;
      }
      case "listing.reprice":
        await this.reprice(listing.id, Number(action.newPriceCents), actor, String(action.reason ?? "approved price change"));
        break;
      case "listing.end":
        this.requestEnd(listing.id, actor, (action.reason as "operator") ?? "operator", `approval:${approval.id}`);
        this.ctx.approvals.consume(approval.id);
        break;
      case "listing.update_content":
        await this.edit(listing.id, { title: action.title as string, description: action.description as string }, actor, String(action.reason ?? "approved edit"));
        this.ctx.approvals.consume(approval.id);
        break;
    }
  }

  onRejected(approval: ApprovalRow, _actor: Actor): void {
    if (approval.kind === "listing.publish" && approval.listing_id) {
      const listing = this.get(approval.listing_id);
      if (listing.status === "needs_review") this.db.prepare("UPDATE listings SET last_error = 'Publication was rejected by a reviewer.', updated_at = ? WHERE id = ?").run(clock.iso(), listing.id);
    }
  }

  // ---- inventory push ------------------------------------------------------------------------
  /** Push the product's available quantity to every live listing (multi-quantity items). */
  async syncQuantity(productId: string, actor: Actor = AGENT): Promise<void> {
    const product = this.ctx.products.get(productId);
    for (const listing of this.forProduct(productId).filter((l) => l.status === "published" && l.external_id)) {
      const adapter = this.ctx.adapters.get(listing.marketplace);
      const { decision } = this.decide("inventory.update", listing, actor);
      if (decision.outcome !== "allow") continue;
      if (adapter.capabilities.updateInventory) {
        await adapter.updateInventory(listing.external_id!, product.sku, product.quantity_available);
        this.db.prepare("UPDATE listings SET last_synced_at = ? WHERE id = ?").run(clock.iso(), listing.id);
      } else {
        this.createTask("update_listing", listing, false, `qty:${listing.id}:${product.quantity_available}`, { title: listing.title, url: listing.external_url, change: `Set quantity to ${product.quantity_available}`, sku: product.sku });
      }
      this.ctx.audit.record({ actor, action: "inventory.synced", entityType: "listing", entityId: listing.id, productId, marketplace: listing.marketplace, detail: { quantity: product.quantity_available, via: adapter.capabilities.updateInventory ? "api" : "operator_task" } });
    }
  }

  // ---- metrics ----------------------------------------------------------------------------------
  latestMetrics(listingId: string): Record<string, number | null> | null {
    const row = this.db.prepare("SELECT impressions, views, watchers, likes, offers, captured_at FROM listing_metrics WHERE listing_id = ? ORDER BY captured_at DESC LIMIT 1").get(listingId) as Record<string, number | null> | undefined;
    return row ?? null;
  }

  revisions(listingId: string) {
    return this.db.prepare("SELECT * FROM listing_revisions WHERE listing_id = ? ORDER BY at DESC").all(listingId);
  }

  // ---- derived product status -------------------------------------------------------------------
  /** Product status is derived from its listings and stock so it can never drift from them. */
  refreshProductStatus(productId: string): ProductStatus {
    const product = this.ctx.products.get(productId);
    if (product.status === "archived") return "archived";
    const listings = this.forProduct(productId);
    const has = (...s: ListingStatus[]) => listings.some((l) => s.includes(l.status));
    let status: ProductStatus = product.status;
    if (product.quantity_available === 0 && product.quantity_sold > 0) {
      status = has("delisting_pending", "published", "publishing", "awaiting_operator") ? "delisting_pending" : "sold";
    } else if (has("published")) status = "published";
    else if (has("publishing", "awaiting_operator")) status = "publishing";
    else if (has("approved")) status = "approved";
    else if (has("publication_failed")) status = "publication_failed";
    else if (has("needs_review")) status = "needs_review";
    else if (has("ready_to_publish", "draft")) status = "ready_to_publish";
    else if (listings.length > 0 && listings.every((l) => l.status === "delisted")) status = "delisted";
    if (status !== product.status) this.ctx.products.setStatus(productId, status);
    return status;
  }
}
