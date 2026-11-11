import type { Condition, MarketplaceId } from "../core/types";

// What each marketplace requires and — just as important — what each one
// actually lets software do. Researched November 2026 from official
// developer documentation; see docs/MARKETPLACES.md for sources and caveats.

export type IntegrationKind =
  /** An official, documented API exists and an adapter is implemented here. */
  | "official_api"
  /** No public seller API. The app prepares everything; the operator posts and confirms by hand. */
  | "assisted_only";

export interface MarketplaceSpec {
  id: MarketplaceId;
  name: string;
  integration: IntegrationKind;
  apiNotes: string;
  /** 0 means the marketplace has no separate title field (Depop). */
  titleMax: number;
  descriptionMax: number;
  minPhotos: number;
  maxPhotos: number;
  maxKeywords: number;
  tone: string;
  requiresSize: boolean;
  /** Etsy only accepts handmade, vintage (20+ years) or craft supplies. */
  restrictedTo?: string;
  conditionLabels: Record<Condition, string>;
}

const COMMON_CONDITIONS: Record<Condition, string> = {
  new_with_tags: "New with tags",
  new_without_tags: "New without tags",
  like_new: "Like new",
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

export const SPECS: Record<MarketplaceId, MarketplaceSpec> = {
  ebay: {
    id: "ebay",
    name: "eBay",
    integration: "official_api",
    apiNotes: "Official REST APIs (Sell Inventory, Fulfillment, Taxonomy, Browse). OAuth authorization-code grant. Sold-price data (Marketplace Insights API) is restricted to approved partners.",
    titleMax: 80,
    descriptionMax: 4000,
    minPhotos: 1,
    maxPhotos: 24,
    maxKeywords: 0,
    tone: "Search-driven. Lead with brand, model, item type, size, colour. Factual, complete item specifics.",
    requiresSize: true,
    conditionLabels: { ...COMMON_CONDITIONS, like_new: "Pre-owned", excellent: "Pre-owned", good: "Pre-owned", fair: "Pre-owned", poor: "For parts or not working" },
  },
  depop: {
    id: "depop",
    name: "Depop",
    integration: "official_api",
    apiNotes: "Official Selling API (partnerapi.depop.com). Access is by approval from Depop — there is no self-serve sign-up. Photos must be public HTTPS URLs.",
    titleMax: 0,
    descriptionMax: 1000,
    minPhotos: 1,
    maxPhotos: 8,
    maxKeywords: 5,
    tone: "Casual and concise. The first line acts as the title. End with up to five relevant hashtags.",
    requiresSize: true,
    conditionLabels: { new_with_tags: "Brand new", new_without_tags: "Like new", like_new: "Like new", excellent: "Used - Excellent", good: "Used - Good", fair: "Used - Fair", poor: "Used - Fair" },
  },
  mercari: {
    id: "mercari",
    name: "Mercari",
    integration: "assisted_only",
    apiNotes: "No public seller API for the US marketplace. Listings are prepared here and posted by the operator.",
    titleMax: 80,
    descriptionMax: 1000,
    minPhotos: 1,
    maxPhotos: 12,
    maxKeywords: 3,
    tone: "Short and direct. Brand, item, size, condition.",
    requiresSize: true,
    conditionLabels: { new_with_tags: "New", new_without_tags: "Like new", like_new: "Like new", excellent: "Good", good: "Good", fair: "Fair", poor: "Poor" },
  },
  poshmark: {
    id: "poshmark",
    name: "Poshmark",
    integration: "assisted_only",
    apiNotes: "No public seller API. Listings are prepared here and posted by the operator.",
    titleMax: 80,
    descriptionMax: 1500,
    minPhotos: 1,
    maxPhotos: 16,
    maxKeywords: 0,
    tone: "Friendly, fashion-focused. Brand and style first.",
    requiresSize: true,
    conditionLabels: { ...COMMON_CONDITIONS, new_with_tags: "NWT", new_without_tags: "NWOT" },
  },
  etsy: {
    id: "etsy",
    name: "Etsy",
    integration: "assisted_only",
    apiNotes: "Etsy has an official Open API v3, but an adapter is not implemented in this version; listings are prepared here and posted by the operator.",
    titleMax: 140,
    descriptionMax: 5000,
    minPhotos: 1,
    maxPhotos: 10,
    maxKeywords: 13,
    tone: "Descriptive, story-aware. Era and style matter for vintage.",
    requiresSize: false,
    restrictedTo: "Handmade, vintage (20+ years old) or craft supplies only",
    conditionLabels: COMMON_CONDITIONS,
  },
  facebook: {
    id: "facebook",
    name: "Facebook Marketplace",
    integration: "assisted_only",
    apiNotes: "No listing API for individual sellers. Listings are prepared here and posted by the operator.",
    titleMax: 99,
    descriptionMax: 5000,
    minPhotos: 1,
    maxPhotos: 10,
    maxKeywords: 0,
    tone: "Plain and local. What it is, size, condition, pickup/shipping.",
    requiresSize: false,
    conditionLabels: { new_with_tags: "New", new_without_tags: "Used - Like New", like_new: "Used - Like New", excellent: "Used - Good", good: "Used - Good", fair: "Used - Fair", poor: "Used - Fair" },
  },
};

// ---- internal taxonomy → marketplace categories ------------------------------------
export const PRODUCT_TYPES = [
  "t-shirt", "shirt", "polo", "sweater", "hoodie", "sweatshirt", "jacket", "coat", "vest", "jeans", "pants", "shorts",
  "dress", "skirt", "top", "blouse", "activewear", "swimwear", "sneakers", "boots", "shoes", "sandals", "heels",
  "bag", "hat", "belt", "scarf", "sunglasses", "jewelry", "watch", "accessory", "other",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

const ALIASES: Record<string, ProductType> = {
  tee: "t-shirt", tshirt: "t-shirt", "t shirt": "t-shirt", "tee shirt": "t-shirt", tshirts: "t-shirt",
  "button up": "shirt", "button-up": "shirt", "button down": "shirt", flannel: "shirt",
  jumper: "sweater", cardigan: "sweater", pullover: "sweater", knit: "sweater",
  hoody: "hoodie", "hooded sweatshirt": "hoodie", crewneck: "sweatshirt",
  windbreaker: "jacket", blazer: "jacket", parka: "coat", puffer: "coat",
  trousers: "pants", chinos: "pants", joggers: "pants", sweatpants: "pants", leggings: "activewear",
  trainers: "sneakers", "running shoes": "sneakers", "athletic shoes": "sneakers", loafers: "shoes", flats: "shoes",
  handbag: "bag", purse: "bag", backpack: "bag", tote: "bag", wallet: "accessory",
  cap: "hat", beanie: "hat", necklace: "jewelry", ring: "jewelry", bracelet: "jewelry", earrings: "jewelry",
};

/** Map free-text product type to the internal taxonomy. Unknown text becomes "other". */
export function normaliseProductType(text: string | null | undefined): ProductType {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return "other";
  if ((PRODUCT_TYPES as readonly string[]).includes(t)) return t as ProductType;
  if (ALIASES[t]) return ALIASES[t];
  for (const [alias, type] of Object.entries(ALIASES)) if (t.includes(alias)) return type;
  for (const type of PRODUCT_TYPES) if (t.includes(type)) return type;
  return "other";
}

export type Department = "menswear" | "womenswear" | "kids" | "unisex";

export function normaliseDepartment(text: string | null | undefined): Department | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  if (/women|ladies|female|girl'?s? women/.test(t)) return "womenswear";
  if (/\bmen|male|mens/.test(t)) return "menswear";
  if (/kid|child|boy|girl|youth|toddler|baby/.test(t)) return "kids";
  if (/unisex/.test(t)) return "unisex";
  return null;
}

const FOOTWEAR: ProductType[] = ["sneakers", "boots", "shoes", "sandals", "heels"];
const TOPS: ProductType[] = ["t-shirt", "shirt", "polo", "sweater", "hoodie", "sweatshirt", "top", "blouse"];
const OUTER: ProductType[] = ["jacket", "coat", "vest"];
const BOTTOMS: ProductType[] = ["jeans", "pants", "shorts", "skirt"];

export function needsSize(type: ProductType): boolean {
  return FOOTWEAR.includes(type) || TOPS.includes(type) || OUTER.includes(type) || BOTTOMS.includes(type) || ["dress", "activewear", "swimwear"].includes(type);
}

export interface CategoryMapping {
  categoryId: string | null;
  categoryName: string;
  /** static = built-in suggestion the operator should confirm; live = returned by the marketplace's own taxonomy API. */
  source: "static" | "live";
}

const GROUP = (type: ProductType): string =>
  FOOTWEAR.includes(type) ? "Shoes" : TOPS.includes(type) ? "Tops" : OUTER.includes(type) ? "Coats & Jackets" : BOTTOMS.includes(type) ? "Bottoms" : type === "dress" ? "Dresses" : type === "bag" ? "Bags" : "Accessories";

const DEPT_LABEL: Record<Department, string> = { menswear: "Men", womenswear: "Women", kids: "Kids", unisex: "Unisex" };

// Depop's product_type slugs for the Selling API (department is sent separately).
const DEPOP_TYPES: Partial<Record<ProductType, string>> = {
  "t-shirt": "tshirts", shirt: "shirts", polo: "polo-shirts", sweater: "jumpers", hoodie: "hoodies", sweatshirt: "sweatshirts",
  jacket: "jackets", coat: "coats", jeans: "jeans", pants: "trousers", shorts: "shorts", dress: "dresses", skirt: "skirts",
  sneakers: "trainers", boots: "boots", bag: "bags", hat: "hats",
};

/**
 * Built-in category suggestion. For eBay the adapter replaces this with the
 * Taxonomy API's own suggestion when a connection is available; static values
 * carry no category id because leaf ids must come from the marketplace.
 */
export function mapCategory(marketplace: MarketplaceId, type: ProductType, department: Department | null): CategoryMapping {
  const dept = DEPT_LABEL[department ?? "unisex"];
  const label = type === "other" ? "Other" : type.charAt(0).toUpperCase() + type.slice(1);
  switch (marketplace) {
    case "ebay":
      return { categoryId: null, categoryName: `Clothing, Shoes & Accessories > ${dept} > ${GROUP(type)} > ${label}`, source: "static" };
    case "depop":
      return { categoryId: DEPOP_TYPES[type] ?? null, categoryName: `${department ?? "unisex"} / ${DEPOP_TYPES[type] ?? type}`, source: "static" };
    case "etsy":
      return { categoryId: null, categoryName: `Clothing > ${dept}'s Clothing > ${GROUP(type)}`, source: "static" };
    default:
      return { categoryId: null, categoryName: `${dept} > ${GROUP(type)} > ${label}`, source: "static" };
  }
}

export const DEPOP_CONDITION: Record<Condition, string> = {
  new_with_tags: "brand_new",
  new_without_tags: "used_like_new",
  like_new: "used_like_new",
  excellent: "used_excellent",
  good: "used_good",
  fair: "used_fair",
  poor: "used_fair",
};

export const DEPOP_COLOURS = ["black", "grey", "white", "brown", "tan", "cream", "yellow", "red", "burgundy", "orange", "pink", "purple", "blue", "navy", "green", "khaki", "multi", "silver", "gold"];

// eBay Inventory API ConditionEnum values.
export const EBAY_CONDITION: Record<Condition, string> = {
  new_with_tags: "NEW",
  new_without_tags: "NEW_OTHER",
  like_new: "USED_EXCELLENT",
  excellent: "USED_EXCELLENT",
  good: "USED_GOOD",
  fair: "USED_ACCEPTABLE",
  poor: "FOR_PARTS_OR_NOT_WORKING",
};
