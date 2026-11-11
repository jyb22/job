import { PermanentError } from "../core/util";
import { BaseAdapter, type AccountInfo, type AdapterCapabilities, type CreateResult, type ListingPayload, type RemoteListing, type RemoteMetrics, type RemoteOrder } from "./adapter";
import type { ConnectionStore } from "./connections";
import { httpJson, HttpStatusError } from "./http";
import { DEPOP_COLOURS, DEPOP_CONDITION } from "./specs";

// Depop adapter — the official Depop Selling API (https://partnerapi.depop.com/api-docs/).
// Access is granted by Depop on request; there is no self-serve sign-up. Auth
// here uses a per-shop API key ("Authorization: Bearer pak_…"), which Depop
// issues to partners managing their own shop.
//
// STATUS: implemented from Depop's published OpenAPI specification (fetched
// November 2026). It has NOT been run against Depop's staging or production
// API from this codebase, because that requires a key issued by Depop.
//
// Known gap: Depop requires `size_set_id` / `size_id` for sized product
// types. Those ids come from Depop's taxonomy, which is not part of the
// OpenAPI spec. Until a taxonomy lookup is added, set the product attributes
// `depop_size_set_id` and `depop_size_id` by hand; without them Depop will
// reject sized items and the listing is reported as failed (never silently
// dropped).

export interface DepopConfig {
  env: "staging" | "production";
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function depopBase(env: "staging" | "production"): string {
  return env === "production" ? "https://partnerapi.depop.com" : "https://partnerapi-staging.depop.com";
}

interface DepopProduct {
  product_id?: number;
  slug?: string;
  sku?: string;
  status?: string;
  quantity?: number;
  current_price?: { amount?: string } | string;
  price_amount?: string;
}

export class DepopAdapter extends BaseAdapter {
  readonly marketplace = "depop" as const;
  readonly mode = "api" as const;
  readonly capabilities: AdapterCapabilities = {
    createListing: true, updateListing: true, endListing: true, deleteListing: true, retrieveListing: true,
    retrieveInventory: false, updateInventory: true, retrieveOrders: true, retrieveFees: false, retrieveAnalytics: true, categoryLookup: false,
  };

  constructor(
    private cfg: DepopConfig,
    private connections: ConnectionStore,
  ) {
    super();
  }

  private key(): string {
    const key = this.connections.credentials<{ apiKey?: string }>("depop")?.apiKey ?? this.cfg.apiKey;
    if (!key) throw new PermanentError("Depop API key is not configured. Depop issues keys to approved partners; add yours in Settings → Marketplaces.");
    return key;
  }

  private async api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    try {
      return await httpJson<T>(`${depopBase(this.cfg.env)}${path}`, { method: opts.method, body: opts.body, headers: { Authorization: `Bearer ${this.key()}` }, fetchImpl: this.cfg.fetchImpl });
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 401) {
        this.connections.setStatus("depop", "disconnected", "Depop rejected the API key.");
        throw new PermanentError("Depop rejected the API key.");
      }
      throw error;
    }
  }

  async validateConnection() {
    try {
      const info = await this.getAccountInformation();
      return { ok: true, message: `Connected to Depop (${this.cfg.env})${info.name ? ` as ${info.name}` : ""}.` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  override async getAccountInformation(): Promise<AccountInfo> {
    const shop = await this.api<Record<string, unknown>>("/api/v1/shop/");
    return { id: shop.id ? String(shop.id) : null, name: (shop.username as string) ?? (shop.name as string) ?? null };
  }

  private body(p: ListingPayload) {
    if (p.imageUrls.length === 0) throw new PermanentError("Depop needs public photo URLs. Set PUBLIC_BASE_URL so this server's photos are reachable.");
    if (!p.category.categoryId) throw new PermanentError(`No Depop product type is mapped for "${p.productType}".`);
    const colour = DEPOP_COLOURS.filter((c) => (p.color ?? "").toLowerCase().includes(c)).slice(0, 2);
    const sizeSet = Number(p.extra.depop_size_set_id);
    const sizeId = Number(p.extra.depop_size_id);
    const size = sizeSet && sizeId ? { size_set_id: sizeSet, size_id: sizeId } : null;
    return {
      address: { country_code: p.location.countryCode, state: p.location.state },
      description: p.description.slice(0, 1000),
      price_currency: p.currency,
      price_amount: (p.priceCents / 100).toFixed(2),
      ...(p.shipping.payer === "seller" ? { national_shipping_cost: "0.00" } : { national_shipping_cost: (p.shipping.buyerChargeCents / 100).toFixed(2) }),
      quantity: Math.max(1, p.quantity),
      pictures: p.imageUrls.slice(0, 8).map((url) => ({ url })),
      department: p.department ?? "unisex",
      product_type: p.category.categoryId,
      ...(size ?? {}),
      condition: DEPOP_CONDITION[p.condition],
      ...(colour.length ? { colour } : {}),
      brand_name: p.brand ?? "Unbranded",
      attributes: {},
    };
  }

  private url(slug?: string): string | null {
    return slug ? `https://www.depop.com/products/${slug}/` : null;
  }

  /** PUT by SKU is an upsert on Depop's side, so retries can never create a second listing. */
  async createListing(p: ListingPayload): Promise<CreateResult> {
    const res = await this.api<DepopProduct>(`/api/v1/products/by-sku/${encodeURIComponent(p.sku)}/`, { method: "PUT", body: this.body(p) });
    return { externalId: String(res.product_id ?? p.sku), url: this.url(res.slug), state: "live" };
  }

  override async updateListing(_externalId: string, p: ListingPayload): Promise<void> {
    await this.api(`/api/v1/products/by-sku/${encodeURIComponent(p.sku)}/`, { method: "PUT", body: this.body(p) });
  }

  override async retrieveListing(externalId: string, sku: string): Promise<RemoteListing | null> {
    try {
      const r = await this.api<DepopProduct>(`/api/v1/products/by-sku/${encodeURIComponent(sku)}/`);
      const s = r.status ?? "";
      const status: RemoteListing["status"] = s === "STATUS_ONSALE" ? "active" : s.includes("PURCHASED") || s.includes("MARKED_AS_SOLD") ? "sold" : s.includes("DELETED") || s.includes("BANNED") ? "ended" : "unknown";
      const price = typeof r.current_price === "string" ? r.current_price : (r.current_price?.amount ?? r.price_amount);
      return { externalId, url: this.url(r.slug), status, quantity: r.quantity ?? null, priceCents: price ? Math.round(parseFloat(price) * 100) : null };
    } catch (error) {
      if (error instanceof PermanentError && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  override async updateInventory(_externalId: string, sku: string, quantity: number): Promise<void> {
    if (quantity <= 0) return this.endListing(_externalId, sku, "sold_elsewhere");
    await this.api(`/api/v1/products/by-sku/${encodeURIComponent(sku)}/`, { method: "PATCH", body: { quantity } });
  }

  /** Sold elsewhere → Depop's mark-as-sold (as Depop's docs instruct). Operator removal → delete. Both are idempotent on Depop's side. */
  async endListing(_externalId: string, sku: string, reason: "sold_elsewhere" | "operator"): Promise<void> {
    if (reason === "sold_elsewhere") await this.api(`/api/v1/products/by-sku/${encodeURIComponent(sku)}/mark-as-sold/`, { method: "POST" });
    else await this.api(`/api/v1/products/by-sku/${encodeURIComponent(sku)}/`, { method: "DELETE" });
  }

  override async deleteListing(_externalId: string, sku: string): Promise<void> {
    await this.api(`/api/v1/products/by-sku/${encodeURIComponent(sku)}/`, { method: "DELETE" });
  }

  override async retrieveOrders(sinceIso: string): Promise<RemoteOrder[]> {
    const out: RemoteOrder[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ limit: "200", from: sinceIso });
      if (cursor) q.set("cursor", cursor);
      const res = await this.api<{
        meta?: { cursor?: string; has_more?: boolean };
        data?: {
          purchase_id: string;
          created_at?: string;
          buyer_shipping_price?: string;
          line_items?: { sku?: string; sold_price?: string }[];
          seller_fee_breakdown?: { amount?: string }[];
        }[];
      }>(`/api/v1/orders/?${q}`);
      for (const order of res.data ?? []) {
        const items = (order.line_items ?? []).filter((li) => li.sku);
        const fees = (order.seller_fee_breakdown ?? []).reduce((s, f) => s + Math.round(parseFloat(f.amount ?? "0") * 100), 0);
        const total = items.reduce((s, li) => s + parseFloat(li.sold_price ?? "0"), 0) || 1;
        items.forEach((li, i) => {
          const price = parseFloat(li.sold_price ?? "0");
          out.push({
            externalOrderId: order.purchase_id,
            sku: li.sku!,
            quantity: 1,
            salePriceCents: Math.round(price * 100),
            shippingChargedCents: i === 0 ? Math.round(parseFloat(order.buyer_shipping_price ?? "0") * 100) : 0,
            feesCents: order.seller_fee_breakdown ? Math.round(fees * (price / total)) : null,
            soldAt: order.created_at ?? sinceIso,
          });
        });
      }
      if (!res.meta?.has_more || !res.meta.cursor) break;
      cursor = res.meta.cursor;
    }
    return out;
  }

  /** Depop reports likes, bag adds and open offers. It does not report impressions or views through this endpoint. */
  override async retrieveAnalytics(_externalId: string, sku: string): Promise<RemoteMetrics | null> {
    const r = await this.api<{ likes_count?: number; bag_count?: number; offers?: { awaiting_seller_review_count?: number } }>(`/api/v1/insights/products/by-sku/${encodeURIComponent(sku)}/live/`);
    return { impressions: null, views: null, watchers: r.bag_count ?? null, likes: r.likes_count ?? null, offers: r.offers?.awaiting_seller_review_count ?? null };
  }

  /** Depop's price prediction and similar SOLD items for a prospective listing (US and GB only). */
  async pricingInspiration(input: { description: string; productType: string; department: string; condition: string; brandName: string; country: string; currency: string }) {
    return this.api<{
      price_prediction?: { lower_bound?: string; prediction?: string; upper_bound?: string };
      similar_sold_items?: { brand_name?: string; condition?: string; sold_price_amount?: string; sold_price_currency?: string }[];
    }>("/api/v1/pricing/inspiration/", {
      method: "POST",
      body: { description: input.description, country: input.country, currency: input.currency, product_type: input.productType, department: input.department, condition: input.condition, brand_name: input.brandName },
    });
  }
}
