import { PermanentError } from "../core/util";
import { BaseAdapter, type AccountInfo, type AdapterCapabilities, type CreateResult, type ListingPayload, type RemoteListing, type RemoteOrder } from "./adapter";
import type { ConnectionStore } from "./connections";
import { httpJson, HttpStatusError } from "./http";
import { EBAY_CONDITION, type CategoryMapping } from "./specs";

// eBay adapter — official REST APIs only:
//   Sell Inventory API   (inventory items, offers, publish, withdraw, price/quantity)
//   Sell Fulfillment API (orders)
//   Sell Account API     (business policies)
//   Commerce Taxonomy    (category suggestions, item aspects)
// Auth: OAuth 2.0 authorization-code grant; the user's refresh token is stored encrypted.
//
// STATUS: implemented from eBay's published API documentation. It has NOT
// been exercised against an eBay sandbox or production account from this
// codebase, because no eBay developer keys were available when it was
// written. Treat it as unverified until "Validate connection" succeeds and a
// sandbox listing has been published end to end.

export interface EbayConfig {
  env: "sandbox" | "production";
  clientId?: string;
  clientSecret?: string;
  ruName?: string;
  fetchImpl?: typeof fetch;
}

interface EbayCredentials extends Record<string, unknown> {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];

const MARKETPLACE_ID = "EBAY_US";

export function ebayHosts(env: "sandbox" | "production") {
  return env === "production"
    ? { api: "https://api.ebay.com", auth: "https://auth.ebay.com", web: "https://www.ebay.com" }
    : { api: "https://api.sandbox.ebay.com", auth: "https://auth.sandbox.ebay.com", web: "https://sandbox.ebay.com" };
}

/** Application (client-credentials) token for public-data APIs such as Taxonomy and Browse. */
export class EbayAppAuth {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private cfg: EbayConfig) {}

  configured(): boolean {
    return !!(this.cfg.clientId && this.cfg.clientSecret);
  }

  basicAuth(): string {
    return "Basic " + Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
  }

  async appToken(scope = "https://api.ebay.com/oauth/api_scope"): Promise<string> {
    if (!this.configured()) throw new PermanentError("eBay API keys are not configured (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)");
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await httpJson<{ access_token: string; expires_in: number }>(`${ebayHosts(this.cfg.env).api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: this.basicAuth() },
      form: { grant_type: "client_credentials", scope },
      fetchImpl: this.cfg.fetchImpl,
    });
    this.token = { value: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
    return res.access_token;
  }
}

export class EbayAdapter extends BaseAdapter {
  readonly marketplace = "ebay" as const;
  readonly mode = "api" as const;
  readonly capabilities: AdapterCapabilities = {
    createListing: true, updateListing: true, endListing: true, deleteListing: false, retrieveListing: true,
    retrieveInventory: false, updateInventory: true, retrieveOrders: true, retrieveFees: false, retrieveAnalytics: false, categoryLookup: true,
  };
  private appAuth: EbayAppAuth;

  constructor(
    private cfg: EbayConfig,
    private connections: ConnectionStore,
  ) {
    super();
    this.appAuth = new EbayAppAuth(cfg);
  }

  private get hosts() {
    return ebayHosts(this.cfg.env);
  }

  /** URL the operator visits to grant this app access to their eBay account. */
  authorizeUrl(state: string): string {
    if (!this.cfg.clientId || !this.cfg.ruName) throw new PermanentError("EBAY_CLIENT_ID and EBAY_RU_NAME must be set to connect eBay");
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: this.cfg.ruName, response_type: "code", scope: EBAY_SCOPES.join(" "), state });
    return `${this.hosts.auth}/oauth2/authorize?${q}`;
  }

  /** Exchange the authorization code from the OAuth redirect for tokens and store them encrypted. */
  async completeAuthorization(code: string): Promise<void> {
    const res = await httpJson<{ access_token: string; expires_in: number; refresh_token: string }>(`${this.hosts.api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: this.appAuth.basicAuth() },
      form: { grant_type: "authorization_code", code, redirect_uri: this.cfg.ruName ?? "" },
      fetchImpl: this.cfg.fetchImpl,
    });
    this.connections.saveCredentials("ebay", { refreshToken: res.refresh_token, accessToken: res.access_token, accessTokenExpiresAt: Date.now() + res.expires_in * 1000 });
  }

  private async userToken(forceRefresh = false): Promise<string> {
    const creds = this.connections.credentials<EbayCredentials>("ebay");
    if (!creds?.refreshToken) throw new PermanentError("eBay is not connected. Connect your eBay account in Settings → Marketplaces.");
    if (!forceRefresh && creds.accessToken && (creds.accessTokenExpiresAt ?? 0) > Date.now() + 60_000) return creds.accessToken;
    const res = await httpJson<{ access_token: string; expires_in: number }>(`${this.hosts.api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: this.appAuth.basicAuth() },
      form: { grant_type: "refresh_token", refresh_token: creds.refreshToken, scope: EBAY_SCOPES.join(" ") },
      fetchImpl: this.cfg.fetchImpl,
    });
    this.connections.saveCredentials("ebay", { ...creds, accessToken: res.access_token, accessTokenExpiresAt: Date.now() + res.expires_in * 1000 });
    return res.access_token;
  }

  private async api<T>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
    const token = await this.userToken(retried);
    try {
      return await httpJson<T>(`${this.hosts.api}${path}`, {
        method: opts.method,
        body: opts.body,
        headers: { Authorization: `Bearer ${token}`, "Content-Language": "en-US", "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID },
        fetchImpl: this.cfg.fetchImpl,
      });
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 401 && !retried) return this.api<T>(path, opts, true);
      if (error instanceof HttpStatusError && error.status === 401) {
        this.connections.setStatus("ebay", "disconnected", "eBay rejected the stored authorisation; reconnect the account.");
        throw new PermanentError("eBay rejected the stored authorisation; reconnect the account.");
      }
      throw error;
    }
  }

  override async authenticate(): Promise<void> {
    await this.userToken();
  }

  async validateConnection() {
    try {
      const info = await this.getAccountInformation();
      const missing = ["fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "merchantLocationKey"].filter((k) => !info.detail?.[k]);
      if (missing.length) return { ok: false, message: `Connected, but the eBay account is missing: ${missing.join(", ")}. Create business policies and an inventory location in eBay first.` };
      return { ok: true, message: `Connected to eBay (${this.cfg.env}).` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  /** Reads the business policies and inventory location that every offer must reference, and caches them on the connection. */
  override async getAccountInformation(): Promise<AccountInfo> {
    const first = async (path: string, key: string, idKey: string) => {
      const res = await this.api<Record<string, Record<string, string>[]>>(path);
      return res[key]?.[0]?.[idKey] ?? null;
    };
    const detail = {
      fulfillmentPolicyId: await first(`/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`, "fulfillmentPolicies", "fulfillmentPolicyId"),
      paymentPolicyId: await first(`/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`, "paymentPolicies", "paymentPolicyId"),
      returnPolicyId: await first(`/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`, "returnPolicies", "returnPolicyId"),
      merchantLocationKey: await first("/sell/inventory/v1/location", "locations", "merchantLocationKey"),
    };
    const saved = this.connections.get("ebay").account;
    // Operator-chosen values in the saved account take precedence over "first one found".
    const merged = { ...detail, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => v)) };
    this.connections.setAccount("ebay", merged);
    return { id: null, name: `eBay (${this.cfg.env})`, detail: merged };
  }

  override async getCategories(query: string): Promise<CategoryMapping[]> {
    const token = await this.appAuth.appToken();
    const res = await httpJson<{ categorySuggestions?: { category: { categoryId: string; categoryName: string }; categoryTreeNodeAncestors?: { categoryName: string }[] }[] }>(
      `${this.hosts.api}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` }, fetchImpl: this.cfg.fetchImpl },
    );
    return (res.categorySuggestions ?? []).map((s) => ({
      categoryId: s.category.categoryId,
      categoryName: [...(s.categoryTreeNodeAncestors ?? []).map((a) => a.categoryName).reverse(), s.category.categoryName].join(" > "),
      source: "live" as const,
    }));
  }

  override async getCategoryAttributes(categoryId: string) {
    const token = await this.appAuth.appToken();
    const res = await httpJson<{ aspects?: { localizedAspectName: string; aspectConstraint?: { aspectRequired?: boolean }; aspectValues?: { localizedValue: string }[] }[] }>(
      `${this.hosts.api}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
      { headers: { Authorization: `Bearer ${token}` }, fetchImpl: this.cfg.fetchImpl },
    );
    return (res.aspects ?? []).map((a) => ({ name: a.localizedAspectName, required: !!a.aspectConstraint?.aspectRequired, values: (a.aspectValues ?? []).slice(0, 50).map((v) => v.localizedValue) }));
  }

  private inventoryItem(p: ListingPayload) {
    const aspects: Record<string, string[]> = {};
    const set = (name: string, value: string | null) => { if (value) aspects[name] = [value]; };
    set("Brand", p.brand ?? "Unbranded");
    set("Size", p.size);
    set("Color", p.color);
    set("Material", p.material);
    set("Department", p.department === "menswear" ? "Men" : p.department === "womenswear" ? "Women" : p.department === "kids" ? "Kids" : p.department === "unisex" ? "Unisex Adults" : null);
    set("Type", p.productType !== "other" ? p.productType : null);
    return {
      availability: { shipToLocationAvailability: { quantity: p.quantity } },
      condition: EBAY_CONDITION[p.condition],
      conditionDescription: p.conditionNotes ?? undefined,
      product: { title: p.title, description: p.description, aspects, imageUrls: p.imageUrls.slice(0, 24) },
    };
  }

  private async offerBody(p: ListingPayload) {
    const account = this.connections.get("ebay").account as Record<string, string | undefined>;
    for (const k of ["fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId", "merchantLocationKey"]) {
      if (!account[k]) throw new PermanentError(`eBay account setup is incomplete (${k}). Run "Validate connection" in Settings → Marketplaces.`);
    }
    let categoryId = p.category.source === "live" ? p.category.categoryId : null;
    if (!categoryId) categoryId = (await this.getCategories(p.title))[0]?.categoryId ?? null;
    if (!categoryId) throw new PermanentError("eBay did not suggest a category for this item; choose one manually.");
    return {
      sku: p.sku,
      marketplaceId: MARKETPLACE_ID,
      format: "FIXED_PRICE",
      availableQuantity: p.quantity,
      categoryId,
      listingDescription: p.description,
      listingPolicies: { fulfillmentPolicyId: account.fulfillmentPolicyId, paymentPolicyId: account.paymentPolicyId, returnPolicyId: account.returnPolicyId },
      pricingSummary: { price: { value: (p.priceCents / 100).toFixed(2), currency: p.currency } },
      merchantLocationKey: account.merchantLocationKey,
    };
  }

  private async findOffer(sku: string): Promise<{ offerId: string; status?: string; listing?: { listingId?: string } } | null> {
    try {
      const res = await this.api<{ offers?: { offerId: string; status?: string; listing?: { listingId?: string } }[] }>(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
      return res.offers?.[0] ?? null;
    } catch (error) {
      if (error instanceof PermanentError && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  async createListing(p: ListingPayload): Promise<CreateResult> {
    if (p.imageUrls.length === 0) throw new PermanentError("eBay needs public photo URLs. Set PUBLIC_BASE_URL so this server's photos are reachable.");
    // Both calls are keyed by SKU, so a retry after a crash updates rather than duplicates.
    await this.api(`/sell/inventory/v1/inventory_item/${encodeURIComponent(p.sku)}`, { method: "PUT", body: this.inventoryItem(p) });
    const body = await this.offerBody(p);
    const existing = await this.findOffer(p.sku);
    if (existing) {
      await this.api(`/sell/inventory/v1/offer/${existing.offerId}`, { method: "PUT", body });
      return { externalId: existing.offerId, url: existing.listing?.listingId ? `${this.hosts.web}/itm/${existing.listing.listingId}` : null, state: existing.status === "PUBLISHED" ? "live" : "draft" };
    }
    const created = await this.api<{ offerId: string }>("/sell/inventory/v1/offer", { method: "POST", body });
    return { externalId: created.offerId, url: null, state: "draft" };
  }

  override async publishListing(offerId: string): Promise<CreateResult> {
    const res = await this.api<{ listingId: string }>(`/sell/inventory/v1/offer/${offerId}/publish`, { method: "POST" });
    return { externalId: offerId, url: `${this.hosts.web}/itm/${res.listingId}`, state: "live" };
  }

  override async updateListing(offerId: string, p: ListingPayload): Promise<void> {
    await this.api(`/sell/inventory/v1/inventory_item/${encodeURIComponent(p.sku)}`, { method: "PUT", body: this.inventoryItem(p) });
    await this.api(`/sell/inventory/v1/offer/${offerId}`, { method: "PUT", body: await this.offerBody(p) });
  }

  override async retrieveListing(offerId: string): Promise<RemoteListing | null> {
    try {
      const o = await this.api<{ status?: string; availableQuantity?: number; listing?: { listingId?: string; listingStatus?: string }; pricingSummary?: { price?: { value?: string } } }>(`/sell/inventory/v1/offer/${offerId}`);
      const live = o.status === "PUBLISHED" && o.listing?.listingStatus !== "ENDED";
      return {
        externalId: offerId,
        url: o.listing?.listingId ? `${this.hosts.web}/itm/${o.listing.listingId}` : null,
        status: live ? ((o.availableQuantity ?? 0) > 0 ? "active" : "sold") : o.status === "UNPUBLISHED" ? "ended" : "unknown",
        quantity: o.availableQuantity ?? null,
        priceCents: o.pricingSummary?.price?.value ? Math.round(parseFloat(o.pricingSummary.price.value) * 100) : null,
      };
    } catch (error) {
      if (error instanceof PermanentError && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  override async updateInventory(offerId: string, sku: string, quantity: number): Promise<void> {
    await this.api("/sell/inventory/v1/bulk_update_price_quantity", {
      method: "POST",
      body: { requests: [{ sku, shipToLocationAvailability: { quantity }, offers: [{ offerId, availableQuantity: quantity }] }] },
    });
  }

  async endListing(offerId: string): Promise<void> {
    try {
      await this.api(`/sell/inventory/v1/offer/${offerId}/withdraw`, { method: "POST" });
    } catch (error) {
      // Withdrawing an offer that is already unpublished is the outcome we wanted.
      if (error instanceof PermanentError && /not.*published|already|25002|25713/i.test(error.message)) return;
      throw error;
    }
  }

  override async retrieveOrders(sinceIso: string): Promise<RemoteOrder[]> {
    const out: RemoteOrder[] = [];
    let path: string | null = `/sell/fulfillment/v1/order?filter=${encodeURIComponent(`creationdate:[${sinceIso}..]`)}&limit=200`;
    while (path) {
      const page: {
        next?: string;
        orders?: {
          orderId: string;
          creationDate: string;
          totalMarketplaceFee?: { value?: string };
          lineItems?: { sku?: string; quantity?: number; lineItemCost?: { value?: string }; deliveryCost?: { shippingCost?: { value?: string } } }[];
        }[];
      } = await this.api(path);
      for (const order of page.orders ?? []) {
        const items = (order.lineItems ?? []).filter((li) => li.sku);
        const fee = order.totalMarketplaceFee?.value ? Math.round(parseFloat(order.totalMarketplaceFee.value) * 100) : null;
        const total = items.reduce((s, li) => s + parseFloat(li.lineItemCost?.value ?? "0"), 0) || 1;
        for (const li of items) {
          const price = parseFloat(li.lineItemCost?.value ?? "0");
          out.push({
            externalOrderId: order.orderId,
            sku: li.sku!,
            quantity: li.quantity ?? 1,
            salePriceCents: Math.round(price * 100),
            shippingChargedCents: Math.round(parseFloat(li.deliveryCost?.shippingCost?.value ?? "0") * 100),
            feesCents: fee === null ? null : Math.round(fee * (price / total)),
            soldAt: order.creationDate,
          });
        }
      }
      path = page.next ? page.next.replace(this.hosts.api, "") : null;
    }
    return out;
  }
}
