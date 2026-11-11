import type { Ctx } from "../context";
import { AGENT, type ListingRow } from "../core/types";
import { clock, daysBetween, newId } from "../core/util";
import { scheduledMarkdown } from "../pricing/engine";
import { SPECS } from "../marketplaces/specs";

export interface Recommendation {
  listingId: string;
  productId: string;
  marketplace: string;
  title: string;
  ageDays: number;
  kind: "markdown_due" | "low_views" | "no_engagement" | "better_photos" | "price_above_market";
  message: string;
  /** What happened when the agent proposed the change through the policy engine, if it did. */
  action?: string;
}

export interface OptimizeSummary {
  metricsCollected: number;
  metricsUnavailable: number;
  recommendations: Recommendation[];
}

export interface ChangeEvaluation {
  listingId: string;
  marketplace: string;
  title: string;
  field: string;
  at: string;
  before: string | null;
  after: string | null;
  metricsBefore: Record<string, number | null> | null;
  metricsNow: Record<string, number | null> | null;
  soldAfter: boolean;
  verdict: "sold_after_change" | "more_engagement" | "no_improvement" | "not_enough_data";
}

/**
 * Watches live listings, collects whatever performance data each marketplace
 * actually provides, and proposes improvements. Price changes are proposed
 * through the same policy engine as everything else; the optimiser cannot
 * apply anything the policy does not allow. Metrics a marketplace does not
 * report are stored as unknown, never guessed.
 */
export class Optimizer {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  async collectMetrics(): Promise<{ collected: number; unavailable: number }> {
    let collected = 0;
    let unavailable = 0;
    const live = this.db.prepare("SELECT * FROM listings WHERE status = 'published' AND external_id IS NOT NULL").all() as ListingRow[];
    for (const l of live) {
      if (this.ctx.connections.get(l.marketplace).mode === "disabled") continue;
      const adapter = this.ctx.adapters.get(l.marketplace);
      if (!adapter.capabilities.retrieveAnalytics) { unavailable++; continue; }
      try {
        const sku = (this.db.prepare("SELECT sku FROM products WHERE id = ?").get(l.product_id) as { sku: string }).sku;
        const m = await adapter.retrieveAnalytics(l.external_id!, sku);
        if (!m) { unavailable++; continue; }
        this.db
          .prepare("INSERT INTO listing_metrics (id, listing_id, captured_at, impressions, views, watchers, likes, offers, source, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(newId("met"), l.id, clock.iso(), m.impressions, m.views, m.watchers, m.likes, m.offers, adapter.mode, adapter.simulated ? 1 : 0);
        collected++;
      } catch {
        unavailable++;
      }
    }
    return { collected, unavailable };
  }

  /** Operator-entered metrics for marketplaces that do not expose any through an API. */
  recordManualMetrics(listingId: string, m: { views?: number; likes?: number; watchers?: number; offers?: number; impressions?: number }): void {
    this.db
      .prepare("INSERT INTO listing_metrics (id, listing_id, captured_at, impressions, views, watchers, likes, offers, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'operator')")
      .run(newId("met"), listingId, clock.iso(), m.impressions ?? null, m.views ?? null, m.watchers ?? null, m.likes ?? null, m.offers ?? null);
  }

  /** Analyse live listings. With `apply`, due markdowns are proposed to the policy engine. */
  async run(opts: { apply?: boolean } = {}): Promise<OptimizeSummary> {
    const settings = this.ctx.settings.get();
    const metrics = await this.collectMetrics();
    const recommendations: Recommendation[] = [];
    const live = this.db.prepare("SELECT * FROM listings WHERE status = 'published'").all() as ListingRow[];

    for (const l of live) {
      if (!l.published_at) continue;
      const ageDays = Math.floor(daysBetween(l.published_at));
      const base = { listingId: l.id, productId: l.product_id, marketplace: l.marketplace, title: l.title || l.description.split("\n")[0]!, ageDays };
      const m = this.ctx.listings.latestMetrics(l.id);

      const due = scheduledMarkdown({ originalPriceCents: l.original_price_cents, currentPriceCents: l.price_cents, minPriceCents: l.min_price_cents, listedAt: l.published_at, settings, now: clock.now() });
      if (due) {
        const rec: Recommendation = { ...base, kind: "markdown_due", message: `Listed ${ageDays} days. The markdown schedule calls for ${due.pct}% off the original price: $${(l.price_cents / 100).toFixed(2)} → $${(due.priceCents / 100).toFixed(2)} (floor $${(l.min_price_cents / 100).toFixed(2)}).` };
        if (opts.apply) {
          try {
            const r = await this.ctx.listings.reprice(l.id, due.priceCents, AGENT, `Scheduled markdown: ${due.pct}% after ${due.afterDays} days`);
            rec.action = r.outcome;
          } catch (error) {
            rec.action = `failed: ${(error as Error).message.slice(0, 120)}`;
          }
        }
        recommendations.push(rec);
      }

      if (ageDays >= settings.optimization.staleAfterDays) {
        if (m && m.views !== null && m.views !== undefined && m.views < settings.optimization.minViews) {
          recommendations.push({ ...base, kind: "low_views", message: `Only ${m.views} views in ${ageDays} days. Buyers are not finding it: review the title keywords and category.` });
        } else if (m && (m.views ?? 0) >= settings.optimization.minViews && (m.likes ?? 0) + (m.watchers ?? 0) + (m.offers ?? 0) === 0) {
          recommendations.push({ ...base, kind: "no_engagement", message: `${m.views} views but no likes, watchers or offers in ${ageDays} days. People look and leave: the price or photos are the likely cause.` });
        }
        const rec = this.ctx.research.latestRecommendation(l.product_id);
        if (rec?.premiumCents && l.price_cents > rec.premiumCents * 1.1) {
          recommendations.push({ ...base, kind: "price_above_market", message: `Priced $${(l.price_cents / 100).toFixed(2)}, above the top of the comparable range ($${(rec.premiumCents / 100).toFixed(2)}).` });
        }
        const suggested = this.ctx.products.suggestedPhotos(l.product_id);
        if (suggested.length) recommendations.push({ ...base, kind: "better_photos", message: `Add photos: ${suggested.map((s) => s.replace(/_/g, " ")).join(", ")}.` });
      }
    }

    this.ctx.audit.record({ actor: AGENT, action: "optimization.run", detail: { metricsCollected: metrics.collected, metricsUnavailable: metrics.unavailable, recommendations: recommendations.map((r) => ({ listing: r.listingId, kind: r.kind, action: r.action })) } });
    return { metricsCollected: metrics.collected, metricsUnavailable: metrics.unavailable, recommendations };
  }

  /** Did past changes help? Compares the metrics captured at the time of each change with the latest ones. */
  evaluations(limit = 100): ChangeEvaluation[] {
    const rows = this.db
      .prepare("SELECT r.*, l.marketplace, l.title, l.status AS listing_status, l.ended_at FROM listing_revisions r JOIN listings l ON l.id = r.listing_id ORDER BY r.at DESC LIMIT ?")
      .all(limit) as { listing_id: string; marketplace: string; title: string; field: string; at: string; before: string | null; after: string | null; metrics_before: string | null; listing_status: string; ended_at: string | null }[];
    return rows.map((r) => {
      const before = r.metrics_before ? (JSON.parse(r.metrics_before) as Record<string, number | null> | null) : null;
      const now = this.ctx.listings.latestMetrics(r.listing_id);
      const soldAfter = r.listing_status === "sold" && !!r.ended_at && r.ended_at > r.at;
      const engagement = (m: Record<string, number | null> | null) => (m ? (m.views ?? 0) + (m.likes ?? 0) * 3 + (m.watchers ?? 0) * 3 + (m.offers ?? 0) * 5 : null);
      const b = engagement(before);
      const n = engagement(now);
      const verdict: ChangeEvaluation["verdict"] = soldAfter ? "sold_after_change" : b === null || n === null ? "not_enough_data" : n > b ? "more_engagement" : "no_improvement";
      return { listingId: r.listing_id, marketplace: r.marketplace, title: r.title, field: r.field, at: r.at, before: r.before, after: r.after, metricsBefore: before, metricsNow: now, soldAfter, verdict };
    });
  }

  marketplaceMetricSupport() {
    return Object.values(SPECS).map((s) => {
      const conn = this.ctx.connections.get(s.id);
      const supported = conn.mode !== "disabled" && this.ctx.adapters.get(s.id).capabilities.retrieveAnalytics;
      return { marketplace: s.id, name: s.name, mode: conn.mode, automaticMetrics: supported, note: supported ? (s.id === "depop" ? "Likes, bag adds and open offers. Depop does not report views or impressions here." : "Provided by the adapter.") : "Not available automatically; enter them by hand if you track them." };
    });
  }
}
