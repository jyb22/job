# Architecture

One Node.js process serves the HTTP API, the built dashboard, and the background worker. State lives in one SQLite database plus a folder of photos.

```
web/ (React dashboard)  ──HTTP──▶  src/api/server.ts
                                        │
                                        ▼
   ┌──────────────────────────── services (src/*) ─────────────────────────────┐
   │ products · research · pricing · listings · approvals · sales · reconcile   │
   │ optimizer · analytics · notifications · auth                               │
   └───────┬──────────────────────┬───────────────────────┬────────────────────┘
           │                      │                       │
     policy engine           job queue              marketplace adapters
   (src/policy/engine.ts)  (src/jobs/queue.ts)   (src/marketplaces/*: ebay, depop,
     pure, deterministic     durable, in DB        assisted, simulated)
           │                      │                       │
           └───────────── SQLite (migrations/*.sql) ──────┘        AI provider (src/ai/*)
```

## Modules

| Path | Responsibility |
| --- | --- |
| `src/app.ts` | Builds the context, registers job handlers, runs the recurring schedule |
| `src/api/server.ts` | HTTP routes, sessions, roles, request validation, security headers |
| `src/inventory/products.ts` | Products, SKUs, photos, duplicate detection, risk flags, workflow stage records |
| `src/images/process.ts` | Resize, orient, compress, sharpness, perceptual hash. Originals are never modified |
| `src/ai/` | `AiProvider` interface; Claude implementation; simulated and "none" providers |
| `src/research/service.ts` | Comparable providers, similarity scoring, stored recommendations |
| `src/pricing/` | Fees, profit, break-even, recommendation, markdown schedule — pure functions |
| `src/listings/` | Template writer, AI claim guard, validation, quality score, publish/end/reprice/edit, operator tasks |
| `src/policy/engine.ts` | The only place that decides whether an action may execute |
| `src/approvals/service.ts` | Human approval queue, fingerprints, expiry |
| `src/marketplaces/` | Adapter interface, per-marketplace specs, adapters, connection store, registry |
| `src/inventory/sales.ts` | Atomic sale recording, reservations, order polling, cross-delist kick-off |
| `src/inventory/reconcile.ts` | Compares local state with marketplaces; records discrepancies |
| `src/workflow/pipeline.ts` | The staged product workflow |
| `src/optimize/engine.ts` | Metrics collection, markdown proposals, recommendations, before/after evaluation |
| `src/analytics/service.ts` | Overview, per-marketplace/category/product profit, aging, velocity, reports |
| `src/notifications/service.ts` | In-app alerts, email, webhook; redaction |
| `src/security/` | Encryption, password hashing, redaction, untrusted-text handling |

## How an action is authorised

Every write — whether the agent proposes it or a person clicks it — goes through `authorize()` in `src/policy/engine.ts`:

1. It is a pure function of the action, a handful of facts read from the database (price, floor, quality score, confidence, risk flags), and the operator's settings.
2. It takes no free text and calls no model. Nothing written by an AI, and nothing found in a photo, a spreadsheet cell or a marketplace response, can alter its result.
3. It returns `allow`, `needs_approval`, `defer` (paused / too soon) or `deny`, with reasons. The decision is written to the audit log.
4. Financial actions and deletions always return `needs_approval`; account-security actions are denied to the agent outright. These lists are constants in the code, not settings.
5. Authorisation is checked twice for publishing: when requested, and again when the background job runs — so an emergency stop pressed in between still wins.

An **approval** is bound to a fingerprint of the action, listing, price and content. Edit the listing and the approval is void. Approvals expire and are consumed on use. High-risk approvals need an owner.

## How duplicates and oversales are prevented

- **Publishing** is idempotent three ways: the job has an idempotency key; the listing row carries a key the marketplace create call is keyed on (eBay and Depop are keyed by SKU); and the external id is saved the moment it is known. A crash at any point resumes without a second listing. Publication is then verified by reading the listing back.
- **Sales** are recorded in one `BEGIN IMMEDIATE` transaction, which holds SQLite's single write lock: stock is taken with `UPDATE … WHERE quantity_available >= ?`, so two sales of the last unit are processed one after the other and the second becomes a *conflict* (possible double sale) with a critical alert. The same order arriving twice is rejected by a unique event key.
- **Cross-delisting** jobs retry with backoff; an end is only marked done after the marketplace confirms it. If it cannot be completed, the listing stays "ending", a discrepancy is opened and a critical alert is sent.
- **Reconciliation** runs on a schedule and re-reads every listing it can. It cannot make marketplaces consistent in real time — their notifications are delayed — but differences are detected, recorded and surfaced.

## Background jobs

Stored in the `jobs` table. A job is claimed with a single `UPDATE … RETURNING` and a lease; if the worker dies the lease expires and the job returns to the queue. Failures retry at 5s, 10s, 20s … up to an hour; rate limits wait for `Retry-After`; permanent failures and exhausted retries go to the dead-letter state and raise an alert (they can be retried from the Review queue). Recurring jobs use an idempotency key per time slot, so scheduling is safe to repeat.

"Events" in this system are these durable jobs plus audit records. There is no separate message bus.

## Data model (main tables)

`products` (SKU, attributes with provenance, cost, quantities) · `product_images` · `comps` · `price_recommendations` · `listings` (one live listing per product per marketplace, enforced by a partial unique index) · `listing_revisions` · `listing_metrics` · `orders` · `processed_events` · `inventory_movements` · `reservations` · `approvals` · `manual_tasks` · `jobs` · `audit_log` · `notifications` · `marketplace_connections` (credentials encrypted) · `discrepancies` · `reports` · `settings` · `users` · `sessions`.

All money is integer cents. Schema changes are SQL files in `migrations/`, applied in order at start-up.

## Untrusted content

Uploaded files, spreadsheet cells, marketplace responses, comparable titles and model output are all treated as data. Text is cleaned and length-capped on the way in; instruction-like text raises a `suspicious_text` flag that sends the item to human review. AI-written listing text is checked by `src/listings/guard.ts` against the item's confirmed facts and discarded in favour of the template if it adds any claim. Secrets are redacted before anything is logged, audited or sent in a notification.

## Swapping parts

- **AI provider:** implement `AiProvider` (`src/ai/provider.ts`) and select it in `src/app.ts`.
- **Marketplace:** see the end of [MARKETPLACES.md](MARKETPLACES.md).
- **Comparable source:** add a provider in `ResearchService.providers()`.
