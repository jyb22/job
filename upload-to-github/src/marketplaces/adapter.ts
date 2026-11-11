import type { Condition, MarketplaceId } from "../core/types";
import type { CategoryMapping } from "./specs";

// The standard interface every marketplace integration implements. Internal
// code never talks to a marketplace directly — only through an adapter —
// which keeps integrations isolated from the AI layer and from each other.

export type AdapterMode = "api" | "assisted" | "simulated";

export interface AdapterCapabilities {
  createListing: boolean;
  updateListing: boolean;
  endListing: boolean;
  deleteListing: boolean;
  retrieveListing: boolean;
  retrieveInventory: boolean;
  updateInventory: boolean;
  retrieveOrders: boolean;
  retrieveFees: boolean;
  retrieveAnalytics: boolean;
  categoryLookup: boolean;
}

export const NO_CAPABILITIES: AdapterCapabilities = {
  createListing: false, updateListing: false, endListing: false, deleteListing: false, retrieveListing: false,
  retrieveInventory: false, updateInventory: false, retrieveOrders: false, retrieveFees: false, retrieveAnalytics: false, categoryLookup: false,
};

export interface ListingPayload {
  sku: string;
  idempotencyKey: string;
  title: string;
  description: string;
  priceCents: number;
  quantity: number;
  currency: string;
  category: CategoryMapping;
  condition: Condition;
  conditionNotes: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  department: string | null;
  productType: string;
  keywords: string[];
  /** Local file paths of optimised photos, in order. */
  imagePaths: string[];
  /** Public HTTPS URLs for the same photos, when PUBLIC_BASE_URL is configured. */
  imageUrls: string[];
  shipping: { payer: "buyer" | "seller"; buyerChargeCents: number };
  location: { countryCode: string; state: string };
  /** Marketplace-specific values the operator set on the product (e.g. depop_size_set_id). */
  extra: Record<string, string>;
}

export type RemoteStatus = "active" | "ended" | "sold" | "draft" | "unknown";

export interface RemoteListing {
  externalId: string;
  url: string | null;
  status: RemoteStatus;
  quantity: number | null;
  priceCents: number | null;
}

export interface CreateResult {
  externalId: string;
  url: string | null;
  /** live = it is on the marketplace now. awaiting_operator = a human has to post it. */
  state: "live" | "draft" | "awaiting_operator";
}

export interface RemoteOrder {
  externalOrderId: string;
  sku: string;
  quantity: number;
  salePriceCents: number;
  shippingChargedCents: number;
  /** Actual fees charged by the marketplace, when it reports them. */
  feesCents: number | null;
  soldAt: string;
}

export interface RemoteMetrics {
  impressions: number | null;
  views: number | null;
  watchers: number | null;
  likes: number | null;
  offers: number | null;
}

export interface AccountInfo {
  id: string | null;
  name: string | null;
  detail?: Record<string, unknown>;
}

export class UnsupportedOperationError extends Error {
  constructor(marketplace: string, operation: string) {
    super(`${marketplace} does not support "${operation}" through this integration`);
  }
}

export interface MarketplaceAdapter {
  readonly marketplace: MarketplaceId;
  readonly mode: AdapterMode;
  /** True for the simulated adapter only. Nothing it does reaches a real marketplace. */
  readonly simulated: boolean;
  readonly capabilities: AdapterCapabilities;

  authenticate(): Promise<void>;
  validateConnection(): Promise<{ ok: boolean; message: string }>;
  getAccountInformation(): Promise<AccountInfo>;
  getCategories(query: string): Promise<CategoryMapping[]>;
  getCategoryAttributes(categoryId: string): Promise<{ name: string; required: boolean; values: string[] }[]>;

  /** Create the listing (as a draft where the marketplace has drafts). Must be idempotent for a given idempotencyKey / SKU. */
  createListing(payload: ListingPayload): Promise<CreateResult>;
  updateListing(externalId: string, payload: ListingPayload): Promise<void>;
  /** Make a created listing live. A no-op where createListing already publishes. */
  publishListing(externalId: string, payload: ListingPayload): Promise<CreateResult>;
  retrieveListing(externalId: string, sku: string): Promise<RemoteListing | null>;
  retrieveInventory(): Promise<RemoteListing[]>;
  updateInventory(externalId: string, sku: string, quantity: number): Promise<void>;
  retrieveOrders(sinceIso: string): Promise<RemoteOrder[]>;
  retrieveSales(sinceIso: string): Promise<RemoteOrder[]>;
  /** End a listing. `reason: sold_elsewhere` lets marketplaces that distinguish it mark the item as sold. */
  endListing(externalId: string, sku: string, reason: "sold_elsewhere" | "operator"): Promise<void>;
  deleteListing(externalId: string, sku: string): Promise<void>;
  retrieveFees(externalOrderId: string): Promise<number | null>;
  retrieveAnalytics(externalId: string, sku: string): Promise<RemoteMetrics | null>;
}

/** Shared defaults: every optional operation refuses clearly instead of pretending to work. */
export abstract class BaseAdapter implements MarketplaceAdapter {
  abstract readonly marketplace: MarketplaceId;
  abstract readonly mode: AdapterMode;
  readonly simulated: boolean = false;
  abstract readonly capabilities: AdapterCapabilities;

  async authenticate(): Promise<void> {}
  abstract validateConnection(): Promise<{ ok: boolean; message: string }>;
  async getAccountInformation(): Promise<AccountInfo> {
    return { id: null, name: null };
  }
  async getCategories(_query: string): Promise<CategoryMapping[]> {
    return [];
  }
  async getCategoryAttributes(_categoryId: string): Promise<{ name: string; required: boolean; values: string[] }[]> {
    return [];
  }
  abstract createListing(payload: ListingPayload): Promise<CreateResult>;
  async updateListing(_externalId: string, _payload: ListingPayload): Promise<void> {
    throw new UnsupportedOperationError(this.marketplace, "updateListing");
  }
  async publishListing(externalId: string, _payload: ListingPayload): Promise<CreateResult> {
    return { externalId, url: null, state: "live" };
  }
  async retrieveListing(_externalId: string, _sku: string): Promise<RemoteListing | null> {
    throw new UnsupportedOperationError(this.marketplace, "retrieveListing");
  }
  async retrieveInventory(): Promise<RemoteListing[]> {
    throw new UnsupportedOperationError(this.marketplace, "retrieveInventory");
  }
  async updateInventory(_externalId: string, _sku: string, _quantity: number): Promise<void> {
    throw new UnsupportedOperationError(this.marketplace, "updateInventory");
  }
  async retrieveOrders(_sinceIso: string): Promise<RemoteOrder[]> {
    throw new UnsupportedOperationError(this.marketplace, "retrieveOrders");
  }
  async retrieveSales(sinceIso: string): Promise<RemoteOrder[]> {
    return this.retrieveOrders(sinceIso);
  }
  abstract endListing(externalId: string, sku: string, reason: "sold_elsewhere" | "operator"): Promise<void>;
  async deleteListing(_externalId: string, _sku: string): Promise<void> {
    throw new UnsupportedOperationError(this.marketplace, "deleteListing");
  }
  async retrieveFees(_externalOrderId: string): Promise<number | null> {
    return null;
  }
  async retrieveAnalytics(_externalId: string, _sku: string): Promise<RemoteMetrics | null> {
    return null;
  }
}
