import { describe, expect, it } from "vitest";
import { applyRounding, recommendPrice, scheduledMarkdown, weightedQuantile } from "../src/pricing/engine";
import { breakEvenPrice, computeFees, computeProfit, marketplaceTerms } from "../src/pricing/fees";
import { defaultSettings, settingsSchema } from "../src/settings/schema";
import { comp } from "./helpers";

const settings = defaultSettings();
const DAY = 86_400_000;

describe("fee calculations", () => {
  it("eBay: percentage of item plus fixed per-order fee", () => {
    const f = computeFees(settings.marketplaces.ebay.fees, 2200, 0, 0);
    expect(f.sellingFeeCents).toBe(332); // round(2200 × 13.25%) + 40
    expect(f.totalFeesCents).toBe(332);
  });

  it("eBay: buyer-paid shipping is part of the fee base", () => {
    const f = computeFees(settings.marketplaces.ebay.fees, 2000, 500, 0);
    expect(f.sellingFeeCents).toBe(Math.round(2500 * 0.1325) + 40);
  });

  it("Depop: payment processing only", () => {
    const f = computeFees(settings.marketplaces.depop.fees, 2200, 0, 0);
    expect(f).toMatchObject({ sellingFeeCents: 0, paymentFeeCents: 118, totalFeesCents: 118 });
  });

  it("Poshmark: flat fee under $15, percentage at $15 and over", () => {
    expect(computeFees(settings.marketplaces.poshmark.fees, 1499, 0, 0).totalFeesCents).toBe(295);
    expect(computeFees(settings.marketplaces.poshmark.fees, 1500, 0, 0).totalFeesCents).toBe(300);
  });

  it("Etsy: transaction + processing + listing fee", () => {
    const f = computeFees(settings.marketplaces.etsy.fees, 2000, 0, 0);
    expect(f).toMatchObject({ sellingFeeCents: 130, paymentFeeCents: 85, listingFeeCents: 20, totalFeesCents: 235 });
  });

  it("Facebook: minimum fee applies to small sales", () => {
    expect(computeFees(settings.marketplaces.facebook.fees, 500, 0, 0).sellingFeeCents).toBe(80);
  });

  it("advertising fees are added on top", () => {
    expect(computeFees(settings.marketplaces.mercari.fees, 2000, 0, 5)).toMatchObject({ sellingFeeCents: 200, adFeeCents: 100, totalFeesCents: 300 });
  });
});

describe("profit calculation", () => {
  it("net proceeds = price − fees − seller-paid shipping; net profit = proceeds − cost; margin = profit ÷ price", () => {
    const p = computeProfit({ salePriceCents: 2200, schedule: settings.marketplaces.ebay.fees, shipping: { payer: "seller", sellerCostCents: 500, buyerChargeCents: 0 }, adRatePct: 0, costCents: 800 });
    expect(p.totalFeesCents).toBe(332);
    expect(p.sellerShippingCents).toBe(500);
    expect(p.netProceedsCents).toBe(1368);
    expect(p.netProfitCents).toBe(568);
    expect(p.marginPct).toBe(25.8);
  });

  it("when the buyer pays shipping the seller only covers any shortfall", () => {
    const p = computeProfit({ salePriceCents: 2000, schedule: settings.marketplaces.mercari.fees, shipping: { payer: "buyer", sellerCostCents: 600, buyerChargeCents: 450 }, adRatePct: 0, costCents: 0 });
    expect(p.sellerShippingCents).toBe(150);
  });

  it("can be negative, and says so", () => {
    const p = computeProfit({ salePriceCents: 500, schedule: settings.marketplaces.poshmark.fees, shipping: { payer: "buyer", sellerCostCents: 0, buyerChargeCents: 0 }, adRatePct: 0, costCents: 900 });
    expect(p.netProfitCents).toBeLessThan(0);
    expect(p.marginPct).toBeLessThan(0);
  });
});

describe("minimum profit protection", () => {
  it("break-even price is the lowest price that meets both the dollar and the margin floor", () => {
    for (const m of ["ebay", "depop", "mercari", "poshmark", "etsy", "facebook"] as const) {
      for (const cost of [0, 300, 800, 2500, 12000]) {
        const terms = marketplaceTerms(settings, m);
        const args = { ...terms, costCents: cost, minProfitCents: 500, minMarginPct: 15 };
        const price = breakEvenPrice(args);
        const at = computeProfit({ salePriceCents: price, ...terms, costCents: cost });
        expect(at.netProfitCents, `${m} cost ${cost}`).toBeGreaterThanOrEqual(500);
        expect(at.marginPct, `${m} cost ${cost}`).toBeGreaterThanOrEqual(15);
        const below = computeProfit({ salePriceCents: price - 1, ...terms, costCents: cost });
        expect(below.netProfitCents < 500 || below.marginPct < 15, `${m} cost ${cost}: one cent less must fail`).toBe(true);
      }
    }
  });

  it("the list price is never below the floor, even when the market is", () => {
    const comps = [2000, 2200, 2400, 2600, 3000].map((price_cents) => comp({ price_cents }));
    const rec = recommendPrice({ comps, condition: null, acquisitionCostCents: 2000, extraCostCents: 0, productMinPriceCents: null, settings, marketplaces: ["ebay"] });
    const ebay = rec.perMarketplace[0]!;
    expect(rec.expectedSellingCents).toBe(2400);
    expect(ebay.minAcceptableCents).toBeGreaterThan(2400);
    expect(ebay.listPriceCents).toBeGreaterThanOrEqual(ebay.minAcceptableCents);
    expect(ebay.raisedToFloor).toBe(true);
    expect(ebay.atListPrice.netProfitCents).toBeGreaterThanOrEqual(settings.pricing.minProfitCents);
    expect(rec.flags).toContain("market_below_floor");
  });

  it("an operator minimum price raises the floor", () => {
    const comps = [2000, 2200, 2400].map((price_cents) => comp({ price_cents }));
    const rec = recommendPrice({ comps, condition: null, acquisitionCostCents: 100, extraCostCents: 0, productMinPriceCents: 5000, settings, marketplaces: ["mercari"] });
    expect(rec.perMarketplace[0]!.minAcceptableCents).toBe(5000);
    expect(rec.perMarketplace[0]!.listPriceCents).toBeGreaterThanOrEqual(5000);
  });

  it("rounding never takes a price below the floor", () => {
    expect(applyRounding(2410, "x99", 2460)).toBeGreaterThanOrEqual(2460);
    expect(applyRounding(2449, "whole", 2460)).toBeGreaterThanOrEqual(2460);
    expect(applyRounding(2451, "x99", 0)).toBe(2499);
    expect(applyRounding(2449, "whole", 0)).toBe(2400);
    expect(applyRounding(2449, "none", 0)).toBe(2449);
  });
});

describe("sold-comparable pricing", () => {
  it("weighted quantiles", () => {
    const pts = [1000, 2000, 3000, 4000].map((price) => ({ price, weight: 1 }));
    expect(weightedQuantile(pts, 0.5)).toBe(2000);
    expect(weightedQuantile(pts, 0.75)).toBe(3000);
    expect(weightedQuantile([{ price: 1000, weight: 1 }, { price: 9000, weight: 9 }], 0.5)).toBe(9000);
    expect(weightedQuantile([], 0.5)).toBeNull();
  });

  it("uses completed sales for premium, competitive and fast-sale prices", () => {
    const comps = [2000, 2200, 2400, 2600, 3000].map((price_cents) => comp({ price_cents }));
    const rec = recommendPrice({ comps, condition: null, acquisitionCostCents: 500, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.basis).toBe("sold_comps");
    expect(rec.expectedSellingCents).toBe(2400);
    expect(rec.premiumCents).toBe(2600); // 75th percentile of the sales
    expect(rec.fastSaleCents).toBe(2200);
    expect(rec.soldCompsUsed).toBe(5);
    expect(rec.activeCompsUsed).toBe(0);
    expect(rec.simulatedData).toBe(false);
  });

  it("ignores asking prices when enough sales exist", () => {
    const sold = [2000, 2100, 2200].map((price_cents) => comp({ price_cents }));
    const asking = [9000, 9500, 9900].map((price_cents) => comp({ price_cents, kind: "active", sold_at: null }));
    const rec = recommendPrice({ comps: [...sold, ...asking], condition: null, acquisitionCostCents: 500, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.expectedSellingCents).toBe(2100);
  });

  it("recent and closely matching sales outweigh old or loose ones", () => {
    const now = new Date();
    const recent = [3000, 3000, 3000].map((price_cents) => comp({ price_cents, sold_at: now.toISOString(), similarity: 0.95 }));
    const old = [1000, 1000, 1000, 1000].map((price_cents) => comp({ price_cents, sold_at: new Date(now.getTime() - 300 * DAY).toISOString(), similarity: 0.5 }));
    const rec = recommendPrice({ comps: [...recent, ...old], condition: null, acquisitionCostCents: 0, extraCostCents: 0, productMinPriceCents: null, settings, now });
    expect(rec.expectedSellingCents).toBe(3000);
  });

  it("drops comparables that barely match", () => {
    const rec = recommendPrice({ comps: [comp({ price_cents: 99900, similarity: 0.2 })], condition: null, acquisitionCostCents: 1000, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.basis).toBe("cost_markup");
  });

  it("adjusts for condition differences", () => {
    const comps = [4000, 4000, 4000].map((price_cents) => comp({ price_cents, condition: "new_with_tags" }));
    const rec = recommendPrice({ comps, condition: "good", acquisitionCostCents: 0, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.expectedSellingCents).toBe(2600); // 4000 × 0.65
  });

  it("discloses when it had to fall back to asking prices, and has low confidence", () => {
    const asking = [3000, 3200, 3400].map((price_cents) => comp({ price_cents, kind: "active", sold_at: null }));
    const rec = recommendPrice({ comps: asking, condition: null, acquisitionCostCents: 500, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.basis).toBe("asking_only");
    expect(rec.expectedSellingCents).toBe(Math.round(3200 * 0.85));
    expect(rec.confidence).toBeLessThan(0.4);
    expect(rec.disclosures.join(" ")).toMatch(/No completed-sale data/);
    expect(rec.timeToSale).toBe("unknown");
  });

  it("with no market data uses cost plus markup and says the price is unchecked", () => {
    const rec = recommendPrice({ comps: [], condition: null, acquisitionCostCents: 1000, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.basis).toBe("cost_markup");
    expect(rec.expectedSellingCents).toBe(2500);
    expect(rec.confidence).toBe(0.1);
    expect(rec.flags).toContain("no_market_data");
  });

  it("with no data and no cost recommends nothing rather than inventing a price", () => {
    const rec = recommendPrice({ comps: [], condition: null, acquisitionCostCents: null, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.basis).toBe("none");
    expect(rec.expectedSellingCents).toBeNull();
    expect(rec.perMarketplace).toHaveLength(0);
  });

  it("flags simulated comparables and unknown cost", () => {
    const comps = [2000, 2100, 2200].map((price_cents) => comp({ price_cents, simulated: 1 }));
    const rec = recommendPrice({ comps, condition: null, acquisitionCostCents: null, extraCostCents: 0, productMinPriceCents: null, settings });
    expect(rec.simulatedData).toBe(true);
    expect(rec.costKnown).toBe(false);
    expect(rec.flags).toEqual(expect.arrayContaining(["simulated_comps", "cost_unknown"]));
  });

  it("applies marketplace-specific strategy and adjustment", () => {
    const s = settingsSchema.parse({ marketplaces: { ebay: { strategy: "premium", priceAdjustPct: 10 }, depop: { strategy: "fast_sale" } } });
    const comps = [2000, 2200, 2400, 2600, 3000].map((price_cents) => comp({ price_cents }));
    const rec = recommendPrice({ comps, condition: null, acquisitionCostCents: 200, extraCostCents: 0, productMinPriceCents: null, settings: s, marketplaces: ["ebay", "depop", "mercari"] });
    const price = (m: string) => rec.perMarketplace.find((x) => x.marketplace === m)!.listPriceCents;
    expect(price("ebay")).toBe(2900); // premium 2600 × 1.10 = 2860 → $29
    expect(price("depop")).toBe(2200);
    expect(price("mercari")).toBe(2400);
  });
});

describe("markdown schedule", () => {
  const base = { originalPriceCents: 4000, currentPriceCents: 4000, minPriceCents: 1000, settings };
  const listed = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  it("nothing is due before the first step", () => {
    expect(scheduledMarkdown({ ...base, listedAt: listed(10) })).toBeNull();
  });
  it("applies the cumulative discount for the listing's age", () => {
    expect(scheduledMarkdown({ ...base, listedAt: listed(22) })).toMatchObject({ priceCents: 3800, pct: 5 });
    expect(scheduledMarkdown({ ...base, listedAt: listed(80) })).toMatchObject({ priceCents: 3200, pct: 20 });
  });
  it("stops at the floor", () => {
    expect(scheduledMarkdown({ ...base, minPriceCents: 3500, listedAt: listed(80) })!.priceCents).toBe(3500);
  });
  it("is capped by the maximum discount", () => {
    const s = settingsSchema.parse({ pricing: { maxDiscountPct: 8 } });
    expect(scheduledMarkdown({ ...base, settings: s, listedAt: listed(80) })).toMatchObject({ pct: 8, priceCents: 3700 });
  });
  it("never proposes an increase", () => {
    expect(scheduledMarkdown({ ...base, currentPriceCents: 3000, listedAt: listed(22) })).toBeNull();
  });
});
