import type { Ctx } from "../context";
import { writeTx } from "../db";
import { AGENT, LIVE_LISTING_STATUSES, type Actor, type ListingRow, type MarketplaceId, type OrderRow, type ProductRow } from "../core/types";
import { AppError, clock, DAY, newId } from "../core/util";
import { computeFees, marketplaceTerms } from "../pricing/fees";
import { SPECS } from "../marketplaces/specs";

export interface SaleEvent {
  marketplace: MarketplaceId;
  externalOrderId: string;
  sku: string;
  quantity: number;
  salePriceCents: number;
  shippingChargedCents?: number;
  /** Actual fees reported by the marketplace. When absent, fees are estimated from the fee schedule and marked as such. */
  feesCents?: number | null;
  shippingCostCents?: number;
  soldAt?: string;
}

/**
 * Where a sale report came from. Only these are accepted:
 *  - marketplace_api: read from the marketplace's orders API through an authorised adapter
 *  - signed_webhook:  a notification whose HMAC signature was verified
 *  - operator:        entered by a signed-in owner or manager
 */
export type SaleSource = "marketplace_api" | "signed_webhook" | "operator";

export interface SaleResult {
  status: "recorded" | "duplicate" | "conflict" | "unknown_sku";
  order?: OrderRow;
  crossDelist: { listingId: string; marketplace: string; outcome: string }[];
}

export class SalesService {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  // ---- inventory primitives (all atomic) -------------------------------------------------
  /** Hold stock for something not yet final (e.g. an unpaid order). Fails rather than overselling. */
  reserve(productId: string, quantity: number, ref: string, ttlSeconds = 3600): boolean {
    return writeTx(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM reservations WHERE ref = ?").get(ref)) return true; // idempotent
      const res = this.db.prepare("UPDATE products SET quantity_available = quantity_available - ?, quantity_reserved = quantity_reserved + ?, updated_at = ? WHERE id = ? AND quantity_available >= ?").run(quantity, quantity, clock.iso(), productId, quantity);
      if (res.changes === 0) return false;
      this.db.prepare("INSERT INTO reservations (id, product_id, quantity, ref, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'held', ?, ?)").run(newId("rsv"), productId, quantity, ref, new Date(clock.now().getTime() + ttlSeconds * 1000).toISOString(), clock.iso());
      this.db.prepare("INSERT INTO inventory_movements (id, product_id, kind, delta_available, delta_reserved, ref, at) VALUES (?, ?, 'reserve', ?, ?, ?, ?)").run(newId("mov"), productId, -quantity, quantity, ref, clock.iso());
      return true;
    });
  }

  release(ref: string): boolean {
    return writeTx(this.db, () => {
      const r = this.db.prepare("SELECT * FROM reservations WHERE ref = ? AND status = 'held'").get(ref) as { id: string; product_id: string; quantity: number } | undefined;
      if (!r) return false;
      this.db.prepare("UPDATE reservations SET status = 'released' WHERE id = ?").run(r.id);
      this.db.prepare("UPDATE products SET quantity_available = quantity_available + ?, quantity_reserved = quantity_reserved - ?, updated_at = ? WHERE id = ?").run(r.quantity, r.quantity, clock.iso(), r.product_id);
      this.db.prepare("INSERT INTO inventory_movements (id, product_id, kind, delta_available, delta_reserved, ref, at) VALUES (?, ?, 'release', ?, ?, ?, ?)").run(newId("mov"), r.product_id, r.quantity, -r.quantity, ref, clock.iso());
      return true;
    });
  }

  /** Release holds that have passed their expiry. */
  expireReservations(): number {
    const stale = this.db.prepare("SELECT ref FROM reservations WHERE status = 'held' AND expires_at <= ?").all(clock.iso()) as { ref: string }[];
    for (const r of stale) this.release(r.ref);
    return stale.length;
  }

  // ---- sale processing ---------------------------------------------------------------------
  /**
   * Record one sold line item and start cross-delisting.
   *
   * Everything that touches stock happens in a single write transaction that
   * holds the database write lock, so two sales of the same one-of-one item
   * arriving at the same moment are processed strictly one after the other:
   * the first takes the unit, the second finds none and is recorded as a
   * conflict (possible oversale) for a human to resolve. The same event
   * delivered twice is recognised by its key and ignored.
   */
  recordSale(event: SaleEvent, source: SaleSource, actor: Actor = AGENT, simulated = false): SaleResult {
    if (!Number.isInteger(event.quantity) || event.quantity < 1) throw new AppError("bad_quantity", "Quantity must be a positive whole number.", 400);
    if (!Number.isInteger(event.salePriceCents) || event.salePriceCents < 0) throw new AppError("bad_price", "Sale price is not valid.", 400);
    const eventKey = `sale:${event.marketplace}:${event.externalOrderId}:${event.sku}`;
    const settings = this.ctx.settings.get();

    const tx = writeTx(this.db, (): { status: SaleResult["status"]; order?: OrderRow; product?: ProductRow; listing?: ListingRow } => {
      const seen = this.db.prepare("INSERT INTO processed_events (event_key, source, received_at) VALUES (?, ?, ?) ON CONFLICT(event_key) DO NOTHING").run(eventKey, source, clock.iso());
      if (seen.changes === 0) {
        return { status: "duplicate", order: this.db.prepare("SELECT * FROM orders WHERE marketplace = ? AND external_order_id = ? AND sku = ?").get(event.marketplace, event.externalOrderId, event.sku) as OrderRow | undefined };
      }
      const product = this.db.prepare("SELECT * FROM products WHERE sku = ?").get(event.sku) as ProductRow | undefined;
      if (!product) {
        // Forget the event so it can be processed once the SKU exists or is corrected.
        this.db.prepare("DELETE FROM processed_events WHERE event_key = ?").run(eventKey);
        return { status: "unknown_sku" };
      }
      const listing = this.db.prepare("SELECT * FROM listings WHERE product_id = ? AND marketplace = ? ORDER BY created_at DESC LIMIT 1").get(product.id, event.marketplace) as ListingRow | undefined;

      const terms = marketplaceTerms(settings, event.marketplace);
      const shippingCharged = event.shippingChargedCents ?? 0;
      const feesKnown = event.feesCents !== null && event.feesCents !== undefined;
      const fees = feesKnown ? event.feesCents! : computeFees(terms.schedule, event.salePriceCents, shippingCharged, terms.adRatePct).totalFeesCents;
      const shippingCost = event.shippingCostCents ?? (terms.shipping.payer === "seller" ? terms.shipping.sellerCostCents : Math.max(0, terms.shipping.sellerCostCents - shippingCharged));
      const net = event.salePriceCents - fees - shippingCost;
      const unitCost = product.acquisition_cost_cents === null ? null : product.acquisition_cost_cents + product.extra_cost_cents;
      const cost = unitCost === null ? null : unitCost * event.quantity;

      // The atomic step: take stock only if it is there.
      const took = this.db
        .prepare("UPDATE products SET quantity_available = quantity_available - ?, quantity_sold = quantity_sold + ?, version = version + 1, updated_at = ? WHERE id = ? AND quantity_available >= ?")
        .run(event.quantity, event.quantity, clock.iso(), product.id, event.quantity);
      const status = took.changes === 1 ? "verified" : "conflict";
      const id = newId("ord");
      this.db
        .prepare(
          `INSERT INTO orders (id, marketplace, external_order_id, product_id, sku, listing_id, quantity, sale_price_cents, shipping_charged_cents, fees_cents, fees_verified,
             shipping_cost_cents, net_proceeds_cents, cost_cents, net_profit_cents, status, source, simulated, sold_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, event.marketplace, event.externalOrderId, product.id, event.sku, listing?.id ?? null, event.quantity, event.salePriceCents, shippingCharged, fees, feesKnown ? 1 : 0, shippingCost, net, cost, cost === null ? null : net - cost, status, source, simulated ? 1 : 0, event.soldAt ?? clock.iso(), clock.iso());
      if (status === "verified") {
        this.db.prepare("INSERT INTO inventory_movements (id, product_id, kind, delta_available, delta_sold, ref, at) VALUES (?, ?, 'sale', ?, ?, ?, ?)").run(newId("mov"), product.id, -event.quantity, event.quantity, id, clock.iso());
        if (listing && LIVE_LISTING_STATUSES.includes(listing.status)) {
          const remaining = product.quantity_available - event.quantity;
          if (remaining === 0) this.db.prepare("UPDATE listings SET status = 'sold', ended_at = ?, updated_at = ? WHERE id = ?").run(clock.iso(), clock.iso(), listing.id);
        }
      }
      return { status: status === "verified" ? "recorded" : "conflict", order: this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow, product: this.db.prepare("SELECT * FROM products WHERE id = ?").get(product.id) as ProductRow, listing };
    });

    if (tx.status === "duplicate") {
      this.ctx.audit.record({ actor, action: "sale.duplicate_ignored", entityType: "order", entityId: tx.order?.id, marketplace: event.marketplace, detail: { externalOrderId: event.externalOrderId, sku: event.sku, source } });
      return { status: "duplicate", order: tx.order, crossDelist: [] };
    }
    if (tx.status === "unknown_sku") {
      this.ctx.audit.record({ actor, action: "sale.unknown_sku", outcome: "failed", marketplace: event.marketplace, detail: { externalOrderId: event.externalOrderId, sku: event.sku, source } });
      this.ctx.notifications.notify({ type: "inventory_discrepancy", severity: "warning", title: `Sale reported for unknown SKU ${event.sku}`, body: `${SPECS[event.marketplace].name} order ${event.externalOrderId} references a SKU that is not in inventory.` });
      this.ctx.reconciler.raise({ marketplace: event.marketplace, kind: "sale_for_unknown_sku", expected: "known SKU", actual: event.sku, key: `unknown-sku:${event.marketplace}:${event.externalOrderId}:${event.sku}` });
      return { status: "unknown_sku", crossDelist: [] };
    }

    const order = tx.order!;
    const product = tx.product!;
    const tag = simulated ? "[SIMULATED] " : "";

    if (tx.status === "conflict") {
      // Sold twice (or more units sold than exist). Do not hide it; make a human look immediately.
      this.ctx.audit.record({ actor, action: "sale.conflict", outcome: "failed", entityType: "order", entityId: order.id, productId: product.id, marketplace: event.marketplace, detail: { externalOrderId: event.externalOrderId, sku: event.sku, available: product.quantity_available, requested: event.quantity, source } });
      this.ctx.reconciler.raise({ productId: product.id, listingId: tx.listing?.id, marketplace: event.marketplace, kind: "possible_oversale", expected: `stock for ${event.quantity}`, actual: `${product.quantity_available} available`, key: `oversale:${order.id}` });
      this.ctx.notifications.notify({
        type: "possible_oversale",
        severity: "critical",
        title: `${tag}Possible double sale: ${product.title ?? product.sku}`,
        body: `${SPECS[event.marketplace].name} order ${event.externalOrderId} sold ${event.quantity} × ${product.sku}, but no stock was left (it had already sold). One of the orders will need to be cancelled with the buyer.`,
        productId: product.id,
      });
      return { status: "conflict", order, crossDelist: [] };
    }

    this.ctx.audit.record({
      actor,
      action: "sale.recorded",
      entityType: "order",
      entityId: order.id,
      productId: product.id,
      marketplace: event.marketplace,
      detail: { externalOrderId: event.externalOrderId, sku: event.sku, quantity: event.quantity, salePriceCents: event.salePriceCents, feesCents: order.fees_cents, feesVerified: order.fees_verified === 1, netProceedsCents: order.net_proceeds_cents, netProfitCents: order.net_profit_cents, source, simulated },
    });
    this.ctx.audit.record({ actor, action: "inventory.updated", entityType: "product", entityId: product.id, productId: product.id, detail: { available: product.quantity_available, sold: product.quantity_sold, reason: `sale ${order.id}` } });
    this.ctx.notifications.notify({
      type: "item_sold",
      title: `${tag}Sold on ${SPECS[event.marketplace].name}: ${product.title ?? product.sku}`,
      body: `$${(event.salePriceCents / 100).toFixed(2)} · net proceeds $${(order.net_proceeds_cents / 100).toFixed(2)}${order.fees_verified ? "" : " (fees estimated)"}${order.net_profit_cents === null ? "" : ` · profit $${(order.net_profit_cents / 100).toFixed(2)}`}. SKU ${product.sku}.`,
      productId: product.id,
    });

    const crossDelist = this.afterSale(product, order, actor);
    this.ctx.listings.refreshProductStatus(product.id);
    return { status: "recorded", order, crossDelist };
  }

  /** Sold out → end every other live listing. Stock left → push the new quantity instead. */
  private afterSale(product: ProductRow, order: OrderRow, actor: Actor): SaleResult["crossDelist"] {
    const out: SaleResult["crossDelist"] = [];
    const others = this.ctx.listings.forProduct(product.id).filter((l) => l.id !== order.listing_id || product.quantity_available > 0);
    if (product.quantity_available === 0) {
      for (const listing of others) {
        if (!LIVE_LISTING_STATUSES.includes(listing.status)) {
          // Drafts for a sold item must never be published.
          if (["draft", "needs_review", "ready_to_publish", "approved", "publication_failed"].includes(listing.status)) {
            this.db.prepare("UPDATE listings SET status = 'archived', updated_at = ? WHERE id = ?").run(clock.iso(), listing.id);
            this.ctx.approvals.invalidateForListing(listing.id, "The item sold before this was decided.");
          }
          continue;
        }
        const result = this.ctx.listings.requestEnd(listing.id, actor.type === "user" ? actor : AGENT, "verified_sale", order.id);
        out.push({ listingId: listing.id, marketplace: listing.marketplace, outcome: result.outcome });
      }
      this.ctx.audit.record({ actor, action: "cross_delist.started", entityType: "product", entityId: product.id, productId: product.id, detail: { order: order.id, listings: out } });
    } else {
      this.ctx.queue.enqueue("inventory.sync", { productId: product.id }, { idempotencyKey: `inventory-sync:${product.id}:${order.id}`, priority: 2 });
    }
    return out;
  }

  // ---- order polling ---------------------------------------------------------------------------
  private cursor(marketplace: MarketplaceId): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(`orders_cursor:${marketplace}`) as { value: string } | undefined;
    return row?.value ?? new Date(clock.now().getTime() - 7 * DAY).toISOString();
  }

  /** Job handler: read new orders from a marketplace's API and record each one (duplicates are ignored). */
  async pollOrders(marketplace: MarketplaceId): Promise<{ fetched: number; recorded: number; note?: string }> {
    const conn = this.ctx.connections.get(marketplace);
    if (conn.mode === "disabled" || conn.mode === "assisted") return { fetched: 0, recorded: 0, note: "No orders API in this mode; sales are reported by the operator or a signed webhook." };
    const adapter = this.ctx.adapters.get(marketplace);
    if (!adapter.capabilities.retrieveOrders) return { fetched: 0, recorded: 0, note: "Adapter cannot retrieve orders." };
    const since = this.cursor(marketplace);
    const started = clock.iso();
    const orders = await adapter.retrieveOrders(since);
    let recorded = 0;
    for (const o of orders) {
      const r = this.recordSale({ marketplace, externalOrderId: o.externalOrderId, sku: o.sku, quantity: o.quantity, salePriceCents: o.salePriceCents, shippingChargedCents: o.shippingChargedCents, feesCents: o.feesCents, soldAt: o.soldAt }, "marketplace_api", AGENT, adapter.simulated);
      if (r.status === "recorded") recorded++;
    }
    // Overlap the window by ten minutes; duplicates are harmless, a missed order is not.
    const next = new Date(new Date(started).getTime() - 600_000).toISOString();
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(`orders_cursor:${marketplace}`, next, clock.iso());
    this.ctx.connections.setStatus(marketplace, adapter.simulated ? "simulated" : "connected", null, true);
    return { fetched: orders.length, recorded };
  }

  orders(filter: { limit?: number; productId?: string } = {}): OrderRow[] {
    return this.db.prepare(`SELECT * FROM orders ${filter.productId ? "WHERE product_id = ?" : ""} ORDER BY sold_at DESC LIMIT ?`).all(...(filter.productId ? [filter.productId, filter.limit ?? 200] : [filter.limit ?? 200])) as OrderRow[];
  }
}
