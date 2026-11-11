# Status

Written 10 November 2026. This file separates what was **verified by running it** from what was only **written**.

## Verified by running

| What | How it was verified |
| --- | --- |
| Server starts, creates the owner account, serves the dashboard | Started locally; signed in through the browser |
| Dashboard: overview, add item by hand, item page, pricing, drafts, review queue, approve, "post by hand" task, sales, analytics, settings | Walked through in a browser against the running server |
| Photo upload and processing over the HTTP API | Uploaded two generated test photos; pipeline ran and drafted three listings |
| Recording a sale, profit calculation, drafts archived after sale | Through the HTTP API on the running server |
| The 18-step end-to-end scenario | `npm run demo` (simulated marketplaces, vision and comparables) |
| 253 automated tests | `npm test` — all passing |
| Types | `npm run typecheck` — clean for server and dashboard |

### Test coverage by required category

| Category | File |
| --- | --- |
| Product identification | `tests/workflow.test.ts` |
| Image processing | `tests/images-listings.test.ts` |
| Product duplication detection | `tests/images-listings.test.ts`, `tests/api.test.ts` |
| Listing content generation, claim guard | `tests/images-listings.test.ts` |
| Marketplace category mapping | `tests/images-listings.test.ts` |
| Sold-comparable pricing | `tests/pricing.test.ts` |
| Fee calculations | `tests/pricing.test.ts` |
| Minimum profit protection | `tests/pricing.test.ts`, `tests/policy.test.ts`, `tests/workflow.test.ts` |
| Listing publication | `tests/workflow.test.ts` |
| API authorization | `tests/api.test.ts` |
| Inventory updates | `tests/sales.test.ts` |
| Concurrent sale handling | `tests/sales.test.ts` (including two independent database connections) |
| Cross-platform delisting | `tests/sales.test.ts` |
| Job recovery | `tests/workflow.test.ts`, `tests/queue-security.test.ts` |
| Duplicate-event prevention | `tests/sales.test.ts`, `tests/api.test.ts` |
| Rate-limit management | `tests/workflow.test.ts`, `tests/queue-security.test.ts`, `tests/adapters.test.ts` |
| Security and authorization | `tests/policy.test.ts`, `tests/queue-security.test.ts`, `tests/api.test.ts` |
| Emergency stop | `tests/policy.test.ts`, `tests/workflow.test.ts`, `tests/api.test.ts`, `tests/sales.test.ts` |

Bugs the tests found and that were fixed: a stale approval could publish a listing whose price had since changed; publish requests deferred while paused were dropped instead of held; a prepared-but-never-posted listing was given an "end it" task instead of being cancelled; approvals stayed pending for drafts of an item that had sold.

## Written but NOT verified against the real service

These are implemented and unit-tested against fakes. None has been run against the real thing, because the credentials or tools did not exist on the build machine. Treat each as unproven until you have run it yourself.

| What | Why it is unverified | What to do |
| --- | --- | --- |
| eBay adapter (`src/marketplaces/ebay.ts`) | No eBay developer keys | Get sandbox keys, connect, "Validate connection", publish one sandbox listing end to end |
| Depop adapter (`src/marketplaces/depop.ts`) | Depop grants API access by approval only | Ask Depop for partner access and a testing key; run against staging |
| Claude vision and listing writer (`src/ai/anthropic.ts`) | No `ANTHROPIC_API_KEY` | Add a key and process one item; check the identification and that AI text passes the guard |
| eBay Browse / Marketplace Insights and Depop pricing research providers | Same as above; Marketplace Insights is restricted by eBay | Enable in Settings → AI and research once keys exist |
| Email delivery (SMTP) and outbound webhooks | No SMTP server configured | Set `SMTP_*`, enable email alerts, trigger one |
| Dockerfile and docker-compose.yml | Docker not installed | `docker compose up --build`, then run the tests inside the image |

## Not built

- **Etsy API adapter.** Etsy has an official API; only assisted mode exists here.
- **Depop size taxonomy lookup.** Depop requires `size_set_id` / `size_id` for sized items. These must currently be set by hand as product attributes `depop_size_set_id` and `depop_size_id`; without them Depop will reject sized items (reported as a failed publication).
- **Depop inbound webhooks.** Depop sales are picked up by polling its orders API. Its signed webhook format was not implemented.
- **eBay listing analytics.** The eBay adapter does not collect views/impressions. Depop provides likes, bag adds and open offers only.
- **Automatic listing metrics for assisted marketplaces.** There is no API to read them; you can enter them by hand via the API (`POST /api/listings/:id/metrics`), and there is no dashboard form for that yet.
- **Background removal / cleanup.** Photos are resized, re-oriented and compressed only.
- **Camera barcode scanning.** A UPC can be typed or imported; nothing scans one.
- **Folder import as such.** Selecting many files at once (or a folder's contents) in the upload dialog is the supported route.
- **AI rewriting of live listings by the optimiser.** The optimiser recommends changes and applies scheduled markdowns; it does not rewrite titles on its own.
- **"Significant profitability change" alerts.** The alert type exists in settings but nothing raises it yet.
- **Offer handling, refunds, label purchase.** Deliberately absent. The policy engine classifies them as always-human, and there is no code that performs them.
- **A separate message bus.** "Events" are durable jobs plus audit records in the database, not a pub/sub system.
- **PostgreSQL / Redis.** SQLite is used for both data and the job queue (see README, Assumptions).

## Phase summary

| Phase | State |
| --- | --- |
| 1 Repository inspection | Done — the folder was empty; no Node, Docker, Postgres or Redis on the machine |
| 2 Architecture and database | Done |
| 3 Core application | Done |
| 4 AI intelligence | Deterministic parts done and tested; the Claude calls are written but unverified |
| 5 Marketplace integrations | eBay and Depop adapters written, unverified live; assisted mode for the rest; simulated adapter for demos and tests |
| 6 Autonomous operations | Done; verified against the simulated marketplace |
| 7 Business intelligence | Done |
| 8 Testing and validation | 253 tests passing; end-to-end demo passing; browser walkthrough done |
| 9 Deployment | Docker files and docs written; image not built |
