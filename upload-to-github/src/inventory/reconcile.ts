import type { Ctx } from "../context";
import { AGENT, type ListingRow, type ProductRow } from "../core/types";
import { clock, DAY, newId } from "../core/util";
import { SPECS } from "../marketplaces/specs";

export interface DiscrepancyRow {
  id: string;
  product_id: string | null;
  listing_id: string | null;
  marketplace: string | null;
  kind: string;
  expected: string | null;
  actual: string | null;
  dedupe_key: string;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

export interface ReconcileSummary {
  checked: number;
  /** Listings on marketplaces that cannot be read back automatically (assisted mode). */
  unverifiable: number;
  found: number;
  autoResolved: number;
  errors: { marketplace: string; message: string }[];
}

/**
 * Periodically compares what the app believes with what each marketplace
 * reports, and records every difference. It does not promise real-time
 * consistency — marketplaces report changes with delay — it promises that a
 * difference will be noticed, recorded, surfaced, and (where safe) corrected.
 */
export class Reconciler {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  raise(d: { productId?: string | null; listingId?: string | null; marketplace?: string | null; kind: string; expected: string; actual: string; key?: string }): boolean {
    const key = d.key ?? `${d.kind}:${d.listingId ?? d.productId ?? d.marketplace ?? "global"}`;
    const res = this.db
      .prepare("INSERT INTO discrepancies (id, product_id, listing_id, marketplace, kind, expected, actual, dedupe_key, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(newId("dsc"), d.productId ?? null, d.listingId ?? null, d.marketplace ?? null, d.kind, d.expected, d.actual, key, clock.iso());
    if (res.changes > 0) {
      this.ctx.audit.record({ actor: { type: "system", id: "reconciler" }, action: "discrepancy.detected", outcome: "failed", entityType: "listing", entityId: d.listingId ?? undefined, productId: d.productId, marketplace: d.marketplace, detail: { kind: d.kind, expected: d.expected, actual: d.actual } });
    }
    return res.changes > 0;
  }

  resolve(id: string, resolution: string, actorId = "system"): void {
    const res = this.db.prepare("UPDATE discrepancies SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL").run(clock.iso(), resolution.slice(0, 300), id);
    if (res.changes) this.ctx.audit.record({ actor: { type: actorId === "system" ? "system" : "user", id: actorId }, action: "discrepancy.resolved", entityType: "discrepancy", entityId: id, detail: { resolution } });
  }

  list(open = true): DiscrepancyRow[] {
    return this.db.prepare(`SELECT * FROM discrepancies ${open ? "WHERE resolved_at IS NULL" : ""} ORDER BY detected_at DESC LIMIT 500`).all() as DiscrepancyRow[];
  }

  async run(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { checked: 0, unverifiable: 0, found: 0, autoResolved: 0, errors: [] };
    const stillTrue = new Set<string>();
    const flag = (d: Parameters<Reconciler["raise"]>[0]) => {
      const key = d.key ?? `${d.kind}:${d.listingId ?? d.productId ?? d.marketplace ?? "global"}`;
      stillTrue.add(key);
      if (this.raise({ ...d, key })) {
        summary.found++;
        const listing = d.listingId ? (this.db.prepare("SELECT title FROM listings WHERE id = ?").get(d.listingId) as { title: string } | undefined) : undefined;
        this.ctx.notifications.notify({ type: "inventory_discrepancy", severity: "warning", title: `Inventory discrepancy${d.marketplace ? ` on ${SPECS[d.marketplace as keyof typeof SPECS]?.name ?? d.marketplace}` : ""}: ${d.kind.replace(/_/g, " ")}`, body: `${listing?.title ? `"${listing.title}" — ` : ""}expected ${d.expected}, found ${d.actual}.`, productId: d.productId });
      }
    };

    // 1. Internal consistency: a sold-out product must not have a live listing with no end in progress.
    const stranded = this.db
      .prepare("SELECT l.* FROM listings l JOIN products p ON p.id = l.product_id WHERE p.quantity_available = 0 AND p.quantity_sold > 0 AND l.status IN ('published','publishing','awaiting_operator')")
      .all() as ListingRow[];
    for (const l of stranded) {
      flag({ productId: l.product_id, listingId: l.id, marketplace: l.marketplace, kind: "live_listing_for_sold_item", expected: "ended", actual: l.status });
      this.ctx.listings.requestEnd(l.id, AGENT, "verified_sale", "reconcile"); // protective: start ending it now
    }

    // 2. Compare with each marketplace that can be read back.
    const recentCutoff = new Date(clock.now().getTime() - 7 * DAY).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM listings WHERE external_id IS NOT NULL AND (status IN ('published','delisting_pending') OR (status = 'delisted' AND ended_at >= ?))")
      .all(recentCutoff) as ListingRow[];
    for (const l of rows) {
      const conn = this.ctx.connections.get(l.marketplace);
      if (conn.mode === "disabled") continue;
      const adapter = this.ctx.adapters.get(l.marketplace);
      if (!adapter.capabilities.retrieveListing) {
        if (l.status !== "delisted") summary.unverifiable++;
        continue;
      }
      const product = this.db.prepare("SELECT * FROM products WHERE id = ?").get(l.product_id) as ProductRow;
      try {
        const remote = await adapter.retrieveListing(l.external_id!, product.sku);
        summary.checked++;
        const base = { productId: l.product_id, listingId: l.id, marketplace: l.marketplace };
        if (l.status === "published") {
          if (!remote) flag({ ...base, kind: "missing_on_marketplace", expected: "active listing", actual: "not found" });
          else if (remote.status === "sold") flag({ ...base, kind: "sold_on_marketplace_not_recorded", expected: "active", actual: "sold — waiting for the order to arrive" });
          else if (remote.status !== "active") flag({ ...base, kind: "ended_on_marketplace", expected: "active", actual: remote.status });
          else {
            if (remote.quantity !== null && remote.quantity !== product.quantity_available) flag({ ...base, kind: "quantity_mismatch", expected: String(product.quantity_available), actual: String(remote.quantity) });
            if (remote.priceCents !== null && remote.priceCents !== l.price_cents) flag({ ...base, kind: "price_mismatch", expected: `$${(l.price_cents / 100).toFixed(2)}`, actual: `$${(remote.priceCents / 100).toFixed(2)}` });
          }
        } else if (remote?.status === "active") {
          // We believe it is ended (or ending), the marketplace says it is live: the oversale risk case.
          flag({ ...base, kind: "still_live_on_marketplace", expected: "ended", actual: "active" });
          if (l.status === "delisted") {
            this.db.prepare("UPDATE listings SET status = 'delisting_pending', updated_at = ? WHERE id = ?").run(clock.iso(), l.id);
            this.ctx.queue.enqueue("listing.end", { listingId: l.id, reason: "verified_sale", ref: "reconcile", actor: AGENT }, { idempotencyKey: `end:${l.id}:reconcile:${clock.iso().slice(0, 13)}`, priority: 1 });
          }
        }
        this.db.prepare("UPDATE listings SET last_synced_at = ? WHERE id = ?").run(clock.iso(), l.id);
      } catch (error) {
        summary.errors.push({ marketplace: l.marketplace, message: (error as Error).message.slice(0, 200) });
      }
    }

    // 3. Close discrepancies whose condition no longer holds (kinds this pass re-evaluates).
    const reevaluated = ["live_listing_for_sold_item", "missing_on_marketplace", "sold_on_marketplace_not_recorded", "ended_on_marketplace", "quantity_mismatch", "price_mismatch", "still_live_on_marketplace"];
    for (const d of this.list(true)) {
      if (reevaluated.includes(d.kind) && !stillTrue.has(d.dedupe_key)) {
        this.resolve(d.id, "No longer present at the next reconciliation.");
        summary.autoResolved++;
      }
    }
    this.ctx.audit.record({ actor: { type: "system", id: "reconciler" }, action: "reconcile.completed", detail: summary });
    return summary;
  }
}
