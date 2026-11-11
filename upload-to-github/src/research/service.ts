import type { Ctx } from "../context";
import { parseJson, type Actor, type CompRow, type MarketplaceId, type ProductRow } from "../core/types";
import { clock, DAY, newId, round, sha256Hex } from "../core/util";
import { recommendPrice, type PriceRecommendation } from "../pricing/engine";
import { cleanLine, looksLikeInstruction } from "../security/sanitize";
import { ebayHosts, EbayAppAuth, type EbayConfig } from "../marketplaces/ebay";
import { httpJson } from "../marketplaces/http";
import { DEPOP_CONDITION, mapCategory, normaliseDepartment, normaliseProductType } from "../marketplaces/specs";

export interface FoundComp {
  marketplace: string | null;
  kind: "sold" | "active";
  title: string;
  priceCents: number;
  shippingCents?: number | null;
  condition?: string | null;
  size?: string | null;
  soldAt?: string | null;
  listedAt?: string | null;
  url?: string | null;
  simulated?: boolean;
}

export interface ProviderOutcome {
  provider: string;
  status: "ok" | "skipped" | "unavailable" | "error";
  found: number;
  note?: string;
}

interface CompsProvider {
  name: string;
  search(product: ProductRow): Promise<FoundComp[]>;
}

const tokens = (text: string | null | undefined): string[] => (text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * How comparable is a listing title to our product? 0..1, deterministic.
 * Brand carries the most weight; a listing for a different brand is capped low.
 */
export function scoreSimilarity(product: ProductRow, comp: { title: string; size?: string | null }): number {
  const title = new Set(tokens(comp.title));
  const has = (text: string | null) => {
    const t = tokens(text);
    return t.length > 0 && t.every((w) => title.has(w));
  };
  const overlap = (text: string | null) => {
    const t = tokens(text);
    return t.length ? t.filter((w) => title.has(w)).length / t.length : 0;
  };
  const type = normaliseProductType(product.category);
  const typeWords = type === "t-shirt" ? ["t", "shirt", "tee", "tshirt"] : tokens(type);
  let score = 0;
  const brandMatch = product.brand ? has(product.brand) : false;
  if (brandMatch) score += 0.35;
  score += 0.3 * (product.model ? overlap(product.model) : 0.5);
  if (typeWords.some((w) => title.has(w))) score += 0.15;
  if (product.size) {
    const compSize = comp.size ? tokens(comp.size).join("") : null;
    const ours = tokens(product.size).join("");
    if (compSize ? compSize === ours : title.has(ours)) score += 0.1;
  } else score += 0.05;
  if (product.color && overlap(product.color) > 0) score += 0.05;
  if (product.style_number && has(product.style_number)) score = Math.max(score, 0.9) + 0.05;
  if (product.brand && !brandMatch) score = Math.min(score, 0.3);
  return round(Math.min(1, score), 2);
}

function searchQuery(product: ProductRow): string {
  return [product.brand, product.model, normaliseProductType(product.category) !== "other" ? product.category : null, product.size]
    .filter(Boolean)
    .join(" ")
    .slice(0, 100);
}

export class ResearchService {
  /** Swappable in tests. */
  fetchImpl: typeof fetch = fetch;

  constructor(
    private ctx: Ctx,
    private ebayCfg: EbayConfig,
  ) {}

  private get db() {
    return this.ctx.db;
  }

  comps(productId: string): CompRow[] {
    return this.db.prepare("SELECT * FROM comps WHERE product_id = ? ORDER BY kind DESC, similarity DESC, sold_at DESC").all(productId) as CompRow[];
  }

  /** A comparable entered or confirmed by the operator. */
  addManualComp(productId: string, comp: FoundComp, actor: Actor): CompRow {
    const product = this.ctx.products.get(productId);
    const row = this.insert(product, "operator", comp);
    this.ctx.audit.record({ actor, action: "comp.added", entityType: "comp", entityId: row.id, productId: product.id, detail: { kind: comp.kind, priceCents: comp.priceCents } });
    return row;
  }

  removeComp(compId: string, actor: Actor): void {
    const row = this.db.prepare("SELECT * FROM comps WHERE id = ?").get(compId) as CompRow | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM comps WHERE id = ?").run(compId);
    this.ctx.audit.record({ actor, action: "comp.removed", entityType: "comp", entityId: compId, productId: row.product_id });
  }

  private insert(product: ProductRow, source: string, c: FoundComp): CompRow {
    const title = cleanLine(c.title, 200);
    const id = newId("cmp");
    const similarity = source === "operator" ? Math.max(0.8, scoreSimilarity(product, { title, size: c.size })) : scoreSimilarity(product, { title, size: c.size });
    this.db
      .prepare("INSERT INTO comps (id, product_id, source, marketplace, kind, title, price_cents, shipping_cents, condition, size, sold_at, listed_at, url, similarity, simulated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, product.id, source, c.marketplace, c.kind, title, Math.round(c.priceCents), c.shippingCents ?? null, c.condition ? cleanLine(c.condition, 60) : null, c.size ? cleanLine(c.size, 40) : null, c.soldAt ?? null, c.listedAt ?? null, c.url ? cleanLine(c.url, 500) : null, similarity, c.simulated ? 1 : 0, clock.iso());
    return this.db.prepare("SELECT * FROM comps WHERE id = ?").get(id) as CompRow;
  }

  private providers(): { provider: CompsProvider; enabled: boolean; unavailable?: string }[] {
    const r = this.ctx.settings.get().research;
    const ebayAuth = new EbayAppAuth({ ...this.ebayCfg, fetchImpl: this.fetchImpl });
    const ebayReady = ebayAuth.configured();
    return [
      { enabled: r.internalSales, provider: { name: "internal_sales", search: (p) => this.internalSales(p) } },
      { enabled: r.ebayBrowse, unavailable: ebayReady ? undefined : "eBay API keys are not configured", provider: { name: "ebay_browse", search: (p) => this.ebayBrowse(p, ebayAuth) } },
      { enabled: r.ebayInsights, unavailable: ebayReady ? undefined : "eBay API keys are not configured", provider: { name: "ebay_marketplace_insights", search: (p) => this.ebayInsights(p, ebayAuth) } },
      { enabled: r.depopPricing, unavailable: this.ctx.connections.get("depop").mode === "api" ? undefined : "Depop API access is not connected", provider: { name: "depop_pricing", search: (p) => this.depopPricing(p) } },
      { enabled: r.simulated, provider: { name: "simulated", search: (p) => this.simulated(p) } },
    ];
  }

  /**
   * Gather comparables from every enabled source. Operator-entered comps are
   * kept; everything else is refreshed. Each provider's outcome is returned
   * so the limits of the research are visible rather than hidden.
   */
  async run(productId: string): Promise<{ outcomes: ProviderOutcome[]; comps: CompRow[] }> {
    const product = this.ctx.products.get(productId);
    const outcomes: ProviderOutcome[] = [];
    const found: { source: string; comp: FoundComp }[] = [];
    for (const { provider, enabled, unavailable } of this.providers()) {
      if (!enabled) { outcomes.push({ provider: provider.name, status: "skipped", found: 0, note: "Disabled in settings" }); continue; }
      if (unavailable) { outcomes.push({ provider: provider.name, status: "unavailable", found: 0, note: unavailable }); continue; }
      try {
        const comps = await provider.search(product);
        // Marketplace text is untrusted: drop anything that reads like an instruction rather than a listing title.
        const safe = comps.filter((c) => c.priceCents > 0 && !looksLikeInstruction(c.title));
        found.push(...safe.map((comp) => ({ source: provider.name, comp })));
        outcomes.push({ provider: provider.name, status: "ok", found: safe.length, note: safe.length < comps.length ? `${comps.length - safe.length} result(s) discarded as unsafe or invalid` : undefined });
      } catch (error) {
        outcomes.push({ provider: provider.name, status: "error", found: 0, note: (error as Error).message.slice(0, 200) });
      }
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM comps WHERE product_id = ? AND source != 'operator'").run(product.id);
      for (const f of found) this.insert(product, f.source, f.comp);
    })();
    const comps = this.comps(product.id);
    this.ctx.audit.record({ actor: { type: "agent", id: "agent" }, action: "research.completed", entityType: "product", entityId: product.id, productId: product.id, detail: { outcomes, sold: comps.filter((c) => c.kind === "sold").length, active: comps.filter((c) => c.kind === "active").length } });
    return { outcomes, comps };
  }

  /** Deterministic price recommendation from stored comparables. Saved and audited. */
  recommend(productId: string, actor: Actor = { type: "agent", id: "agent" }): PriceRecommendation {
    const product = this.ctx.products.get(productId);
    const rec = recommendPrice({
      comps: this.comps(product.id),
      condition: product.condition,
      acquisitionCostCents: product.acquisition_cost_cents,
      extraCostCents: product.extra_cost_cents,
      productMinPriceCents: product.min_price_cents,
      settings: this.ctx.settings.get(),
      now: clock.now(),
    });
    this.db.prepare("INSERT INTO price_recommendations (id, product_id, computed_at, result) VALUES (?, ?, ?, ?)").run(newId("prc"), product.id, clock.iso(), JSON.stringify(rec));
    this.ctx.audit.record({
      actor,
      action: "pricing.calculated",
      entityType: "product",
      entityId: product.id,
      productId: product.id,
      detail: { basis: rec.basis, expected: rec.expectedSellingCents, confidence: rec.confidence, soldComps: rec.soldCompsUsed, flags: rec.flags, perMarketplace: rec.perMarketplace.map((m) => ({ m: m.marketplace, list: m.listPriceCents, floor: m.minAcceptableCents, profit: m.atListPrice.netProfitCents })) },
    });
    return rec;
  }

  latestRecommendation(productId: string): PriceRecommendation | null {
    const row = this.db.prepare("SELECT result FROM price_recommendations WHERE product_id = ? ORDER BY computed_at DESC, rowid DESC LIMIT 1").get(productId) as { result: string } | undefined;
    return row ? parseJson<PriceRecommendation | null>(row.result, null) : null;
  }

  // ---- providers ------------------------------------------------------------------
  /** Your own verified sales of the same brand and product type: the most trustworthy evidence there is. */
  private async internalSales(product: ProductRow): Promise<FoundComp[]> {
    if (!product.brand || !product.category) return [];
    const rows = this.db
      .prepare(
        `SELECT o.marketplace, o.sale_price_cents, o.sold_at, o.simulated, p.title, p.brand, p.model, p.category, p.size, p.condition
         FROM orders o JOIN products p ON p.id = o.product_id
         WHERE o.status = 'verified' AND p.id != ? AND LOWER(p.brand) = LOWER(?) AND p.category = ? AND o.sold_at >= ?`,
      )
      .all(product.id, product.brand, product.category, new Date(clock.now().getTime() - 365 * DAY).toISOString()) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      marketplace: String(r.marketplace),
      kind: "sold" as const,
      title: [r.brand, r.model, r.category, r.size].filter(Boolean).join(" "),
      priceCents: Number(r.sale_price_cents),
      condition: r.condition as string | null,
      size: r.size as string | null,
      soldAt: String(r.sold_at),
      simulated: r.simulated === 1,
    }));
  }

  /** eBay Browse API: ACTIVE listings only. These are asking prices and are treated as such. */
  private async ebayBrowse(product: ProductRow, auth: EbayAppAuth): Promise<FoundComp[]> {
    const token = await auth.appToken();
    const res = await httpJson<{ itemSummaries?: { title: string; price?: { value?: string }; condition?: string; itemWebUrl?: string; itemCreationDate?: string; shippingOptions?: { shippingCost?: { value?: string } }[] }[] }>(
      `${ebayHosts(this.ebayCfg.env).api}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(searchQuery(product))}&limit=50`,
      { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, fetchImpl: this.fetchImpl },
    );
    return (res.itemSummaries ?? []).map((i) => ({
      marketplace: "ebay",
      kind: "active" as const,
      title: i.title,
      priceCents: Math.round(parseFloat(i.price?.value ?? "0") * 100),
      shippingCents: i.shippingOptions?.[0]?.shippingCost?.value ? Math.round(parseFloat(i.shippingOptions[0].shippingCost.value) * 100) : null,
      condition: i.condition ?? null,
      listedAt: i.itemCreationDate ?? null,
      url: i.itemWebUrl ?? null,
    }));
  }

  /** eBay Marketplace Insights API: SOLD items. eBay restricts this API; without access the call fails and is reported. */
  private async ebayInsights(product: ProductRow, auth: EbayAppAuth): Promise<FoundComp[]> {
    const token = await auth.appToken("https://api.ebay.com/oauth/api_scope/buy.marketplace.insights");
    const res = await httpJson<{ itemSales?: { title: string; lastSoldPrice?: { value?: string }; lastSoldDate?: string; condition?: string; itemWebUrl?: string }[] }>(
      `${ebayHosts(this.ebayCfg.env).api}/buy/marketplace_insights/v1_beta/item_sales/search?q=${encodeURIComponent(searchQuery(product))}&limit=50`,
      { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, fetchImpl: this.fetchImpl },
    );
    return (res.itemSales ?? []).map((i) => ({
      marketplace: "ebay",
      kind: "sold" as const,
      title: i.title,
      priceCents: Math.round(parseFloat(i.lastSoldPrice?.value ?? "0") * 100),
      condition: i.condition ?? null,
      soldAt: i.lastSoldDate ?? null,
      url: i.itemWebUrl ?? null,
    }));
  }

  /** Depop pricing inspiration: similar SOLD items on Depop. Depop does not return sale dates or titles. */
  private async depopPricing(product: ProductRow): Promise<FoundComp[]> {
    if (!product.brand || !product.condition) return [];
    const type = normaliseProductType(product.category);
    const dept = normaliseDepartment(product.department);
    const loc = this.ctx.settings.get().location;
    const res = await this.ctx.adapters.depop().pricingInspiration({
      description: [product.brand, product.model, product.category, product.color, product.size].filter(Boolean).join(" "),
      productType: mapCategory("depop", type, dept).categoryId ?? type,
      department: dept ?? "unisex",
      condition: DEPOP_CONDITION[product.condition],
      brandName: product.brand,
      country: loc.countryCode,
      currency: loc.currency,
    });
    return (res.similar_sold_items ?? []).map((i) => ({
      marketplace: "depop",
      kind: "sold" as const,
      title: [i.brand_name, product.model, product.category].filter(Boolean).join(" "),
      priceCents: Math.round(parseFloat(i.sold_price_amount ?? "0") * 100),
      condition: i.condition ?? null,
      soldAt: null,
    }));
  }

  /**
   * SIMULATED comparables for the demo and tests: fabricated, deterministic
   * numbers derived from a hash of the product. Every row is stored with
   * simulated = 1, the recommendation is flagged, and the policy engine will
   * not auto-publish a price built on them to a real marketplace.
   */
  private async simulated(product: ProductRow): Promise<FoundComp[]> {
    const seed = parseInt(sha256Hex(`${product.brand}|${product.category}|${product.model}`).slice(0, 8), 16);
    const base = 1800 + (seed % 4200);
    const label = [product.brand, product.model, product.category].filter(Boolean).join(" ") || "item";
    const now = clock.now().getTime();
    const out: FoundComp[] = [];
    const markets: MarketplaceId[] = ["ebay", "depop", "mercari"];
    for (let i = 0; i < 9; i++) {
      const jitter = ((seed >> (i % 16)) % 21) - 10; // -10..+10 percent
      out.push({
        marketplace: markets[i % 3]!,
        kind: "sold",
        title: `${label} ${product.size ? `size ${product.size}` : ""} [simulated]`.trim(),
        priceCents: Math.round((base * (100 + jitter)) / 100),
        condition: product.condition,
        size: product.size,
        soldAt: new Date(now - (4 + i * 8) * DAY).toISOString(),
        simulated: true,
      });
    }
    for (let i = 0; i < 4; i++) {
      out.push({ marketplace: markets[i % 3]!, kind: "active", title: `${label} [simulated]`, priceCents: Math.round(base * (1.1 + i * 0.07)), condition: product.condition, listedAt: new Date(now - (10 + i * 12) * DAY).toISOString(), simulated: true });
    }
    return out;
  }
}
