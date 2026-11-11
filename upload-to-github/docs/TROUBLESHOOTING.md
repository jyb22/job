# Troubleshooting

**`node: command not found` / `npm: command not found`**
Node is not on your PATH. On the machine this was built on, run `source ./use-node.sh` in the project folder first. Elsewhere, install Node.js 22.13 or newer.

**"APP_ENCRYPTION_KEY is not set" at start-up**
Copy `.env.example` to `.env` and set it: `openssl rand -base64 32`. Keep the same key forever; changing it makes stored marketplace credentials unreadable.

**The sign-in page says no account exists**
Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters) in `.env` and restart, or run `npm run user:create -- you@example.com owner`.

**"Too many failed sign-in attempts"**
The account is locked for 15 minutes after 8 failures. Restarting the server clears the lock.

**The page says "The dashboard has not been built yet"**
Run `npm run web:build` and reload.

**An item is stuck on "Needs identification"**
No AI key is configured, or the photos could not be analysed. Open the item, click **Edit**, fill in brand, item type, size and condition, and save — it reprocesses automatically. To enable automatic identification set `ANTHROPIC_API_KEY`.

**An item is stuck on "Needs review"**
Open the Review queue. Each approval lists the exact reasons. The common ones:

- *Acquisition cost is unknown* — record what you paid.
- *The price is not backed by enough completed-sale comparables* — add sold comparables on the item page, or turn off "Require real completed-sale comparables" in Settings → Safety if you accept that risk.
- *Review-only mode* — this is the default; approve it, or change the mode in Settings → Automation.
- *The agent is not permitted to publish on …* — grant it in Settings → Marketplaces.
- *Risk flags* — the brand is on the authenticity list, the price is high, or text looked like an instruction. An owner must approve.

**"No price yet" / the price looks arbitrary**
With no comparables the price is your cost plus the fallback markup, and the item page says so. Add a few completed sales you have looked up (item page → Add a comparable). There is no free automatic source of sold prices; see docs/MARKETPLACES.md.

**A listing shows "Waiting for you to post"**
That marketplace is in assisted mode. Review queue → "To do by hand": copy the title and description, post it on the marketplace, paste the link, click **I posted it**.

**A listing shows "Publish failed"**
The reason is on the listing and in the Review queue. Fix it and click **Try again**. For eBay: missing business policies or inventory location, or no `PUBLIC_BASE_URL`. For Depop: missing size ids (`depop_size_set_id`, `depop_size_id` attributes) or no `PUBLIC_BASE_URL`.

**An item sold but is still listed elsewhere**
Check the Review queue for an urgent "End listing" task (assisted marketplaces) or a failed delisting. End it on the marketplace and confirm. Then **Check marketplaces now**.

**"Possible double sale" alert**
Two orders arrived for an item with one unit. The second is recorded as a conflict and not counted as revenue. Cancel one order with its buyer on the marketplace, then mark the discrepancy resolved.

**Nothing is being published or repriced**
Look at the top bar. *Emergency stop* blocks everything until an owner releases it; *Paused* holds the agent's work until resumed; *Review only* means approvals are required.

**eBay "rejected the stored authorisation"**
The refresh token expired or was revoked. Settings → Marketplaces → eBay → Reconnect eBay account.

**Rate-limit alerts**
The job waits for the time the marketplace asked for and retries by itself. If it happens constantly, lengthen the schedules in Settings → Alerts and schedules.

**A background job "gave up"**
Review queue → "Background jobs that gave up" shows the error. Fix the cause and click **Retry**.

**Photos are rejected**
Only real image files are accepted (JPEG, PNG, WebP, AVIF, TIFF, GIF), up to 25 MB each and 40 per upload. iPhone HEIC photos are converted automatically when the server runs on macOS; on Linux (including Docker) export them as JPEG first.

**Start again from nothing**
Stop the server and delete the `data/` folder. This erases all inventory, listings, sales, settings and users.
