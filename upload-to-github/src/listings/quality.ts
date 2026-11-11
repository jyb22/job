import type { ImageRow, MarketplaceId, ProductRow } from "../core/types";
import { parseJson } from "../core/types";
import { clamp } from "../core/util";
import type { PriceRecommendation } from "../pricing/engine";
import { SPECS, needsSize, normaliseProductType, type CategoryMapping } from "../marketplaces/specs";
import type { Settings } from "../settings/schema";

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface QualityBreakdown {
  score: number;
  components: { name: string; points: number; max: number; note?: string }[];
}

export interface ListingDraft {
  marketplace: MarketplaceId;
  title: string;
  description: string;
  priceCents: number;
  category: CategoryMapping;
}

/** Check a draft against the marketplace's own requirements. Errors block publishing; warnings do not. */
export function validateListing(draft: ListingDraft, product: ProductRow, images: ImageRow[], settings: Settings): Validation {
  const spec = SPECS[draft.marketplace];
  const errors: string[] = [];
  const warnings: string[] = [];
  const type = normaliseProductType(product.category);

  if (spec.titleMax > 0) {
    if (!draft.title.trim()) errors.push("Title is empty.");
    if (draft.title.length > spec.titleMax) errors.push(`Title is ${draft.title.length} characters; ${spec.name} allows ${spec.titleMax}.`);
  }
  if (draft.description.trim().length < 20) errors.push("Description is too short.");
  if (draft.description.length > spec.descriptionMax) errors.push(`Description is ${draft.description.length} characters; ${spec.name} allows ${spec.descriptionMax}.`);
  if (images.length < spec.minPhotos) errors.push(`${spec.name} needs at least ${spec.minPhotos} photo.`);
  if (images.length > spec.maxPhotos) warnings.push(`${spec.name} allows ${spec.maxPhotos} photos; only the first ${spec.maxPhotos} will be used.`);
  if (draft.priceCents < 100) errors.push("Price must be at least $1.00.");
  if (!product.condition) errors.push("Condition is required.");
  if (type === "other" && !product.category) errors.push("Product type is required.");
  if (spec.requiresSize && needsSize(type) && !product.size) errors.push(`${spec.name} requires a size for this kind of item.`);
  if (draft.marketplace === "depop" && !product.brand) errors.push('Depop requires a brand (use "Unbranded" if there is none).');
  if (spec.restrictedTo) {
    const attrs = parseJson<Record<string, { value: string }>>(product.attributes, {});
    if (attrs.etsy_eligible?.value !== "yes") errors.push(`${spec.name} accepts ${spec.restrictedTo.toLowerCase()}. Confirm eligibility on the product before listing there.`);
  }
  const text = `${draft.title} ${draft.description}`.toLowerCase();
  for (const word of settings.risk.restrictedKeywords) {
    if (text.includes(word.toLowerCase())) errors.push(`Listing text contains a restricted term: "${word}".`);
  }
  if (/[A-Z]{4,}(\s+[A-Z]{4,}){3,}/.test(draft.title)) warnings.push("Title is mostly capitals.");
  if (images.some((i) => parseJson<{ issues?: string[] }>(i.quality, {}).issues?.includes("blurry"))) warnings.push("At least one photo looks blurry.");
  if (draft.category.source === "static") warnings.push("Category is a suggestion; confirm it on the marketplace.");

  return { ok: errors.length === 0, errors, warnings };
}

/** 0–100 listing quality score with a per-component breakdown. */
export function scoreListing(args: {
  draft: ListingDraft;
  product: ProductRow;
  images: ImageRow[];
  pricing: PriceRecommendation | null;
  validation: Validation;
}): QualityBreakdown {
  const { draft, product, images, pricing, validation } = args;
  const spec = SPECS[draft.marketplace];
  const type = normaliseProductType(product.category);
  const components: QualityBreakdown["components"] = [];
  const add = (name: string, fraction: number, max: number, note?: string) => components.push({ name, points: Math.round(clamp(fraction, 0, 1) * max), max, note });

  add("Product identification", product.identification_confidence ?? 0, 20);

  const title = (spec.titleMax > 0 ? draft.title : draft.description.split("\n")[0] ?? "").toLowerCase();
  const titleHits = [product.brand, type !== "other" ? type : product.category, product.size].filter((v) => v && title.includes(String(v).toLowerCase())).length;
  const want = [product.brand, product.category, product.size].filter(Boolean).length || 1;
  const lengthUse = spec.titleMax > 0 ? clamp(draft.title.length / (spec.titleMax * 0.45), 0, 1) : 1;
  add("Title relevance", 0.7 * (titleHits / want) + 0.3 * lengthUse, 15);

  const desc = draft.description.toLowerCase();
  const expected = [product.brand, product.size, product.color, product.material, product.condition ? "condition" : null].filter(Boolean) as string[];
  const present = expected.filter((v) => desc.includes(v.toLowerCase())).length;
  add("Description completeness", expected.length ? present / expected.length : 0, 15, `${present}/${expected.length} key details`);

  const issues = images.flatMap((i) => parseJson<{ issues?: string[] }>(i.quality, {}).issues ?? []);
  const countScore = clamp(images.length / 4, 0, 1);
  add("Photos", images.length === 0 ? 0 : 0.6 * countScore + 0.4 * (1 - clamp(issues.length / Math.max(1, images.length), 0, 1)), 15, `${images.length} photo(s), ${issues.length} issue(s)`);

  const required = [product.brand, product.category, product.condition, product.color, needsSize(type) ? product.size : "n/a"];
  add("Required attributes", required.filter(Boolean).length / required.length, 15);

  add("Category", type === "other" ? 0.2 : draft.category.source === "live" ? 1 : 0.7, 5, draft.category.source === "live" ? "confirmed by marketplace" : "built-in suggestion");

  let priceFraction = 0;
  if (pricing?.expectedSellingCents) {
    const hi = pricing.premiumCents ?? pricing.expectedSellingCents * 1.15;
    priceFraction = draft.priceCents <= hi ? 1 : clamp(1 - (draft.priceCents - hi) / hi, 0, 1);
    priceFraction *= 0.4 + 0.6 * pricing.confidence;
  }
  add("Price competitiveness", priceFraction, 10);

  add("Marketplace compliance", validation.ok ? (validation.warnings.length ? 0.8 : 1) : 0, 5);

  return { score: components.reduce((s, c) => s + c.points, 0), components };
}
