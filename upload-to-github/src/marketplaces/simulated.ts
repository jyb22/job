import type { DB } from "../db";
import type { MarketplaceId } from "../core/types";
import { clock, newId, RateLimitError } from "../core/util";
import { BaseAdapter, type AdapterCapabilities, type CreateResult, type ListingPayload, type RemoteListing, type RemoteMetrics, type RemoteOrder } from "./adapter";
import { mapCategory, normaliseDepartment, normaliseProductType, type CategoryMapping } from "./specs";

// SIMULATED marketplace. It behaves like a marketplace API — idempotent
// creates, publish, end, inventory, orders, metrics, rate limits, outages —
// but stores everything in the local `sim_marketplace_listings` table and
// never contacts a real marketplace. It exists so the full workflow can be
// demonstrated and tested without a seller account. Listings created through
// it are flagged `simulated` everywhere they appear.

type Op = "create" | "publish" | "end" | "update" | "retrieve" | "orders" | "inventory";

interface SimRow {
  marketplace: string;
  external_id: string;
  sku: string;
  idempotency_key: string;
  status: string;
  quantity: number;
  price_cents: number;
  payload: string;
  updated_at: string;
}

export class SimulatedAdapter extends BaseAdapter {
  readonly mode = "simulated" as const;
  override readonly simulated = true;
  readonly capabilities: AdapterCapabilities = {
    createListing: true, updateListing: true, endListing: true, deleteListing: true, retrieveListing: true,
    retrieveInventory: true, updateInventory: true, retrieveOrders: true, retrieveFees: false, retrieveAnalytics: true, categoryLookup: true,
  };
  /** Count of calls per operation, for tests. */
  calls: Record<string, number> = {};
  private failures: { op: Op; error: Error }[] = [];

  constructor(
    readonly marketplace: MarketplaceId,
    private db: DB,
  ) {
    super();
  }

  /** Test hook: make the next call to `op` fail with `error` (queued in order). */
  failNext(op: Op, error: Error = new Error(`Simulated ${op} outage`)): void {
    this.failures.push({ op, error });
  }
  rateLimitNext(op: Op, retryAfterSeconds = 1): void {
    this.failNext(op, new RateLimitError(`Simulated rate limit on ${this.marketplace}`, retryAfterSeconds));
  }

  private enter(op: Op): void {
    this.calls[op] = (this.calls[op] ?? 0) + 1;
    const i = this.failures.findIndex((f) => f.op === op);
    if (i >= 0) throw this.failures.splice(i, 1)[0]!.error;
  }

  private row(externalId: string): SimRow | undefined {
    return this.db.prepare("SELECT * FROM sim_marketplace_listings WHERE marketplace = ? AND external_id = ?").get(this.marketplace, externalId) as SimRow | undefined;
  }

  private url(externalId: string): string {
    return `simulated://${this.marketplace}/listing/${externalId}`;
  }

  async validateConnection() {
    return { ok: true, message: "Simulated marketplace — nothing is sent to a real account." };
  }

  override async getAccountInformation() {
    return { id: `sim-${this.marketplace}`, name: `Simulated ${this.marketplace} shop` };
  }

  override async getCategories(query: string): Promise<CategoryMapping[]> {
    const m = mapCategory(this.marketplace, normaliseProductType(query), normaliseDepartment(query));
    return [{ ...m, categoryId: m.categoryId ?? `sim-${normaliseProductType(query)}`, source: "live" }];
  }

  async createListing(payload: ListingPayload): Promise<CreateResult> {
    this.enter("create");
    // Idempotent: the same key always returns the same listing, even after a crash and retry.
    const existing = this.db
      .prepare("SELECT * FROM sim_marketplace_listings WHERE marketplace = ? AND idempotency_key = ?")
      .get(this.marketplace, payload.idempotencyKey) as SimRow | undefined;
    if (existing) return { externalId: existing.external_id, url: this.url(existing.external_id), state: existing.status === "active" ? "live" : "draft" };
    const externalId = newId("sim").replace("sim_", `${this.marketplace}-`);
    this.db
      .prepare("INSERT INTO sim_marketplace_listings (marketplace, external_id, sku, idempotency_key, status, quantity, price_cents, payload, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)")
      .run(this.marketplace, externalId, payload.sku, payload.idempotencyKey, payload.quantity, payload.priceCents, JSON.stringify({ title: payload.title, description: payload.description }), clock.iso());
    return { externalId, url: this.url(externalId), state: "draft" };
  }

  override async publishListing(externalId: string): Promise<CreateResult> {
    this.enter("publish");
    const row = this.row(externalId);
    if (!row) throw new Error(`Simulated listing ${externalId} not found`);
    if (row.status === "draft") this.db.prepare("UPDATE sim_marketplace_listings SET status = 'active', updated_at = ? WHERE marketplace = ? AND external_id = ?").run(clock.iso(), this.marketplace, externalId);
    return { externalId, url: this.url(externalId), state: "live" };
  }

  override async updateListing(externalId: string, payload: ListingPayload): Promise<void> {
    this.enter("update");
    this.db
      .prepare("UPDATE sim_marketplace_listings SET price_cents = ?, payload = ?, updated_at = ? WHERE marketplace = ? AND external_id = ?")
      .run(payload.priceCents, JSON.stringify({ title: payload.title, description: payload.description }), clock.iso(), this.marketplace, externalId);
  }

  override async retrieveListing(externalId: string): Promise<RemoteListing | null> {
    this.enter("retrieve");
    const row = this.row(externalId);
    if (!row) return null;
    return { externalId, url: this.url(externalId), status: row.status as RemoteListing["status"], quantity: row.quantity, priceCents: row.price_cents };
  }

  override async retrieveInventory(): Promise<RemoteListing[]> {
    const rows = this.db.prepare("SELECT * FROM sim_marketplace_listings WHERE marketplace = ?").all(this.marketplace) as SimRow[];
    return rows.map((r) => ({ externalId: r.external_id, url: this.url(r.external_id), status: r.status as RemoteListing["status"], quantity: r.quantity, priceCents: r.price_cents }));
  }

  override async updateInventory(externalId: string, _sku: string, quantity: number): Promise<void> {
    this.enter("inventory");
    this.db.prepare("UPDATE sim_marketplace_listings SET quantity = ?, updated_at = ? WHERE marketplace = ? AND external_id = ?").run(quantity, clock.iso(), this.marketplace, externalId);
  }

  async endListing(externalId: string): Promise<void> {
    this.enter("end");
    // Ending is idempotent: ending an already-ended listing succeeds.
    this.db.prepare("UPDATE sim_marketplace_listings SET status = 'ended', quantity = 0, updated_at = ? WHERE marketplace = ? AND external_id = ? AND status != 'sold'").run(clock.iso(), this.marketplace, externalId);
  }

  override async deleteListing(externalId: string): Promise<void> {
    this.db.prepare("DELETE FROM sim_marketplace_listings WHERE marketplace = ? AND external_id = ?").run(this.marketplace, externalId);
  }

  override async retrieveOrders(sinceIso: string): Promise<RemoteOrder[]> {
    this.enter("orders");
    const rows = this.db.prepare("SELECT * FROM sim_marketplace_listings WHERE marketplace = ? AND status = 'sold'").all(this.marketplace) as SimRow[];
    return rows
      .map((r) => JSON.parse(r.payload).order as RemoteOrder | undefined)
      .filter((o): o is RemoteOrder => !!o && o.soldAt >= sinceIso);
  }

  override async retrieveAnalytics(externalId: string): Promise<RemoteMetrics | null> {
    const row = this.row(externalId);
    if (!row) return null;
    const metrics = JSON.parse(row.payload).metrics as RemoteMetrics | undefined;
    return metrics ?? { impressions: 0, views: 0, watchers: 0, likes: 0, offers: 0 };
  }

  // ---- simulation controls (not part of the adapter interface) -------------------
  /** Pretend a buyer purchased this listing on the simulated marketplace. */
  simulateSale(externalId: string, opts: { quantity?: number; priceCents?: number } = {}): RemoteOrder {
    const row = this.row(externalId);
    if (!row) throw new Error(`Simulated listing ${externalId} not found`);
    const order: RemoteOrder = {
      externalOrderId: newId("simorder"),
      sku: row.sku,
      quantity: opts.quantity ?? 1,
      salePriceCents: opts.priceCents ?? row.price_cents,
      shippingChargedCents: 0,
      feesCents: null,
      soldAt: clock.iso(),
    };
    const payload = { ...JSON.parse(row.payload), order };
    this.db
      .prepare("UPDATE sim_marketplace_listings SET status = 'sold', quantity = MAX(0, quantity - ?), payload = ?, updated_at = ? WHERE marketplace = ? AND external_id = ?")
      .run(order.quantity, JSON.stringify(payload), clock.iso(), this.marketplace, externalId);
    return order;
  }

  setMetrics(externalId: string, metrics: RemoteMetrics): void {
    const row = this.row(externalId);
    if (!row) return;
    this.db.prepare("UPDATE sim_marketplace_listings SET payload = ? WHERE marketplace = ? AND external_id = ?").run(JSON.stringify({ ...JSON.parse(row.payload), metrics }), this.marketplace, externalId);
  }

  /** Change the remote copy behind the app's back, to exercise reconciliation. */
  tamper(externalId: string, change: { status?: string; quantity?: number; priceCents?: number }): void {
    const row = this.row(externalId);
    if (!row) return;
    this.db
      .prepare("UPDATE sim_marketplace_listings SET status = ?, quantity = ?, price_cents = ? WHERE marketplace = ? AND external_id = ?")
      .run(change.status ?? row.status, change.quantity ?? row.quantity, change.priceCents ?? row.price_cents, this.marketplace, externalId);
  }
}
