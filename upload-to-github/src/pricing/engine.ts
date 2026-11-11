import { MARKETPLACES, type CompRow, type Condition, type MarketplaceId } from "../core/types";
import { clamp, daysBetween, round } from "../core/util";
import type { Settings } from "../settings/schema";
import { breakEvenPrice, computeProfit, marketplaceTerms, type ProfitBreakdown } from "./fees";

// All pricing is deterministic arithmetic over stored comparables and
// settings. No language model takes part in any number produced here.

export type PriceBasis = "sold_comps" | "sold_and_asking" | "asking_only" | "cost_markup" | "none";
export type TimeToSale = "fast" | "moderate" | "slow" | "very_slow" | "unknown";

export interface MarketplacePrice {
  marketplace: MarketplaceId;
  /** The price this marketplace's listing should carry. Never below minAcceptableCents. */
  listPriceCents: number;
  minAcceptableCents: number;
  /** Profit picture if it sells at the list price. */
  atListPrice: ProfitBreakdown;
  /** Profit picture at the expected selling price for this marketplace. */
  atExpectedPrice: ProfitBreakdown;
  raisedToFloor: boolean;
  feesVerified: boolean;
}

export interface PriceRecommendation {
  basis: PriceBasis;
  premiumCents: number | null;
  competitiveCents: number | null;
  fastSaleCents: number | null;
  expectedSellingCents: number | null;
  /** Strictest floor across enabled marketplaces (highest), for at-a-glance display. */
  minAcceptableCents: number | null;
  confidence: number;
  timeToSale: TimeToSale;
  soldCompsUsed: number;
  activeCompsUsed: number;
  /** True when any comparable used was simulated demo data. Blocks automatic publishing. */
  simulatedData: boolean;
  costKnown: boolean;
  costCents: number;
  perMarketplace: MarketplacePrice[];
  /** Plain-language limitations of this estimate, shown to the operator. */
  disclosures: string[];
  flags: string[];
}

export interface PricingInput {
  comps: CompRow[];
  condition: Condition | null;
  acquisitionCostCents: number | null;
  extraCostCents: number;
  productMinPriceCents: number | null;
  settings: Settings;
  marketplaces?: MarketplaceId[];
  now?: Date;
}

const CONDITION_FACTOR: Record<Condition, number> = {
  new_with_tags: 1.0,
  new_without_tags: 0.9,
  like_new: 0.85,
  excellent: 0.78,
  good: 0.65,
  fair: 0.5,
  poor: 0.35,
};

const MIN_SIMILARITY = 0.35;

interface Weighted {
  price: number;
  weight: number;
}

/** Weighted quantile (0..1) of price points. Returns null for an empty set. */
export function weightedQuantile(points: Weighted[], q: number): number | null {
  const sorted = points.filter((p) => p.weight > 0).sort((a, b) => a.price - b.price);
  if (sorted.length === 0) return null;
  const total = sorted.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc / total >= q) return p.price;
  }
  return sorted[sorted.length - 1]!.price;
}

function normaliseCondition(text: string | null): Condition | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (t in CONDITION_FACTOR) return t as Condition;
  if (/new.*tag|nwt|brand_new/.test(t)) return "new_with_tags";
  if (/nwot|new/.test(t)) return "new_without_tags";
  if (/like_new/.test(t)) return "like_new";
  if (/excellent|very_good/.test(t)) return "excellent";
  if (/good|pre.?owned|used/.test(t)) return "good";
  if (/fair|acceptable/.test(t)) return "fair";
  if (/poor|parts/.test(t)) return "poor";
  return null;
}

/** Scale a comparable's price to the condition of the item being priced. */
function conditionAdjusted(price: number, compCondition: string | null, target: Condition | null): number {
  const comp = normaliseCondition(compCondition);
  if (!comp || !target) return price;
  return Math.round(price * clamp(CONDITION_FACTOR[target] / CONDITION_FACTOR[comp], 0.6, 1.5));
}

export function applyRounding(cents: number, mode: Settings["pricing"]["rounding"], floorCents = 0): number {
  let out = cents;
  if (mode === "whole") out = Math.round(cents / 100) * 100;
  else if (mode === "x99") out = Math.max(99, Math.round(cents / 100) * 100 - 1);
  if (out < floorCents) {
    // Rounding must never take a price under the floor: round UP instead.
    out = mode === "none" ? floorCents : Math.ceil(floorCents / 100) * 100 - (mode === "x99" ? 1 : 0);
    if (out < floorCents) out += 100;
  }
  return out;
}

export function recommendPrice(input: PricingInput): PriceRecommendation {
  const { settings } = input;
  const now = input.now ?? new Date();
  const p = settings.pricing;
  const disclosures: string[] = [];
  const flags: string[] = [];

  const usable = input.comps.filter((c) => c.similarity >= MIN_SIMILARITY && c.price_cents > 0);
  const sold = usable.filter((c) => c.kind === "sold");
  const active = usable.filter((c) => c.kind === "active");

  const soldPoints: Weighted[] = sold.map((c) => {
    const age = c.sold_at ? Math.max(0, daysBetween(c.sold_at, now)) : 90;
    return {
      price: conditionAdjusted(c.price_cents, c.condition, input.condition),
      weight: c.similarity ** 2 * 0.5 ** (age / p.compHalfLifeDays),
    };
  });
  // An asking price is not evidence of a sale: discount it and give it little weight.
  const activePoints: Weighted[] = active.map((c) => ({
    price: Math.round(conditionAdjusted(c.price_cents, c.condition, input.condition) * (1 - p.askingPriceHaircutPct / 100)),
    weight: c.similarity ** 2 * 0.3,
  }));

  const minSold = Math.max(1, settings.thresholds.minSoldComps);
  let basis: PriceBasis;
  let points: Weighted[];
  if (soldPoints.length >= minSold) {
    basis = "sold_comps";
    points = soldPoints;
  } else if (soldPoints.length > 0) {
    basis = "sold_and_asking";
    points = [...soldPoints, ...activePoints];
    disclosures.push(`Only ${soldPoints.length} sold comparable(s) found; current asking prices (discounted ${p.askingPriceHaircutPct}%) were blended in.`);
  } else if (activePoints.length > 0) {
    basis = "asking_only";
    points = activePoints;
    disclosures.push(`No completed-sale data was available. This estimate uses asking prices only (discounted ${p.askingPriceHaircutPct}%), which do not prove what the item will sell for.`);
  } else {
    basis = input.acquisitionCostCents !== null ? "cost_markup" : "none";
    points = [];
  }

  const costKnown = input.acquisitionCostCents !== null;
  const costCents = (input.acquisitionCostCents ?? 0) + input.extraCostCents;
  if (!costKnown) {
    flags.push("cost_unknown");
    disclosures.push("Acquisition cost is not recorded, so profit figures assume a cost of $0 and the profit floor cannot be enforced.");
  }

  let expected = weightedQuantile(points, 0.5);
  let premium = weightedQuantile(points, 0.75);
  let fast = weightedQuantile(points, 0.25);
  if (basis === "cost_markup") {
    expected = Math.round(costCents * (1 + p.fallbackMarkupPct / 100));
    premium = Math.round(expected * 1.15);
    fast = Math.round(expected * 0.85);
    disclosures.push(`No market data was found. Price is acquisition cost plus the ${p.fallbackMarkupPct}% fallback markup and has not been checked against the market.`);
    flags.push("no_market_data");
  }
  if (basis === "none") {
    disclosures.push("No market data and no acquisition cost: a price cannot be recommended. Add comparables or a cost.");
    flags.push("no_market_data");
  }
  if (premium !== null && expected !== null && premium < Math.round(expected * 1.08)) premium = Math.round(expected * 1.1);

  const simulatedData = usable.some((c) => c.simulated === 1);
  if (simulatedData) {
    flags.push("simulated_comps");
    disclosures.push("SIMULATED comparables were used. These numbers are for demonstration only.");
  }

  // ---- confidence ----
  let confidence = 0;
  if (basis === "sold_comps" || basis === "sold_and_asking" || basis === "asking_only") {
    const used = basis === "asking_only" ? active : sold;
    const n = used.length;
    const avgSim = used.reduce((s, c) => s + c.similarity, 0) / Math.max(1, n);
    const recency = basis === "asking_only" ? 0.5 : sold.reduce((s, c) => s + 0.5 ** ((c.sold_at ? Math.max(0, daysBetween(c.sold_at, now)) : 90) / p.compHalfLifeDays), 0) / Math.max(1, sold.length);
    const q1 = weightedQuantile(points, 0.25) ?? 0;
    const q3 = weightedQuantile(points, 0.75) ?? 0;
    const spread = expected ? clamp((q3 - q1) / expected, 0, 1) : 1;
    confidence = 0.4 * Math.min(1, n / 8) + 0.25 * avgSim + 0.15 * recency + 0.2 * (1 - spread);
    if (basis === "sold_and_asking") confidence *= 0.6;
    if (basis === "asking_only") confidence *= 0.35;
  } else if (basis === "cost_markup") {
    confidence = 0.1;
  }
  confidence = round(clamp(confidence, 0, 1), 2);

  // ---- time to sale (an estimate from comparable sale frequency, not a promise) ----
  const recentSold = sold.filter((c) => c.sold_at && daysBetween(c.sold_at, now) <= 90).length;
  let timeToSale: TimeToSale = "unknown";
  if (recentSold >= 10) timeToSale = "fast";
  else if (recentSold >= 5) timeToSale = "moderate";
  else if (recentSold >= 2) timeToSale = "slow";
  else if (sold.length > 0) timeToSale = "very_slow";

  // ---- per-marketplace prices, floors and profit ----
  const perMarketplace: MarketplacePrice[] = [];
  const targets = input.marketplaces ?? MARKETPLACES.filter((m) => settings.marketplaces[m].enabled);
  for (const marketplace of targets) {
    const m = settings.marketplaces[marketplace];
    const terms = marketplaceTerms(settings, marketplace);
    const profitFloor = costKnown
      ? breakEvenPrice({ ...terms, costCents, minProfitCents: p.minProfitCents, minMarginPct: p.minMarginPct })
      : 0;
    const minAcceptable = Math.max(profitFloor, input.productMinPriceCents ?? 0, 100);

    const strategy = m.strategy === "inherit" ? p.strategy : m.strategy;
    const base = strategy === "premium" ? premium : strategy === "fast_sale" ? fast : expected;
    if (base === null) continue;
    const adjusted = Math.round(base * (1 + m.priceAdjustPct / 100));
    const raisedToFloor = adjusted < minAcceptable;
    const listPrice = applyRounding(Math.max(adjusted, minAcceptable), p.rounding, minAcceptable);
    const expectedHere = Math.max(Math.round((expected ?? base) * (1 + m.priceAdjustPct / 100)), 1);

    perMarketplace.push({
      marketplace,
      listPriceCents: listPrice,
      minAcceptableCents: minAcceptable,
      atListPrice: computeProfit({ salePriceCents: listPrice, ...terms, costCents }),
      atExpectedPrice: computeProfit({ salePriceCents: expectedHere, ...terms, costCents }),
      raisedToFloor,
      feesVerified: m.fees.verified,
    });
  }

  if (perMarketplace.some((mp) => mp.raisedToFloor)) {
    flags.push("market_below_floor");
    disclosures.push("The market price is below your profit floor on at least one marketplace; the price was raised to the floor and may not sell.");
  }
  if (perMarketplace.some((mp) => !mp.feesVerified)) {
    disclosures.push("Fee estimates use default fee schedules that have not been confirmed against the marketplaces' current fee pages.");
  }
  if (timeToSale !== "unknown") disclosures.push("Time-to-sale is an estimate from how often comparable items sold, not a guarantee.");

  return {
    basis,
    premiumCents: premium,
    competitiveCents: expected,
    fastSaleCents: fast,
    expectedSellingCents: expected,
    minAcceptableCents: perMarketplace.length ? Math.max(...perMarketplace.map((m) => m.minAcceptableCents)) : null,
    confidence,
    timeToSale: perMarketplace.some((mp) => mp.raisedToFloor) && timeToSale !== "unknown" ? "very_slow" : timeToSale,
    soldCompsUsed: sold.length,
    activeCompsUsed: basis === "sold_comps" ? 0 : active.length,
    simulatedData,
    costKnown,
    costCents,
    perMarketplace,
    disclosures,
    flags,
  };
}

/**
 * Next scheduled markdown price for a live listing, or null when none is due.
 * The result is already bounded by the maximum discount and the floor; the
 * policy engine still has the final say on whether it may be applied.
 */
export function scheduledMarkdown(args: {
  originalPriceCents: number;
  currentPriceCents: number;
  minPriceCents: number;
  listedAt: string;
  settings: Settings;
  now?: Date;
}): { priceCents: number; pct: number; afterDays: number } | null {
  const { settings } = args;
  const age = daysBetween(args.listedAt, args.now ?? new Date());
  const due = [...settings.pricing.markdownSchedule].sort((a, b) => a.afterDays - b.afterDays).filter((s) => age >= s.afterDays);
  const step = due[due.length - 1];
  if (!step) return null;
  const pct = Math.min(step.pct, settings.pricing.maxDiscountPct);
  const target = Math.round(args.originalPriceCents * (1 - pct / 100));
  const price = applyRounding(Math.max(target, args.minPriceCents), settings.pricing.rounding, args.minPriceCents);
  if (price >= args.currentPriceCents) return null;
  return { priceCents: price, pct, afterDays: step.afterDays };
}
