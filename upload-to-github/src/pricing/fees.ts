import type { FeeSchedule, Settings } from "../settings/schema";
import type { MarketplaceId } from "../core/types";

export interface FeeBreakdown {
  sellingFeeCents: number;
  paymentFeeCents: number;
  adFeeCents: number;
  listingFeeCents: number;
  totalFeesCents: number;
}

export interface ShippingTerms {
  payer: "buyer" | "seller";
  sellerCostCents: number;
  buyerChargeCents: number;
}

export interface ProfitBreakdown extends FeeBreakdown {
  salePriceCents: number;
  /** Shipping the seller ends up paying out of pocket. */
  sellerShippingCents: number;
  netProceedsCents: number;
  costCents: number;
  netProfitCents: number;
  /** Net profit / sale price × 100, rounded to 0.1. Zero when the price is zero. */
  marginPct: number;
}

/** Marketplace + payment + advertising fees for one sale. Pure integer arithmetic. */
export function computeFees(schedule: FeeSchedule, itemCents: number, buyerShippingCents: number, adRatePct: number): FeeBreakdown {
  const base = itemCents + (schedule.appliesToShipping ? buyerShippingCents : 0);
  let selling: number;
  if (schedule.flatBelow && itemCents < schedule.flatBelow.belowCents) {
    selling = schedule.flatBelow.flatCents;
  } else {
    selling = Math.round((base * schedule.sellingPct) / 100) + schedule.sellingFixedCents;
  }
  selling = Math.max(selling, schedule.minFeeCents);
  const payment = Math.round((base * schedule.paymentPct) / 100) + schedule.paymentFixedCents;
  const ad = Math.round((itemCents * adRatePct) / 100);
  return {
    sellingFeeCents: selling,
    paymentFeeCents: payment,
    adFeeCents: ad,
    listingFeeCents: schedule.listingFeeCents,
    totalFeesCents: selling + payment + ad + schedule.listingFeeCents,
  };
}

/**
 * Net Proceeds = Sale Price − marketplace fees − payment fees − seller-paid shipping − advertising − listing fees
 * Net Profit   = Net Proceeds − acquisition cost − other product-specific costs
 * Margin       = Net Profit / Sale Price × 100
 */
export function computeProfit(args: {
  salePriceCents: number;
  schedule: FeeSchedule;
  shipping: ShippingTerms;
  adRatePct: number;
  costCents: number;
}): ProfitBreakdown {
  const { salePriceCents, schedule, shipping, adRatePct, costCents } = args;
  const buyerShipping = shipping.payer === "buyer" ? shipping.buyerChargeCents : 0;
  const fees = computeFees(schedule, salePriceCents, buyerShipping, adRatePct);
  // When the buyer pays, the seller is only out of pocket if the charge does not cover the label.
  const sellerShipping = shipping.payer === "seller" ? shipping.sellerCostCents : Math.max(0, shipping.sellerCostCents - shipping.buyerChargeCents);
  const netProceeds = salePriceCents - fees.totalFeesCents - sellerShipping;
  const netProfit = netProceeds - costCents;
  return {
    ...fees,
    salePriceCents,
    sellerShippingCents: sellerShipping,
    netProceedsCents: netProceeds,
    costCents,
    netProfitCents: netProfit,
    marginPct: salePriceCents > 0 ? Math.round((netProfit / salePriceCents) * 1000) / 10 : 0,
  };
}

/**
 * Lowest sale price (cents) at which both the minimum dollar profit and the
 * minimum margin are met. Found by binary search over cents because flat-fee
 * tiers make the profit function piecewise; profit is monotonic in price
 * within the searched range for every supported schedule.
 */
export function breakEvenPrice(args: {
  schedule: FeeSchedule;
  shipping: ShippingTerms;
  adRatePct: number;
  costCents: number;
  minProfitCents: number;
  minMarginPct: number;
}): number {
  const ok = (price: number): boolean => {
    const p = computeProfit({ salePriceCents: price, schedule: args.schedule, shipping: args.shipping, adRatePct: args.adRatePct, costCents: args.costCents });
    return p.netProfitCents >= args.minProfitCents && p.marginPct >= args.minMarginPct;
  };
  let lo = 1;
  let hi = Math.max(1000, (args.costCents + args.minProfitCents) * 20 + 10000);
  if (!ok(hi)) return hi; // constraints unreachable (e.g. margin requirement above what fees allow)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  // Flat-fee tiers can make a slightly higher price fail; walk up until stable.
  let price = lo;
  for (let i = 0; i < 2000 && !ok(price); i++) price++;
  return price;
}

export function marketplaceTerms(settings: Settings, marketplace: MarketplaceId) {
  const m = settings.marketplaces[marketplace];
  return { schedule: m.fees, shipping: m.shipping as ShippingTerms, adRatePct: m.adRatePct };
}
