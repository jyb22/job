import { describe, expect, it } from "vitest";
import { PermanentError, RateLimitError } from "../src/core/util";
import type { ListingPayload } from "../src/marketplaces/adapter";
import { AssistedAdapter } from "../src/marketplaces/assisted";
import { DepopAdapter } from "../src/marketplaces/depop";
import { EbayAdapter } from "../src/marketplaces/ebay";
import { httpJson } from "../src/marketplaces/http";
import { SPECS } from "../src/marketplaces/specs";
import { MARKETPLACES } from "../src/core/types";
import { marketplaceStatus } from "../src/app";
import { makeApp } from "./helpers";

// These tests check the eBay and Depop adapters against a FAKE HTTP layer:
// that requests have the shape the official documentation describes and that
// responses and errors are handled correctly. They do not — and cannot —
// prove the adapters work against the real services.

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(routes: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    const call: Call = { method: init?.method ?? "GET", url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body };
    calls.push(call);
    const r = routes(call) ?? { status: 404, body: { error: "no route" } };
    return new Response(r.status === 204 || r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { impl, calls };
}

const payload = (extra: Partial<ListingPayload> = {}): ListingPayload => ({
  sku: "RS-2611-000001",
  idempotencyKey: "RS-2611-000001:ebay:lst_1",
  title: "Nike Sportswear Club Tee T-Shirt Men's Size M Black",
  description: "Nike tee. Condition: Excellent.",
  priceCents: 2200,
  quantity: 1,
  currency: "USD",
  category: { categoryId: null, categoryName: "Men > Tops > T-shirt", source: "static" },
  condition: "excellent",
  conditionNotes: "Light fading on the collar",
  brand: "Nike",
  size: "M",
  color: "black",
  material: "100% cotton",
  department: "menswear",
  productType: "t-shirt",
  keywords: ["nike"],
  imagePaths: ["/data/a.jpg"],
  imageUrls: ["https://shop.example.test/public/img/img_1.jpg?s=sig"],
  shipping: { payer: "buyer", buyerChargeCents: 500 },
  location: { countryCode: "US", state: "NY" },
  extra: {},
  ...extra,
});

describe("HTTP error handling", () => {
  it("429 becomes a rate-limit error that carries Retry-After", async () => {
    const { impl } = fakeFetch(() => ({ status: 429, body: { error: "TOO_MANY_REQUESTS" }, headers: { "retry-after": "37" } }));
    const err: any = await httpJson("https://api.example.test/x", { fetchImpl: impl }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(37);
  });
  it("4xx is permanent, 5xx is retryable, and error text is redacted", async () => {
    const bad = fakeFetch(() => ({ status: 400, body: { message: "bad", access_token: "tok_abcdefgh12345678" } }));
    const e400: any = await httpJson("https://api.example.test/x", { fetchImpl: bad.impl }).catch((e) => e);
    expect(e400).toBeInstanceOf(PermanentError);
    expect(e400.message).not.toContain("tok_abcdefgh12345678");
    const down = fakeFetch(() => ({ status: 503, body: { message: "unavailable" } }));
    const e503 = await httpJson("https://api.example.test/x", { fetchImpl: down.impl }).catch((e) => e);
    expect(e503).not.toBeInstanceOf(PermanentError);
    expect(e503).not.toBeInstanceOf(RateLimitError);
  });
});

describe("eBay adapter (against a fake HTTP layer)", () => {
  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const app = makeApp();
    const fake = fakeFetch((c) => {
      if (c.url.endsWith("/identity/v1/oauth2/token")) return { body: { access_token: "user-token-1", expires_in: 7200, refresh_token: "refresh-1" } };
      return routes(c);
    });
    const adapter = new EbayAdapter({ env: "sandbox", clientId: "app-id", clientSecret: "app-secret", ruName: "My-RuName", fetchImpl: fake.impl }, app.connections);
    app.connections.saveCredentials("ebay", { refreshToken: "refresh-1" });
    app.connections.setAccount("ebay", { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1", merchantLocationKey: "LOC1" });
    return { app, adapter, ...fake };
  }

  it("builds the consent URL with the documented scopes", () => {
    const { adapter } = setup(() => undefined);
    const url = new URL(adapter.authorizeUrl("state-123"));
    expect(url.origin).toBe("https://auth.sandbox.ebay.com");
    expect(url.searchParams.get("redirect_uri")).toBe("My-RuName");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toContain("https://api.ebay.com/oauth/api_scope/sell.inventory");
  });

  it("exchanges the authorisation code and stores tokens encrypted", async () => {
    const { app, adapter, calls } = setup(() => undefined);
    await adapter.completeAuthorization("the-code");
    const token = calls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(token.body).toMatchObject({ grant_type: "authorization_code", code: "the-code", redirect_uri: "My-RuName" });
    expect(token.headers.Authorization).toBe("Basic " + Buffer.from("app-id:app-secret").toString("base64"));
    const raw = app.db.prepare("SELECT credentials_enc FROM marketplace_connections WHERE marketplace = 'ebay'").get() as { credentials_enc: string };
    expect(raw.credentials_enc).not.toContain("refresh-1");
  });

  it("creates the inventory item and offer, then publishes: sandbox host, SKU-keyed, correct bodies", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.url.includes("/get_category_suggestions")) return { body: { categorySuggestions: [{ category: { categoryId: "15687", categoryName: "T-Shirts" }, categoryTreeNodeAncestors: [{ categoryName: "Men's Clothing" }, { categoryName: "Clothing, Shoes & Accessories" }] }] } };
      if (c.method === "PUT" && c.url.includes("/inventory_item/")) return { status: 204 };
      if (c.method === "GET" && c.url.includes("/offer?sku=")) return { status: 404, body: { errors: [{ message: "not found" }] } };
      if (c.method === "POST" && c.url.endsWith("/sell/inventory/v1/offer")) return { body: { offerId: "OFFER-1" } };
      if (c.method === "POST" && c.url.endsWith("/offer/OFFER-1/publish")) return { body: { listingId: "110099887766" } };
      return undefined;
    });
    const created = await adapter.createListing(payload());
    expect(created).toEqual({ externalId: "OFFER-1", url: null, state: "draft" });
    const item = calls.find((c) => c.method === "PUT" && c.url.includes("/inventory_item/"))!;
    expect(item.url).toBe("https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item/RS-2611-000001");
    expect(item.headers).toMatchObject({ Authorization: "Bearer user-token-1", "Content-Language": "en-US" });
    expect(item.body).toMatchObject({ condition: "USED_EXCELLENT", conditionDescription: "Light fading on the collar", availability: { shipToLocationAvailability: { quantity: 1 } } });
    expect(item.body.product.aspects).toMatchObject({ Brand: ["Nike"], Size: ["M"], Color: ["black"], Department: ["Men"] });
    expect(item.body.product.imageUrls).toEqual(["https://shop.example.test/public/img/img_1.jpg?s=sig"]);
    const offer = calls.find((c) => c.method === "POST" && c.url.endsWith("/offer"))!;
    expect(offer.body).toMatchObject({
      sku: "RS-2611-000001", marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 1, categoryId: "15687",
      pricingSummary: { price: { value: "22.00", currency: "USD" } },
      listingPolicies: { fulfillmentPolicyId: "F1", paymentPolicyId: "P1", returnPolicyId: "R1" }, merchantLocationKey: "LOC1",
    });
    const live = await adapter.publishListing("OFFER-1");
    expect(live).toMatchObject({ state: "live", url: "https://sandbox.ebay.com/itm/110099887766" });
  });

  it("a retry updates the existing offer instead of creating a second one", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.url.includes("/get_category_suggestions")) return { body: { categorySuggestions: [{ category: { categoryId: "15687", categoryName: "T-Shirts" } }] } };
      if (c.method === "PUT") return { status: 204 };
      if (c.method === "GET" && c.url.includes("/offer?sku=")) return { body: { offers: [{ offerId: "OFFER-EXISTING", status: "UNPUBLISHED" }] } };
      return undefined;
    });
    const created = await adapter.createListing(payload());
    expect(created.externalId).toBe("OFFER-EXISTING");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/sell/inventory/v1/offer"))).toBe(false);
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/offer/OFFER-EXISTING"))).toBe(true);
  });

  it("refuses clearly when photos have no public URL or the account is not set up", async () => {
    const { adapter, app } = setup(() => ({ status: 204 }));
    await expect(adapter.createListing(payload({ imageUrls: [] }))).rejects.toThrow(/PUBLIC_BASE_URL/);
    app.connections.setAccount("ebay", {});
    await expect(adapter.createListing(payload())).rejects.toThrow(/setup is incomplete/);
  });

  it("refreshes an expired token once on 401, and marks the connection broken if that fails", async () => {
    let first = true;
    const ok = setup((c) => {
      if (c.url.includes("/offer/OFFER-1") && first) {
        first = false;
        return { status: 401, body: {} };
      }
      if (c.url.includes("/offer/OFFER-1")) return { body: { status: "PUBLISHED", availableQuantity: 1, listing: { listingId: "1", listingStatus: "ACTIVE" }, pricingSummary: { price: { value: "22.00" } } } };
      return undefined;
    });
    expect(await ok.adapter.retrieveListing("OFFER-1")).toMatchObject({ status: "active", quantity: 1, priceCents: 2200 });
    expect(ok.calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(2);

    const broken = setup((c) => (c.url.includes("/offer/") ? { status: 401, body: {} } : undefined));
    await expect(broken.adapter.retrieveListing("OFFER-1")).rejects.toThrow(/reconnect/);
    expect(broken.app.connections.get("ebay").status).toBe("disconnected");
  });

  it("ends a listing by withdrawing the offer, and treats 'already ended' as success", async () => {
    const a = setup((c) => (c.url.endsWith("/offer/OFFER-1/withdraw") ? { body: { listingId: "1" } } : undefined));
    await a.adapter.endListing("OFFER-1");
    expect(a.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.sandbox.ebay.com/sell/inventory/v1/offer/OFFER-1/withdraw" });
    const b = setup(() => ({ status: 400, body: { errors: [{ errorId: 25002, message: "Offer is not published" }] } }));
    await expect(b.adapter.endListing("OFFER-1")).resolves.toBeUndefined();
  });

  it("reads orders with line items, shipping and marketplace fees", async () => {
    const { adapter, calls } = setup((c) =>
      c.url.includes("/sell/fulfillment/v1/order")
        ? { body: { orders: [{ orderId: "12-34567-89012", creationDate: "2026-11-09T10:00:00.000Z", totalMarketplaceFee: { value: "3.32" }, lineItems: [{ sku: "RS-2611-000001", quantity: 1, lineItemCost: { value: "22.00" }, deliveryCost: { shippingCost: { value: "5.00" } } }] }] } }
        : undefined,
    );
    const orders = await adapter.retrieveOrders("2026-11-01T00:00:00.000Z");
    expect(orders).toEqual([{ externalOrderId: "12-34567-89012", sku: "RS-2611-000001", quantity: 1, salePriceCents: 2200, shippingChargedCents: 500, feesCents: 332, soldAt: "2026-11-09T10:00:00.000Z" }]);
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain("filter=creationdate:[2026-11-01T00:00:00.000Z..]");
  });

  it("passes a rate limit through to the job queue", async () => {
    const { adapter } = setup(() => ({ status: 429, body: {}, headers: { "retry-after": "12" } }));
    await expect(adapter.retrieveListing("OFFER-1")).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("Depop adapter (against a fake HTTP layer)", () => {
  function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const app = makeApp();
    const fake = fakeFetch(routes);
    app.connections.saveCredentials("depop", { apiKey: "pak_test_key" });
    return { app, adapter: new DepopAdapter({ env: "staging", fetchImpl: fake.impl }, app.connections), ...fake };
  }
  const depopPayload = (extra: Partial<ListingPayload> = {}) => payload({ category: { categoryId: "tshirts", categoryName: "menswear / tshirts", source: "static" }, ...extra });

  it("upserts by SKU with the documented body on the staging host", async () => {
    const { adapter, calls } = setup(() => ({ body: { product_id: 7238212, slug: "nike-tee-abc", sku: "RS-2611-000001" } }));
    const created = await adapter.createListing(depopPayload({ extra: { depop_size_set_id: "52", depop_size_id: "10" } }));
    expect(created).toEqual({ externalId: "7238212", url: "https://www.depop.com/products/nike-tee-abc/", state: "live" });
    const call = calls[0]!;
    expect(call).toMatchObject({ method: "PUT", url: "https://partnerapi-staging.depop.com/api/v1/products/by-sku/RS-2611-000001/" });
    expect(call.headers.Authorization).toBe("Bearer pak_test_key");
    expect(call.body).toMatchObject({
      address: { country_code: "US", state: "NY" }, price_currency: "USD", price_amount: "22.00", quantity: 1, department: "menswear", product_type: "tshirts",
      condition: "used_excellent", colour: ["black"], brand_name: "Nike", attributes: {}, size_set_id: 52, size_id: 10, national_shipping_cost: "5.00",
      pictures: [{ url: "https://shop.example.test/public/img/img_1.jpg?s=sig" }],
    });
  });

  it("truncates descriptions to Depop's 1,000 characters and caps photos at eight", async () => {
    const { adapter, calls } = setup(() => ({ body: { product_id: 1 } }));
    await adapter.createListing(depopPayload({ description: "x".repeat(1500), imageUrls: Array.from({ length: 12 }, (_, i) => `https://shop.example.test/${i}.jpg`) }));
    expect(calls[0]!.body.description).toHaveLength(1000);
    expect(calls[0]!.body.pictures).toHaveLength(8);
  });

  it("refuses clearly without a key, public photo URLs or a mapped product type", async () => {
    const { adapter, app } = setup(() => ({ body: {} }));
    await expect(adapter.createListing(depopPayload({ imageUrls: [] }))).rejects.toThrow(/PUBLIC_BASE_URL/);
    await expect(adapter.createListing(payload())).rejects.toThrow(/No Depop product type/);
    app.connections.saveCredentials("depop", null);
    await expect(adapter.createListing(depopPayload())).rejects.toThrow(/API key is not configured/);
  });

  it("sold elsewhere → mark-as-sold; removed by the operator → delete", async () => {
    const { adapter, calls } = setup(() => ({ status: 200 }));
    await adapter.endListing("7238212", "RS-2611-000001", "sold_elsewhere");
    await adapter.endListing("7238212", "RS-2611-000001", "operator");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /api/v1/products/by-sku/RS-2611-000001/mark-as-sold/", "DELETE /api/v1/products/by-sku/RS-2611-000001/"]);
  });

  it("maps Depop's product statuses", async () => {
    const statuses: [string, string][] = [["STATUS_ONSALE", "active"], ["STATUS_PURCHASED", "sold"], ["STATUS_MARKED_AS_SOLD", "sold"], ["STATUS_DELETED", "ended"], ["STATUS_PRODUCT_BANNED_ONSALE", "ended"]];
    for (const [remote, expected] of statuses) {
      const { adapter } = setup(() => ({ body: { status: remote, quantity: 1, slug: "s" } }));
      expect((await adapter.retrieveListing("1", "RS-1"))?.status, remote).toBe(expected);
    }
    const missing = setup(() => ({ status: 404, body: { errors: [{ code: "product_not_found" }] } }));
    expect(await missing.adapter.retrieveListing("1", "RS-1")).toBeNull();
  });

  it("reads orders with Depop's real fee breakdown and follows the cursor", async () => {
    let page = 0;
    const { adapter, calls } = setup(() => {
      page++;
      if (page === 1) return { body: { meta: { cursor: "c2", has_more: true }, data: [{ purchase_id: "435017619960", created_at: "2026-11-09T09:00:00Z", buyer_shipping_price: "3.50", line_items: [{ sku: "RS-2611-000001", sold_price: "25.99" }], seller_fee_breakdown: [{ fee_type: "PAYMENT_FEE", amount: "1.16" }, { fee_type: "DEPOP_FEE", amount: "2.95" }] }] } };
      return { body: { meta: { has_more: false }, data: [] } };
    });
    const orders = await adapter.retrieveOrders("2026-11-01T00:00:00.000Z");
    expect(orders).toEqual([{ externalOrderId: "435017619960", sku: "RS-2611-000001", quantity: 1, salePriceCents: 2599, shippingChargedCents: 350, feesCents: 411, soldAt: "2026-11-09T09:00:00Z" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("cursor=c2");
  });

  it("reports only the metrics Depop provides; the rest stay unknown", async () => {
    const { adapter } = setup(() => ({ body: { likes_count: 34, bag_count: 12, offers: { awaiting_seller_review_count: 3 } } }));
    expect(await adapter.retrieveAnalytics("1", "RS-1")).toEqual({ impressions: null, views: null, watchers: 12, likes: 34, offers: 3 });
  });

  it("a rejected key marks the connection disconnected", async () => {
    const { adapter, app } = setup(() => ({ status: 401, body: {} }));
    await expect(adapter.retrieveListing("1", "RS-1")).rejects.toThrow(/rejected the API key/);
    expect(app.connections.get("depop").status).toBe("disconnected");
  });
});

describe("integration honesty", () => {
  it("assisted adapters claim no capabilities and never pretend to publish", async () => {
    const adapter = new AssistedAdapter("mercari");
    expect(Object.values(adapter.capabilities).every((v) => v === false)).toBe(true);
    expect(await adapter.createListing(payload())).toMatchObject({ state: "awaiting_operator" });
    await expect(adapter.endListing()).rejects.toThrow(/does not support/);
    await expect(adapter.retrieveOrders("2026-01-01")).rejects.toThrow(/does not support/);
  });

  it("every marketplace starts in assisted mode: nothing is live or simulated until the operator chooses", () => {
    const app = makeApp();
    const status = marketplaceStatus(app);
    expect(status.map((s) => s.mode)).toEqual(MARKETPLACES.map(() => "assisted"));
    expect(status.every((s) => s.simulated === false)).toBe(true);
  });

  it("only eBay and Depop offer an API mode; the simulated adapter always identifies itself", () => {
    const app = makeApp();
    for (const m of MARKETPLACES) {
      expect(app.adapters.hasApiAdapter(m), m).toBe(m === "ebay" || m === "depop");
      expect(app.adapters.sim(m).simulated).toBe(true);
    }
    app.connections.setMode("mercari", "api");
    expect(() => app.adapters.get("mercari")).toThrow(/no API integration/);
    expect(SPECS.mercari.integration).toBe("assisted_only");
    expect(SPECS.etsy.restrictedTo).toMatch(/vintage/i);
  });

  it("a real API connection is labelled unverified until it has been validated", () => {
    const app = makeApp();
    app.connections.setMode("ebay", "api", "sandbox");
    expect(app.connections.get("ebay").status).toBe("unverified");
  });
});
