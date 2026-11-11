# Marketplaces

What each marketplace actually lets software do, as researched in November 2026 from official developer documentation, and how each is handled here.

## Summary

| Marketplace | Official seller API? | Mode here | Publish | End after sale | Detect sales | Metrics |
| --- | --- | --- | --- | --- | --- | --- |
| eBay | Yes — public developer program | API (unverified) or assisted | Automatic | Automatic | Polls orders API | Not collected |
| Depop | Yes — partner access by approval | API (unverified) or assisted | Automatic | Automatic (mark-as-sold) | Polls orders API | Likes, bag adds, offers |
| Mercari (US) | No public API | Assisted | You post | You end (urgent task) | You record it, or signed webhook | None |
| Poshmark | No public API | Assisted | You post | You end (urgent task) | You record it, or signed webhook | None |
| Facebook Marketplace | No listing API for individual sellers | Assisted | You post | You end (urgent task) | You record it, or signed webhook | None |
| Etsy | Yes (Open API v3) — adapter not built | Assisted | You post | You end (urgent task) | You record it, or signed webhook | None |

Every marketplace starts in **assisted** mode. Nothing is sent anywhere until you change that.

**Assisted mode** means: the app does not sign in to, script, scrape or automate the marketplace's website or app in any way. It prepares a validated listing (title, description, price, category, photos), opens a task in the Review queue, and you post it and paste the link back. When the item sells elsewhere, you get an urgent task to end it. This is slower than an API, and it is the only approach that does not put your account at risk on platforms that do not offer one.

**Simulated mode** is a fake marketplace stored in the local database, for demos and tests. Everything it produces is labelled "Simulated" and is kept out of your real totals. An item identified or priced from simulated data cannot be published to a non-simulated marketplace.

## eBay

**Status: implemented from documentation, never run against eBay.**

APIs used (all official REST): Sell Inventory (inventory items, offers, publish, withdraw, bulk price/quantity), Sell Fulfillment (orders), Sell Account (business policies), Commerce Taxonomy (category suggestions, item aspects), Buy Browse (active listings, for research). Authentication is OAuth 2.0 authorization-code grant; the refresh token is stored encrypted.

Limits and restrictions to know:

- Default call limits are sized for small sellers (for example 5,000 calls/day on the Offer API); higher limits need eBay's Application Growth Check. The adapter honours HTTP 429 and `Retry-After`.
- **Sold prices:** the Marketplace Insights API is restricted to partners eBay approves. Without it there is no official way to read eBay sold prices. If you enable it without access, the lookup fails and is reported as such.
- Your eBay account must be opted in to business policies and have at least one fulfillment, payment and return policy, plus an inventory location. "Validate connection" checks this.
- eBay fetches photos by URL, so this server must be reachable from the internet (`PUBLIC_BASE_URL`).

To connect:

1. Create an application at https://developer.ebay.com/my/keys (start with **Sandbox** keys).
2. Under "User Tokens" create a redirect URL name (RuName) whose accepted URL is `https://<your-host>/api/connections/ebay/callback`.
3. Put `EBAY_ENV=sandbox`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` and `PUBLIC_BASE_URL` in `.env`; restart.
4. Settings → Marketplaces → eBay → set "Official API", then **Connect eBay account**. You approve access on eBay's own page; no password is entered into this app.
5. **Validate connection.** Then publish one sandbox listing and check it appears in the eBay sandbox before switching `EBAY_ENV` to `production`.

## Depop

**Status: implemented from Depop's OpenAPI specification, never run against Depop.**

Depop's Selling API (https://partnerapi.depop.com/api-docs/) is real and documented, but access is not self-serve: you contact Depop and they issue a testing key, then a production key. The adapter uses a per-shop API key (`Authorization: Bearer pak_…`).

Used: create/update by SKU (`PUT /api/v1/products/by-sku/{sku}/` — an upsert, so retries cannot duplicate), mark-as-sold (what Depop asks you to call when an item sells elsewhere), delete, get by SKU, orders (with Depop's real fee breakdown), live insights, pricing inspiration (similar sold items).

Limits and gaps:

- **Sizes.** Depop needs `size_set_id` and `size_id` for sized items, from its taxonomy. A lookup is not implemented; set product attributes `depop_size_set_id` and `depop_size_id` by hand, or Depop will reject the listing.
- Descriptions are capped at 1,000 characters, photos at 8, and photos must be public HTTPS URLs (`PUBLIC_BASE_URL`).
- Depop has no separate title: the first line of the description acts as one.
- Depop's webhooks are not consumed; orders are polled on the schedule in Settings.

To connect: obtain a key from Depop, set `DEPOP_ENV=staging`, Settings → Marketplaces → Depop → "Official API", paste the key (stored encrypted), **Validate connection**, publish one staging listing, then move to production.

## Reporting sales from marketplaces without an API

Two accepted routes; both result in the same atomic inventory update and cross-delisting:

1. **Sales → Record a sale** in the dashboard (owner or manager).
2. **Signed webhook**, for automation tools (for example, something that parses the marketplace's "you made a sale" email):

```bash
BODY='{"marketplace":"mercari","externalOrderId":"M123","sku":"RS-2611-000001","quantity":1,"salePriceCents":4200}'
```

```bash
curl -X POST https://your-host/api/webhooks/sale -H "Content-Type: application/json" -H "X-Signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SALE_WEBHOOK_SECRET" -hex | sed 's/^.* //')" -d "$BODY"
```

Unsigned or wrongly signed requests are rejected and logged. The same order sent twice is recorded once.

## Fees

Default fee schedules (Settings → Marketplaces → Fees) are starting points taken from publicly reported figures, which disagreed with each other when this was written — particularly for Depop and Mercari. Each schedule is marked unverified until you tick "I have checked these". Where a marketplace reports its actual fee with the order (Depop and eBay through their APIs), that real figure is used and the sale is marked "verified"; otherwise the fee is estimated and marked "est." everywhere it appears.

## Adding a marketplace

Implement `MarketplaceAdapter` (`src/marketplaces/adapter.ts`), declare honest `capabilities`, add a spec to `src/marketplaces/specs.ts` and a case to `AdapterRegistry.get`. Nothing else changes: the pipeline, policy engine, sales and reconciliation code only talk to the interface.

Sources: [Depop Selling API docs](https://partnerapi.depop.com/api-docs/), [Depop API reference](https://partnerapi.depop.com/api-docs/reference/), [eBay Inventory API](https://developer.ebay.com/develop/api/sell/inventory_api.md), [eBay API call limits](https://developer.ebay.com/develop/get-started/api-call-limits), [eBay createOffer](https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/createOffer).

For Mercari (US), Poshmark and Facebook Marketplace, "no public API" means that a search of their developer and help sites in November 2026 found no documented seller API. Their terms of service were not reviewed line by line; read them yourself before using any third-party automation with those accounts.
