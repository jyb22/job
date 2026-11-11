// Shared domain types. Money is always integer cents.

export const MARKETPLACES = ["ebay", "depop", "mercari", "poshmark", "etsy", "facebook"] as const;
export type MarketplaceId = (typeof MARKETPLACES)[number];

export const PRODUCT_STATUSES = [
  "new",
  "processing",
  "identification_required",
  "needs_review",
  "ready_to_publish",
  "approved",
  "publishing",
  "published",
  "publication_failed",
  "sold",
  "delisting_pending",
  "delisted",
  "archived",
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const LISTING_STATUSES = [
  "draft",
  "needs_review",
  "ready_to_publish",
  "approved",
  "publishing",
  "awaiting_operator", // assisted marketplaces: waiting for the operator to post it by hand
  "published",
  "publication_failed",
  "sold",
  "delisting_pending",
  "delisted",
  "archived",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Listing statuses in which the item is (or may be) live on a marketplace. */
export const LIVE_LISTING_STATUSES: ListingStatus[] = ["publishing", "awaiting_operator", "published", "delisting_pending"];

export const CONDITIONS = ["new_with_tags", "new_without_tags", "like_new", "excellent", "good", "fair", "poor"] as const;
export type Condition = (typeof CONDITIONS)[number];

export type AttributeBasis = "visible" | "inferred" | "operator" | "import";

export interface AttributeValue {
  value: string;
  basis: AttributeBasis;
  confidence: number; // 0..1
}

export type Role = "owner" | "manager" | "viewer";

export interface Actor {
  type: "user" | "agent" | "system";
  id?: string;
  role?: Role;
}

export const AGENT: Actor = { type: "agent", id: "agent" };
export const SYSTEM: Actor = { type: "system", id: "system" };

export interface ProductRow {
  id: string;
  sku: string;
  status: ProductStatus;
  title: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  department: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  condition: Condition | null;
  condition_notes: string | null;
  style_number: string | null;
  upc: string | null;
  notes: string | null;
  attributes: string;
  identification: string | null;
  identification_confidence: number | null;
  risk_flags: string;
  acquisition_cost_cents: number | null;
  extra_cost_cents: number;
  min_price_cents: number | null;
  storage_location: string | null;
  quantity_available: number;
  quantity_reserved: number;
  quantity_sold: number;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ListingRow {
  id: string;
  product_id: string;
  marketplace: MarketplaceId;
  status: ListingStatus;
  title: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  attributes: string;
  price_cents: number;
  original_price_cents: number;
  min_price_cents: number;
  quality_score: number | null;
  quality: string;
  validation: string;
  writer: string;
  external_id: string | null;
  external_url: string | null;
  idempotency_key: string;
  simulated: number;
  integration_mode: string;
  last_error: string | null;
  published_at: string | null;
  ended_at: string | null;
  last_synced_at: string | null;
  last_repriced_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ImageRow {
  id: string;
  product_id: string;
  position: number;
  original_path: string;
  optimized_path: string | null;
  sha256: string;
  phash: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  blur_score: number | null;
  quality: string;
  view_label: string | null;
  created_at: string;
}

export interface CompRow {
  id: string;
  product_id: string;
  source: string;
  marketplace: string | null;
  kind: "sold" | "active";
  title: string;
  price_cents: number;
  shipping_cents: number | null;
  condition: string | null;
  size: string | null;
  sold_at: string | null;
  listed_at: string | null;
  url: string | null;
  similarity: number;
  simulated: number;
  created_at: string;
}

export interface OrderRow {
  id: string;
  marketplace: MarketplaceId;
  external_order_id: string;
  product_id: string | null;
  sku: string;
  listing_id: string | null;
  quantity: number;
  sale_price_cents: number;
  shipping_charged_cents: number;
  fees_cents: number;
  fees_verified: number;
  shipping_cost_cents: number;
  net_proceeds_cents: number;
  cost_cents: number | null;
  net_profit_cents: number | null;
  status: "verified" | "conflict";
  source: string;
  simulated: number;
  sold_at: string;
  created_at: string;
}

export const WORKFLOW_STAGES = [
  "ingestion",
  "image_analysis",
  "identification",
  "attribute_extraction",
  "validation",
  "market_research",
  "comparable_analysis",
  "pricing",
  "listing_generation",
  "marketplace_mapping",
  "quality_validation",
  "authorization",
  "publication",
  "publication_verification",
  "inventory_sync",
  "monitoring",
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
export type StageStatus = "pending" | "running" | "done" | "blocked" | "failed" | "skipped";

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
