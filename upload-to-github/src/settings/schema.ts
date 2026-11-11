import { z } from "zod";
import { MARKETPLACES, type MarketplaceId } from "../core/types";

// ---- fee schedules -------------------------------------------------------------
// Fee schedules are DATA the operator owns. The defaults below are starting
// points taken from publicly reported 2026 figures; marketplaces change fees
// often and vary them by category, so `verified` is false until the operator
// confirms them against the marketplace's own fee page (Settings → Fees).
export const feeScheduleSchema = z.object({
  /** Selling / final value fee, percent of the fee base. */
  sellingPct: z.number().min(0).max(100),
  /** Fixed selling fee per order, cents. */
  sellingFixedCents: z.number().int().min(0),
  /** Payment processing fee, percent of the fee base. */
  paymentPct: z.number().min(0).max(100),
  paymentFixedCents: z.number().int().min(0),
  /** Whether percentage fees are charged on buyer-paid shipping as well as the item price. */
  appliesToShipping: z.boolean(),
  /** Optional flat-fee tier: sales under `belowCents` pay `flatCents` instead of the percentage. */
  flatBelow: z.object({ belowCents: z.number().int().min(0), flatCents: z.number().int().min(0) }).nullable(),
  /** Minimum total selling fee per order, cents. */
  minFeeCents: z.number().int().min(0),
  /** Per-listing fee charged whether or not it sells, cents. */
  listingFeeCents: z.number().int().min(0),
  verified: z.boolean(),
  note: z.string().max(300),
});
export type FeeSchedule = z.infer<typeof feeScheduleSchema>;

const DEFAULT_FEES: Record<MarketplaceId, FeeSchedule> = {
  ebay: { sellingPct: 13.25, sellingFixedCents: 40, paymentPct: 0, paymentFixedCents: 0, appliesToShipping: true, flatBelow: null, minFeeCents: 0, listingFeeCents: 0, verified: false, note: "Most categories; varies by category and store level. Payment processing is included." },
  depop: { sellingPct: 0, sellingFixedCents: 0, paymentPct: 3.3, paymentFixedCents: 45, appliesToShipping: true, flatBelow: null, minFeeCents: 0, listingFeeCents: 0, verified: false, note: "US: no selling fee, processing fee only. UK and older listings differ. Real fees arrive with each order via the Depop API." },
  mercari: { sellingPct: 10, sellingFixedCents: 0, paymentPct: 0, paymentFixedCents: 0, appliesToShipping: false, flatBelow: null, minFeeCents: 0, listingFeeCents: 0, verified: false, note: "Reported 10% selling fee." },
  poshmark: { sellingPct: 20, sellingFixedCents: 0, paymentPct: 0, paymentFixedCents: 0, appliesToShipping: false, flatBelow: { belowCents: 1500, flatCents: 295 }, minFeeCents: 0, listingFeeCents: 0, verified: false, note: "$2.95 flat under $15, 20% at $15 and above." },
  etsy: { sellingPct: 6.5, sellingFixedCents: 0, paymentPct: 3, paymentFixedCents: 25, appliesToShipping: true, flatBelow: null, minFeeCents: 0, listingFeeCents: 20, verified: false, note: "6.5% transaction + 3% + $0.25 processing + $0.20 listing. Offsite Ads not included." },
  facebook: { sellingPct: 10, sellingFixedCents: 0, paymentPct: 0, paymentFixedCents: 0, appliesToShipping: true, flatBelow: null, minFeeCents: 80, listingFeeCents: 0, verified: false, note: "Shipped orders only; local pickup sales have no fee." },
};

const permissionsSchema = z
  .object({
    /** Agent may publish eligible listings on this marketplace. */
    publish: z.boolean().default(false),
    /** Agent may edit titles/descriptions of live listings. */
    updateContent: z.boolean().default(false),
    /** Agent may change prices within the approved boundaries. */
    reprice: z.boolean().default(false),
    /** Agent may end listings (cross-delisting after a verified sale). */
    end: z.boolean().default(true),
    /** Agent may push inventory quantity changes. */
    updateInventory: z.boolean().default(true),
  })
  .prefault({});

const shippingSchema = z
  .object({
    payer: z.enum(["buyer", "seller"]).default("buyer"),
    /** What the seller actually pays the carrier when the seller pays, cents. */
    sellerCostCents: z.number().int().min(0).default(0),
    /** What the buyer is charged for shipping, cents (affects fee base on some marketplaces). */
    buyerChargeCents: z.number().int().min(0).default(0),
  })
  .prefault({});

function marketplaceSettings(id: MarketplaceId) {
  return z
    .object({
      enabled: z.boolean().default(id === "ebay" || id === "depop" || id === "mercari"),
      permissions: permissionsSchema,
      /** Price adjustment relative to the base recommendation, percent (can be negative). */
      priceAdjustPct: z.number().min(-50).max(100).default(0),
      strategy: z.enum(["inherit", "premium", "competitive", "fast_sale"]).default("inherit"),
      shipping: shippingSchema,
      /** Promoted-listing / advertising rate applied to the sale price, percent. */
      adRatePct: z.number().min(0).max(100).default(0),
      fees: feeScheduleSchema.default(DEFAULT_FEES[id]),
    })
    .prefault({});
}

const marketplacesSchema = z
  .object(Object.fromEntries(MARKETPLACES.map((id) => [id, marketplaceSettings(id)])) as Record<MarketplaceId, ReturnType<typeof marketplaceSettings>>)
  .prefault({});

export const NOTIFICATION_TYPES = [
  "listing_published",
  "listing_failed",
  "item_sold",
  "cross_delist_ok",
  "cross_delist_failed",
  "inventory_discrepancy",
  "pricing_exception",
  "review_needed",
  "authenticity_concern",
  "marketplace_disconnected",
  "rate_limited",
  "suspicious_activity",
  "agent_failure",
  "profitability_change",
  "operator_task",
  "possible_oversale",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const settingsSchema = z.object({
  automation: z
    .object({
      mode: z.enum(["review_only", "semi_autonomous", "full_autonomous"]).default("review_only"),
      /** Pause: agent writes are deferred, not dropped. */
      paused: z.boolean().default(false),
      /** Emergency stop: all agent writes are denied until an owner releases it. */
      emergencyStop: z.boolean().default(false),
      emergencyStopReason: z.string().max(300).default(""),
      /**
       * During an emergency stop, still end other listings after a verified sale.
       * Stopping this would risk selling the same item twice, so it defaults to on.
       */
      protectiveDelistingDuringStop: z.boolean().default(true),
      /** ISO timestamp of when an owner explicitly acknowledged full-autonomy boundaries. Required for full_autonomous. */
      fullAutonomyAcknowledgedAt: z.string().nullable().default(null),
      approvalTtlHours: z.number().int().min(1).max(24 * 30).default(72),
    })
    .prefault({}),

  thresholds: z
    .object({
      minListingQuality: z.number().int().min(0).max(100).default(75),
      minIdentificationConfidence: z.number().min(0).max(1).default(0.8),
      minPricingConfidence: z.number().min(0).max(1).default(0.5),
      /** Listings priced above this always need a human, cents. */
      maxAutoPublishPriceCents: z.number().int().min(0).default(30000),
      /** Largest single automatic price change, percent of current price. */
      maxAutoPriceChangePct: z.number().min(0).max(100).default(15),
      /** Require real sold comparables (not simulated, not asking prices) before publishing automatically. */
      requireSoldComps: z.boolean().default(true),
      minSoldComps: z.number().int().min(0).max(50).default(3),
    })
    .prefault({}),

  pricing: z
    .object({
      strategy: z.enum(["premium", "competitive", "fast_sale"]).default("competitive"),
      minProfitCents: z.number().int().min(0).default(500),
      minMarginPct: z.number().min(0).max(95).default(15),
      /** Used only when there is no market data at all: cost × (1 + markup). */
      fallbackMarkupPct: z.number().min(0).max(2000).default(150),
      /** Largest total discount from the original listing price, percent. */
      maxDiscountPct: z.number().min(0).max(90).default(30),
      /** Cumulative markdown from the original price once a listing reaches each age. */
      markdownSchedule: z.array(z.object({ afterDays: z.number().int().min(1), pct: z.number().min(0).max(90) })).default([
        { afterDays: 21, pct: 5 },
        { afterDays: 45, pct: 10 },
        { afterDays: 75, pct: 20 },
      ]),
      /** Minimum hours between automatic price changes on one listing. */
      minRepriceIntervalHours: z.number().int().min(1).default(72),
      reviewIntervalDays: z.number().int().min(1).default(7),
      /** A sold comparable loses half its weight after this many days. */
      compHalfLifeDays: z.number().min(1).default(45),
      /** Asking prices are discounted by this much before being used as evidence, percent. */
      askingPriceHaircutPct: z.number().min(0).max(60).default(15),
      rounding: z.enum(["none", "whole", "x99"]).default("whole"),
    })
    .prefault({}),

  marketplaces: marketplacesSchema,

  risk: z
    .object({
      /** Brands that are frequently counterfeited: always routed to human authenticity review. */
      highRiskBrands: z.array(z.string()).default([
        "louis vuitton", "gucci", "chanel", "hermes", "prada", "dior", "balenciaga", "burberry", "fendi", "saint laurent",
        "bottega veneta", "celine", "goyard", "rolex", "cartier", "supreme", "off-white", "moncler", "canada goose",
        "chrome hearts", "yeezy", "jordan", "bape", "stone island", "versace", "givenchy", "valentino", "tiffany",
      ]),
      /** Words that mark an item as restricted/prohibited or its claims as unsafe: never published automatically. */
      restrictedKeywords: z.array(z.string()).default([
        "replica", "fake", "knockoff", "counterfeit", "inspired by", "aaa quality", "mirror quality", "bootleg",
        "recalled", "firearm", "ammunition", "prescription", "real fur", "ivory",
      ]),
      /** Items priced above this get an authenticity check regardless of brand, cents. */
      authenticityReviewAboveCents: z.number().int().min(0).default(20000),
    })
    .prefault({}),

  images: z
    .object({
      maxDimension: z.number().int().min(400).max(4000).default(1600),
      jpegQuality: z.number().int().min(40).max(100).default(85),
      minDimension: z.number().int().min(100).max(2000).default(500),
      /** Laplacian-variance sharpness below this is reported as blurry. */
      blurThreshold: z.number().min(0).default(60),
      /**
       * Hamming distance (of 64 bits) at or below which two photos count as the same picture.
       * Measured on test images: re-saved copies of one photo differ by 0–11 bits, different photos by 18+.
       */
      duplicateHashDistance: z.number().int().min(0).max(32).default(10),
    })
    .prefault({}),

  ai: z
    .object({
      provider: z.enum(["anthropic", "simulated", "none"]).default("anthropic"),
      visionModel: z.string().default("claude-opus-5-5"),
      writerModel: z.string().default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high"]).default("medium"),
      /** Use the model to polish titles/descriptions. The deterministic template is always the fallback. */
      useAiWriter: z.boolean().default(true),
    })
    .prefault({}),

  research: z
    .object({
      /** Your own verified sales history. */
      internalSales: z.boolean().default(true),
      /** eBay Browse API: ACTIVE listings (asking prices). Needs eBay keys. */
      ebayBrowse: z.boolean().default(false),
      /** eBay Marketplace Insights API: SOLD items. Restricted — eBay must grant access. */
      ebayInsights: z.boolean().default(false),
      /** Depop pricing inspiration: similar SOLD items. Needs Depop partner access. */
      depopPricing: z.boolean().default(false),
      /** SIMULATED comparables for demos and tests. Never used for automatic publishing. */
      simulated: z.boolean().default(false),
    })
    .prefault({}),

  notifications: z
    .object({
      emailEnabled: z.boolean().default(false),
      emailTo: z.string().default(""),
      webhookEnabled: z.boolean().default(false),
      webhookUrl: z.string().default(""),
      /** Notification types that are switched off. Everything else is on. */
      muted: z.array(z.enum(NOTIFICATION_TYPES)).default([]),
    })
    .prefault({}),

  schedules: z
    .object({
      ordersPollMinutes: z.number().int().min(1).default(5),
      reconcileMinutes: z.number().int().min(5).default(60),
      optimizeHours: z.number().int().min(1).default(24),
      metricsHours: z.number().int().min(1).default(12),
      reportDays: z.number().int().min(1).default(7),
    })
    .prefault({}),

  optimization: z
    .object({
      /** A live listing older than this with fewer than `minViews` views counts as underperforming. */
      staleAfterDays: z.number().int().min(1).default(14),
      minViews: z.number().int().min(0).default(10),
    })
    .prefault({}),

  location: z
    .object({
      countryCode: z.string().length(2).default("US"),
      state: z.string().default(""),
      currency: z.string().length(3).default("USD"),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type AutomationMode = Settings["automation"]["mode"];

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}
