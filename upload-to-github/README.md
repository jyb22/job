# Resale Ops

A self-hosted operations platform for a multi-marketplace resale business. You add an item (a photo, a spreadsheet row, or by hand); the system identifies it, researches comparables, calculates a price that protects your profit, drafts a separate listing for each marketplace, checks every action against your rules, publishes where it is allowed to, watches for sales, and ends the other listings when an item sells.

**Read [docs/STATUS.md](docs/STATUS.md) first.** It says exactly what works today, what has only been tested against simulations, and what is not built.

## What is real and what is not

| Area | State |
| --- | --- |
| Inventory, SKUs, photos, duplicate detection, CSV/Excel import | Working, tested |
| Pricing, fees, profit floors, markdowns (deterministic code, no AI) | Working, tested |
| Authorisation engine, approvals, emergency stop, audit log | Working, tested |
| Job queue: retries, backoff, idempotency, recovery, dead letters | Working, tested |
| Sales, atomic inventory, cross-delisting, reconciliation | Working, tested against the **simulated** marketplace |
| Dashboard | Working, checked in a browser |
| **eBay** adapter (official REST APIs) | Written from eBay's documentation and tested against a fake HTTP layer. **Never run against eBay** — no developer keys were available. |
| **Depop** adapter (official Selling API) | Written from Depop's OpenAPI spec and tested against a fake HTTP layer. **Never run against Depop** — access is by approval from Depop. One known gap: size IDs (see docs/MARKETPLACES.md). |
| **Mercari, Poshmark, Facebook Marketplace** | No public seller API exists. These run in **assisted mode**: the app prepares the listing and tracks it; you post it and end it by hand. The app does not log in to or script these sites. |
| **Etsy** | Has an official API, but no adapter is built. Assisted mode only. |
| Photo identification and AI listing text (Claude) | Code written; **never run against the live API** (no key was available). Without a key, items wait for you to enter their details and listings use the built-in template writer. |
| Sold-price research | No free source of sold prices exists. eBay's sold-price API is restricted to approved partners; Depop's needs partner access. Out of the box, comparables are your own past sales plus any you enter. The system says so instead of inventing numbers. |
| Background removal, barcode scanning by camera | Not built |
| Docker image | Written, **never built** (Docker was not available) |

## Quick start

Requires Node.js 22.13 or newer. A copy of Node 24 is bundled in `.tools/` on the machine this was built on:

```bash
source ./use-node.sh
```

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env`: set `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`), `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters). Then:

```bash
npm run web:build
```

```bash
npm start
```

Open http://localhost:4000 and sign in with the admin email and password from `.env`.

### See the whole workflow in one minute

```bash
npm run demo
```

Runs all 18 steps — photo → identification → SKU → comparables → pricing → three listings → authorisation → publish → sale → inventory → cross-delisting → verification → audit log → profit report — against **simulated** marketplaces, vision and comparables. It touches no real account and proves the application logic, not the eBay/Depop integrations.

### Run the tests

```bash
npm test
```

253 tests. `npm run typecheck` checks types for the server and the dashboard.

## Using it day to day

1. **Add items** (Inventory → Add items): upload photos, import a CSV/Excel file, or type the details. Always record what you paid — without a cost the profit floor cannot be enforced and the item is held for review.
2. The item is processed in the background. Open it to see what was identified (and whether each detail was *seen in a photo*, an *AI guess*, or *confirmed by you*), the comparables, the price and the per-marketplace profit.
3. **Review queue** shows everything waiting on you: approvals, listings to post by hand, items missing details, failed publications, discrepancies.
4. When something sells on a marketplace without an API, record it under **Sales → Record a sale**. Other listings are ended automatically where there is an API, and become urgent tasks where there is not.

### Automation modes (Settings → Automation)

- **Review only** (default): nothing goes live without your approval.
- **Semi-autonomous**: listings that pass every check publish on their own; anything unusual waits for you.
- **Full autonomous**: also applies scheduled markdowns and edits within your limits. Must be switched on by an owner who confirms they have reviewed the limits.

In every mode the agent can **never** refund, issue credits, buy labels or anything else, respond to offers, delete listings, or change passwords, payout details or account security. Those are not settings; they are fixed in `src/policy/engine.ts`.

The **Emergency stop** button (top right, always visible) immediately blocks all publishing, price changes and edits. Cross-delisting after a sale keeps running by default so a sold item cannot sell twice. Only an owner can release it.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Run the server (dev restarts on change) |
| `npm run web:build` / `npm run web:dev` | Build the dashboard / run it with hot reload on port 5173 |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check server and dashboard |
| `npm run demo` | End-to-end demonstration on simulated marketplaces |
| `npm run migrate` | Apply database migrations (also runs automatically at start) |
| `npm run user:create -- <email> <owner\|manager\|viewer>` | Add a user (password is prompted, not echoed) |
| `npm run backup` | Write a consistent copy of the database to `data/backups/` |

## Documentation

- [docs/STATUS.md](docs/STATUS.md) — what is complete, what is not, test results
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, data model, how authorisation and jobs work
- [docs/MARKETPLACES.md](docs/MARKETPLACES.md) — what each marketplace allows, and how to connect eBay and Depop
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker, HTTPS, backups, monitoring
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Assumptions made while building

- **SQLite instead of PostgreSQL + Redis.** The machine had no Docker, Postgres or Redis, and a single-operator resale business fits comfortably in SQLite (WAL mode). It also makes the inventory lock simple and provable: SQLite allows one writer at a time. The job queue lives in the same database. If you outgrow it, the SQL is plain and the services do not depend on SQLite-specific features beyond `RETURNING` and partial indexes, both of which Postgres has.
- **US marketplace, USD** by default (Settings → Alerts and schedules → Location).
- **Fee schedules are editable defaults**, flagged "unverified" until you confirm them against each marketplace's fee page. Published fee figures conflicted between sources when this was written.
- **One-of-one items** default to quantity 1.
