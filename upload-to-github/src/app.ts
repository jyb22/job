import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Ctx } from "./context";
import { migrate, openDatabase } from "./db";
import { AGENT, MARKETPLACES, type Actor, type MarketplaceId } from "./core/types";
import { AuditLog } from "./core/audit";
import { SecretBox } from "./security/crypto";
import { SettingsStore } from "./settings/store";
import { NotificationService, type SmtpConfig } from "./notifications/service";
import { DeferJob, JobQueue, type JobRow } from "./jobs/queue";
import { ConnectionStore } from "./marketplaces/connections";
import { AdapterRegistry } from "./marketplaces/registry";
import { SPECS } from "./marketplaces/specs";
import type { AiProvider } from "./ai/provider";
import { AnthropicProvider } from "./ai/anthropic";
import { NoAiProvider, SimulatedAiProvider } from "./ai/simulated";
import { ProductService } from "./inventory/products";
import { ResearchService } from "./research/service";
import { ListingService } from "./listings/service";
import { ApprovalService } from "./approvals/service";
import { SalesService } from "./inventory/sales";
import { Reconciler } from "./inventory/reconcile";
import { Pipeline } from "./workflow/pipeline";
import { Optimizer } from "./optimize/engine";
import { AnalyticsService } from "./analytics/service";
import { AuthService } from "./auth/service";

export interface AppConfig {
  dataDir: string;
  /** ":memory:" for tests. Defaults to <dataDir>/resale-ops.db */
  dbFile?: string;
  /** Base64 32-byte key. Tests may omit it to get a random one. */
  encryptionKey?: string;
  publicBaseUrl?: string | null;
  anthropicApiKey?: string;
  ebay?: { env?: "sandbox" | "production"; clientId?: string; clientSecret?: string; ruName?: string };
  depop?: { env?: "staging" | "production"; apiKey?: string };
  smtp?: SmtpConfig;
  saleWebhookSecret?: string;
}

export interface App extends Ctx {
  config: AppConfig;
  simulatedAi: SimulatedAiProvider;
  /** Start the background worker and the recurring schedule. */
  start(): void;
  stop(): Promise<void>;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    encryptionKey: env.APP_ENCRYPTION_KEY || undefined,
    publicBaseUrl: env.PUBLIC_BASE_URL || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    ebay: { env: env.EBAY_ENV === "production" ? "production" : "sandbox", clientId: env.EBAY_CLIENT_ID || undefined, clientSecret: env.EBAY_CLIENT_SECRET || undefined, ruName: env.EBAY_RU_NAME || undefined },
    depop: { env: env.DEPOP_ENV === "production" ? "production" : "staging", apiKey: env.DEPOP_API_KEY || undefined },
    smtp: { host: env.SMTP_HOST || undefined, port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined, user: env.SMTP_USER || undefined, password: env.SMTP_PASSWORD || undefined, from: env.SMTP_FROM || undefined },
    saleWebhookSecret: env.SALE_WEBHOOK_SECRET || undefined,
  };
}

export function createApp(config: AppConfig): App {
  const db = openDatabase(config.dbFile ?? path.join(config.dataDir, "resale-ops.db"));
  migrate(db);
  const box = new SecretBox(config.encryptionKey ?? randomBytes(32).toString("base64"));
  const settings = new SettingsStore(db);
  const audit = new AuditLog(db);
  const connections = new ConnectionStore(db, box);
  const ebayCfg = { env: config.ebay?.env ?? "sandbox", clientId: config.ebay?.clientId, clientSecret: config.ebay?.clientSecret, ruName: config.ebay?.ruName } as const;
  const depopCfg = { env: config.depop?.env ?? "staging", apiKey: config.depop?.apiKey } as const;

  const anthropic = new AnthropicProvider(() => settings.get().ai, config.anthropicApiKey);
  const simulatedAi = new SimulatedAiProvider();
  const noAi = new NoAiProvider();
  const ai = (): AiProvider => {
    const provider = settings.get().ai.provider;
    if (provider === "simulated") return simulatedAi;
    if (provider === "anthropic" && anthropic.available()) return anthropic;
    return noAi;
  };

  const ctx = { db, dataDir: config.dataDir, publicBaseUrl: config.publicBaseUrl ?? null, box, settings, audit, connections, ai } as Ctx;
  ctx.notifications = new NotificationService(db, () => settings.get(), config.smtp ?? {}, config.saleWebhookSecret);
  ctx.queue = new JobQueue(db);
  ctx.adapters = new AdapterRegistry(db, connections, { ebay: ebayCfg, depop: depopCfg });
  ctx.products = new ProductService(ctx);
  ctx.research = new ResearchService(ctx, ebayCfg);
  ctx.listings = new ListingService(ctx);
  ctx.approvals = new ApprovalService(ctx);
  ctx.sales = new SalesService(ctx);
  ctx.reconciler = new Reconciler(ctx);
  ctx.pipeline = new Pipeline(ctx);
  ctx.optimizer = new Optimizer(ctx);
  ctx.analytics = new AnalyticsService(ctx);
  ctx.auth = new AuthService(ctx);

  registerJobs(ctx);

  let schedule: NodeJS.Timeout | null = null;
  const app: App = Object.assign(ctx, {
    config,
    simulatedAi,
    start() {
      ctx.queue.start();
      scheduleRecurring(ctx);
      schedule = setInterval(() => scheduleRecurring(ctx), 60_000);
      schedule.unref();
    },
    async stop() {
      if (schedule) clearInterval(schedule);
      ctx.queue.stop();
      await ctx.notifications.flush();
      db.close();
    },
  });
  return app;
}

function registerJobs(ctx: Ctx): void {
  const q = ctx.queue;
  const actorOf = (payload: { actor?: Actor }): Actor => payload.actor ?? AGENT;

  q.register("product.process", (p: { productId: string }) => ctx.pipeline.process(p.productId));
  q.register("listing.request_publish", async (p: { listingId: string }) => {
    const listing = ctx.listings.get(p.listingId);
    if (!["draft", "needs_review", "ready_to_publish"].includes(listing.status)) return `skipped:${listing.status}`;
    const result = ctx.listings.requestPublish(p.listingId, AGENT);
    // Still paused: keep this job on the queue rather than letting the request evaporate.
    if (result.outcome === "deferred") throw new DeferJob(result.decision.reasons[0]?.message ?? "Deferred", 300);
    return result.outcome;
  });
  q.register("listing.publish", (p: { listingId: string; actor?: Actor }, job) => ctx.listings.executePublish(p.listingId, actorOf(p), job));
  q.register("listing.end", (p: { listingId: string; reason: "verified_sale" | "operator" | "optimization"; actor?: Actor }, job) => ctx.listings.executeEnd(p.listingId, p.reason, actorOf(p), job));
  q.register("inventory.sync", (p: { productId: string }) => ctx.listings.syncQuantity(p.productId));
  q.register("orders.poll", (p: { marketplace: MarketplaceId }) => ctx.sales.pollOrders(p.marketplace));
  q.register("reconcile.run", () => ctx.reconciler.run());
  q.register("optimize.run", () => ctx.optimizer.run({ apply: true }));
  q.register("report.generate", async (p: { days?: number }) => ({ id: ctx.analytics.generateReport(p.days ?? ctx.settings.get().schedules.reportDays).id }));
  q.register("maintenance.run", async () => ({ approvalsExpired: ctx.approvals.expire(), reservationsReleased: ctx.sales.expireReservations(), jobsRecovered: ctx.queue.recoverStale() }));

  q.onDead = (job: JobRow, error: string) => {
    ctx.audit.record({ actor: { type: "system", id: "queue" }, action: "job.dead", outcome: "failed", entityType: "job", entityId: job.id, detail: { type: job.type, attempts: job.attempts, error } });
    // Publish and end failures raise their own, more specific alerts.
    if (job.type !== "listing.publish" && job.type !== "listing.end") {
      ctx.notifications.notify({ type: "agent_failure", severity: "warning", title: `Background job failed: ${job.type}`, body: `After ${job.attempts} attempt(s): ${error}. It is in the dead-letter list (Activity → Jobs) and can be retried.` });
    }
  };
  q.onRateLimited = (job, error) => {
    ctx.audit.record({ actor: { type: "system", id: "queue" }, action: "job.rate_limited", outcome: "pending", entityType: "job", entityId: job.id, detail: { type: job.type, retryAfterSeconds: error.retryAfterSeconds } });
    ctx.notifications.notify({ type: "rate_limited", title: "Marketplace rate limit reached", body: `${error.message}. "${job.type}" will retry in ${error.retryAfterSeconds}s.` });
  };
}

/**
 * Enqueue the recurring jobs. Each uses an idempotency key derived from its
 * time slot, so calling this every minute (or from several processes) still
 * produces exactly one job per slot.
 */
export function scheduleRecurring(ctx: Ctx, now: Date = new Date()): void {
  const s = ctx.settings.get().schedules;
  const slot = (minutes: number) => Math.floor(now.getTime() / (minutes * 60_000));
  for (const m of MARKETPLACES) {
    const mode = ctx.connections.get(m).mode;
    if (mode === "api" || mode === "simulated") {
      ctx.queue.enqueue("orders.poll", { marketplace: m }, { idempotencyKey: `orders.poll:${m}:${slot(s.ordersPollMinutes)}`, priority: 2, maxAttempts: 3 });
    }
  }
  ctx.queue.enqueue("reconcile.run", {}, { idempotencyKey: `reconcile:${slot(s.reconcileMinutes)}`, priority: 6, maxAttempts: 3 });
  ctx.queue.enqueue("optimize.run", {}, { idempotencyKey: `optimize:${slot(s.optimizeHours * 60)}`, priority: 8, maxAttempts: 3 });
  ctx.queue.enqueue("report.generate", {}, { idempotencyKey: `report:${slot(s.reportDays * 24 * 60)}`, priority: 9, maxAttempts: 3 });
  ctx.queue.enqueue("maintenance.run", {}, { idempotencyKey: `maintenance:${slot(15)}`, priority: 7, maxAttempts: 2 });
}

/** One-line description of what each marketplace can and cannot do in its current mode, for the UI and docs. */
export function marketplaceStatus(ctx: Ctx) {
  return MARKETPLACES.map((m) => {
    const conn = ctx.connections.get(m);
    const adapter = conn.mode === "disabled" ? null : ctx.adapters.get(m);
    return {
      marketplace: m,
      name: SPECS[m].name,
      officialApi: SPECS[m].integration === "official_api",
      apiAdapterImplemented: ctx.adapters.hasApiAdapter(m),
      mode: conn.mode,
      environment: conn.environment,
      status: conn.status,
      simulated: adapter?.simulated ?? false,
      capabilities: adapter?.capabilities ?? null,
      hasCredentials: conn.hasCredentials,
      lastValidatedAt: conn.lastValidatedAt,
      lastError: conn.lastError,
      account: conn.account,
      notes: SPECS[m].apiNotes,
    };
  });
}
