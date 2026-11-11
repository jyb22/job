import type { Ctx } from "../context";
import { MARKETPLACES } from "../core/types";
import { clock, DAY, newId, round } from "../core/util";
import { SPECS } from "../marketplaces/specs";

// Reporting. Three kinds of money are kept apart everywhere:
//   verified  — from recorded sales (fees reported by the marketplace)
//   estimated — from recorded sales where fees were estimated from the fee schedule
//   projected — for unsold inventory, from current list prices and fee schedules
// Simulated sales are reported separately and never mixed into real totals.

const pct = (num: number, den: number) => (den ? round((num / den) * 100, 1) : null);

export class AnalyticsService {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  private one<T>(sql: string, ...args: unknown[]): T {
    return this.db.prepare(sql).get(...args) as T;
  }

  overview(includeSimulated = false) {
    const sim = includeSimulated ? "" : "AND simulated = 0";
    const inv = this.one<{ products: number; units: number; cost: number | null; unknown_cost: number }>(
      "SELECT COUNT(*) AS products, COALESCE(SUM(quantity_available + quantity_reserved), 0) AS units, SUM((quantity_available + quantity_reserved) * (COALESCE(acquisition_cost_cents, 0) + extra_cost_cents)) AS cost, SUM(CASE WHEN acquisition_cost_cents IS NULL THEN 1 ELSE 0 END) AS unknown_cost FROM products WHERE status != 'archived' AND quantity_available + quantity_reserved > 0",
    );
    const live = this.one<{ n: number; value: number | null }>(`SELECT COUNT(*) AS n, SUM(price_cents) AS value FROM listings WHERE status = 'published' ${sim}`);
    // Listed value counts each product once (its highest live price), not once per marketplace.
    const listedValue = this.one<{ v: number | null }>(`SELECT SUM(m) AS v FROM (SELECT MAX(l.price_cents) * p.quantity_available AS m FROM listings l JOIN products p ON p.id = l.product_id WHERE l.status = 'published' ${sim.replace("simulated", "l.simulated")} GROUP BY l.product_id)`);
    const sales = this.one<{ orders: number; units: number; revenue: number | null; net: number | null; profit: number | null; cost: number | null; verified_net: number | null; estimated_net: number | null; no_cost: number }>(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(quantity), 0) AS units, SUM(sale_price_cents) AS revenue, SUM(net_proceeds_cents) AS net, SUM(net_profit_cents) AS profit, SUM(cost_cents) AS cost,
         SUM(CASE WHEN fees_verified = 1 THEN net_proceeds_cents ELSE 0 END) AS verified_net, SUM(CASE WHEN fees_verified = 0 THEN net_proceeds_cents ELSE 0 END) AS estimated_net,
         SUM(CASE WHEN cost_cents IS NULL THEN 1 ELSE 0 END) AS no_cost
       FROM orders WHERE status = 'verified' ${sim}`,
    );
    const unsoldCost = this.one<{ v: number | null }>("SELECT SUM(quantity_available * (COALESCE(acquisition_cost_cents, 0) + extra_cost_cents)) AS v FROM products WHERE status != 'archived'");
    const attention = {
      approvals: this.ctx.approvals.pendingCount(),
      operatorTasks: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM manual_tasks WHERE status = 'open'").n,
      urgentTasks: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM manual_tasks WHERE status = 'open' AND urgent = 1").n,
      identificationRequired: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM products WHERE status = 'identification_required'").n,
      needsReview: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM products WHERE status = 'needs_review'").n,
      failedPublications: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM listings WHERE status = 'publication_failed'").n,
      discrepancies: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM discrepancies WHERE resolved_at IS NULL").n,
      deadJobs: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'dead'").n,
    };
    const simulatedSales = this.one<{ orders: number; revenue: number | null }>("SELECT COUNT(*) AS orders, SUM(sale_price_cents) AS revenue FROM orders WHERE status = 'verified' AND simulated = 1");
    return {
      generatedAt: clock.iso(),
      inventory: { products: inv.products, units: inv.units, acquisitionCostCents: inv.cost ?? 0, productsWithUnknownCost: inv.unknown_cost, unsoldCostCents: unsoldCost.v ?? 0 },
      listings: { active: live.n, listedValueCents: listedValue.v ?? 0, note: "Listed value is projected (asking prices), not income." },
      sales: {
        orders: sales.orders,
        unitsSold: sales.units,
        revenueCents: sales.revenue ?? 0,
        netProceedsCents: sales.net ?? 0,
        netProceedsVerifiedCents: sales.verified_net ?? 0,
        netProceedsEstimatedCents: sales.estimated_net ?? 0,
        netProfitCents: sales.profit ?? 0,
        marginPct: pct(sales.profit ?? 0, sales.revenue ?? 0),
        ordersMissingCost: sales.no_cost,
      },
      simulated: { orders: simulatedSales.orders, revenueCents: simulatedSales.revenue ?? 0, includedAbove: includeSimulated },
      attention: { ...attention, total: Object.values(attention).reduce((s, n) => s + n, 0) },
    };
  }

  byMarketplace(includeSimulated = false) {
    const sim = includeSimulated ? "" : "AND simulated = 0";
    return MARKETPLACES.map((m) => {
      const s = this.one<{ orders: number; revenue: number | null; net: number | null; profit: number | null; fees: number | null; verified: number }>(
        `SELECT COUNT(*) AS orders, SUM(sale_price_cents) AS revenue, SUM(net_proceeds_cents) AS net, SUM(net_profit_cents) AS profit, SUM(fees_cents) AS fees, COALESCE(SUM(fees_verified), 0) AS verified FROM orders WHERE status = 'verified' AND marketplace = ? ${sim}`,
        m,
      );
      const l = this.one<{ active: number; value: number | null; waiting: number; failed: number }>(
        `SELECT SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'published' THEN price_cents ELSE 0 END) AS value,
           SUM(CASE WHEN status IN ('needs_review','ready_to_publish','awaiting_operator') THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN status = 'publication_failed' THEN 1 ELSE 0 END) AS failed
         FROM listings WHERE marketplace = ? ${sim}`,
        m,
      );
      const days = this.one<{ d: number | null }>(
        `SELECT AVG(julianday(o.sold_at) - julianday(l.published_at)) AS d FROM orders o JOIN listings l ON l.id = o.listing_id WHERE o.status = 'verified' AND o.marketplace = ? AND l.published_at IS NOT NULL ${sim.replace("simulated", "o.simulated")}`,
        m,
      );
      const conn = this.ctx.connections.get(m);
      return {
        marketplace: m,
        name: SPECS[m].name,
        mode: conn.mode,
        connectionStatus: conn.status,
        activeListings: l.active ?? 0,
        listedValueCents: l.value ?? 0,
        waiting: l.waiting ?? 0,
        failed: l.failed ?? 0,
        orders: s.orders,
        revenueCents: s.revenue ?? 0,
        feesCents: s.fees ?? 0,
        feesVerifiedOrders: s.verified,
        netProceedsCents: s.net ?? 0,
        netProfitCents: s.profit ?? 0,
        marginPct: pct(s.profit ?? 0, s.revenue ?? 0),
        averageSaleCents: s.orders ? Math.round((s.revenue ?? 0) / s.orders) : null,
        averageDaysToSell: days.d === null ? null : round(days.d, 1),
      };
    });
  }

  byCategory(includeSimulated = false) {
    const sim = includeSimulated ? "" : "AND o.simulated = 0";
    return this.db
      .prepare(
        `SELECT COALESCE(p.category, 'uncategorised') AS category, COUNT(*) AS orders, SUM(o.sale_price_cents) AS revenueCents, SUM(o.net_profit_cents) AS netProfitCents,
           ROUND(AVG(o.sale_price_cents)) AS averageSaleCents, ROUND(AVG(julianday(o.sold_at) - julianday(p.created_at)), 1) AS averageDaysToSell
         FROM orders o JOIN products p ON p.id = o.product_id WHERE o.status = 'verified' ${sim} GROUP BY 1 ORDER BY netProfitCents DESC`,
      )
      .all()
      .map((r) => ({ ...(r as Record<string, number | string | null>), marginPct: pct(Number((r as { netProfitCents: number }).netProfitCents ?? 0), Number((r as { revenueCents: number }).revenueCents ?? 0)) }));
  }

  byProduct(limit = 50, includeSimulated = false) {
    const sim = includeSimulated ? "" : "AND o.simulated = 0";
    return this.db
      .prepare(
        `SELECT p.id, p.sku, p.title, p.brand, p.category, o.marketplace, o.sale_price_cents AS salePriceCents, o.fees_cents AS feesCents, o.fees_verified AS feesVerified,
           o.net_proceeds_cents AS netProceedsCents, o.cost_cents AS costCents, o.net_profit_cents AS netProfitCents, o.sold_at AS soldAt, o.simulated,
           ROUND(julianday(o.sold_at) - julianday(p.created_at), 1) AS daysToSell
         FROM orders o JOIN products p ON p.id = o.product_id WHERE o.status = 'verified' ${sim} ORDER BY o.sold_at DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Unsold stock by how long it has been in inventory. */
  aging() {
    const buckets = [
      { label: "0–30 days", min: 0, max: 30 },
      { label: "31–60 days", min: 31, max: 60 },
      { label: "61–90 days", min: 61, max: 90 },
      { label: "Over 90 days", min: 91, max: 100000 },
    ];
    const rows = this.db
      .prepare("SELECT id, sku, title, brand, category, status, created_at, quantity_available, COALESCE(acquisition_cost_cents, 0) + extra_cost_cents AS cost FROM products WHERE status NOT IN ('archived','sold') AND quantity_available > 0")
      .all() as { id: string; sku: string; title: string | null; brand: string | null; category: string | null; status: string; created_at: string; quantity_available: number; cost: number }[];
    const now = clock.now().getTime();
    const withAge = rows.map((r) => ({ ...r, ageDays: Math.floor((now - new Date(r.created_at).getTime()) / DAY) }));
    return {
      buckets: buckets.map((b) => {
        const items = withAge.filter((r) => r.ageDays >= b.min && r.ageDays <= b.max);
        return { label: b.label, products: items.length, units: items.reduce((s, r) => s + r.quantity_available, 0), costCents: items.reduce((s, r) => s + r.cost * r.quantity_available, 0) };
      }),
      slowest: withAge.sort((a, b) => b.ageDays - a.ageDays).slice(0, 20),
    };
  }

  /** Sales velocity and turnover over a trailing window. */
  velocity(days = 30, includeSimulated = false) {
    const sim = includeSimulated ? "" : "AND simulated = 0";
    const since = new Date(clock.now().getTime() - days * DAY).toISOString();
    const s = this.one<{ units: number; revenue: number | null; cogs: number | null }>(`SELECT COALESCE(SUM(quantity), 0) AS units, SUM(sale_price_cents) AS revenue, SUM(cost_cents) AS cogs FROM orders WHERE status = 'verified' AND sold_at >= ? ${sim}`, since);
    const stockCost = this.one<{ v: number | null }>("SELECT SUM(quantity_available * (COALESCE(acquisition_cost_cents, 0) + extra_cost_cents)) AS v FROM products WHERE status != 'archived'").v ?? 0;
    const stockUnits = this.one<{ v: number | null }>("SELECT SUM(quantity_available) AS v FROM products WHERE status != 'archived'").v ?? 0;
    const daily = this.db.prepare(`SELECT substr(sold_at, 1, 10) AS day, SUM(quantity) AS units, SUM(sale_price_cents) AS revenueCents FROM orders WHERE status = 'verified' AND sold_at >= ? ${sim} GROUP BY 1 ORDER BY 1`).all(since);
    return {
      windowDays: days,
      unitsSold: s.units,
      unitsPerWeek: round((s.units / days) * 7, 2),
      revenueCents: s.revenue ?? 0,
      sellThroughPct: pct(s.units, s.units + stockUnits),
      /** Cost of goods sold in the window ÷ cost of stock on hand. Null when there is no stock cost recorded. */
      inventoryTurnover: stockCost ? round((s.cogs ?? 0) / stockCost, 2) : null,
      daily,
    };
  }

  /** Patterns in actual sales that can inform buying decisions. Observations only: nothing is purchased automatically. */
  insights(includeSimulated = false) {
    const cats = this.byCategory(includeSimulated) as unknown as { category: string; orders: number; marginPct: number | null; averageDaysToSell: number | null; netProfitCents: number }[];
    const out: { kind: string; message: string; basis: string }[] = [];
    const enough = cats.filter((c) => c.orders >= 3);
    const best = [...enough].sort((a, b) => (b.marginPct ?? 0) - (a.marginPct ?? 0))[0];
    if (best) out.push({ kind: "strong_category", message: `${best.category} has your best margin (${best.marginPct}% across ${best.orders} sales).`, basis: "actual sales" });
    const fastest = [...enough].filter((c) => c.averageDaysToSell !== null).sort((a, b) => a.averageDaysToSell! - b.averageDaysToSell!)[0];
    if (fastest) out.push({ kind: "fast_mover", message: `${fastest.category} sells fastest (about ${fastest.averageDaysToSell} days on average).`, basis: "actual sales" });
    const losing = enough.filter((c) => c.netProfitCents < 0);
    for (const c of losing) out.push({ kind: "unprofitable_category", message: `${c.category} has lost money overall across ${c.orders} sales.`, basis: "actual sales" });
    const aging = this.aging();
    const old = aging.buckets[3]!;
    if (old.products > 0) out.push({ kind: "slow_stock", message: `${old.products} product(s) have been in stock over 90 days, tying up $${(old.costCents / 100).toFixed(2)} of cost.`, basis: "current inventory" });
    if (enough.length === 0) out.push({ kind: "not_enough_data", message: "Fewer than three sales in any category so far: not enough history to draw conclusions.", basis: "actual sales" });
    return out;
  }

  /** Build and store a periodic business report. */
  generateReport(days = 7, includeSimulated = false) {
    const end = clock.now();
    const start = new Date(end.getTime() - days * DAY);
    const sim = includeSimulated ? "" : "AND simulated = 0";
    const period = this.one<{ orders: number; revenue: number | null; net: number | null; profit: number | null; verified: number | null }>(
      `SELECT COUNT(*) AS orders, SUM(sale_price_cents) AS revenue, SUM(net_proceeds_cents) AS net, SUM(net_profit_cents) AS profit, SUM(fees_verified) AS verified FROM orders WHERE status = 'verified' AND sold_at >= ? AND sold_at <= ? ${sim}`,
      start.toISOString(),
      end.toISOString(),
    );
    const data = {
      title: `Business report: ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
      includesSimulatedData: includeSimulated,
      period: {
        days,
        orders: period.orders,
        revenueCents: period.revenue ?? 0,
        netProceedsCents: period.net ?? 0,
        netProfitCents: period.profit ?? 0,
        marginPct: pct(period.profit ?? 0, period.revenue ?? 0),
        ordersWithVerifiedFees: period.verified ?? 0,
        ordersWithEstimatedFees: period.orders - (period.verified ?? 0),
      },
      overview: this.overview(includeSimulated),
      marketplaces: this.byMarketplace(includeSimulated),
      categories: this.byCategory(includeSimulated),
      products: this.byProduct(100, includeSimulated),
      aging: this.aging().buckets,
      velocity: this.velocity(Math.max(days, 30), includeSimulated),
      insights: this.insights(includeSimulated),
      notes: [
        "Revenue, fees and profit come from recorded sales. Where a marketplace did not report its fees, they were estimated from your fee schedule and are counted as estimated.",
        "Listed value and inventory figures are projections from asking prices and recorded costs, not income.",
      ],
    };
    const id = newId("rpt");
    this.db.prepare("INSERT INTO reports (id, kind, period_start, period_end, generated_at, data) VALUES (?, 'business', ?, ?, ?, ?)").run(id, start.toISOString(), end.toISOString(), clock.iso(), JSON.stringify(data));
    this.ctx.audit.record({ actor: { type: "system", id: "reports" }, action: "report.generated", entityType: "report", entityId: id, detail: { days, orders: period.orders, netProfitCents: period.profit ?? 0 } });
    return { id, ...data };
  }

  reports(limit = 20) {
    return (this.db.prepare("SELECT id, kind, period_start, period_end, generated_at, data FROM reports ORDER BY generated_at DESC LIMIT ?").all(limit) as { id: string; data: string }[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
}
