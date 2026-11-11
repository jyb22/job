# Deployment

## Before you expose it to the internet

- Set a strong `ADMIN_PASSWORD` and a real `APP_ENCRYPTION_KEY`. **Back up the key separately**: without it, stored marketplace credentials cannot be decrypted.
- Serve it over HTTPS (a reverse proxy such as Caddy or nginx) and set `COOKIE_SECURE=true`.
- Keep `HOST=127.0.0.1` unless a proxy on another host needs to reach it.
- `PUBLIC_BASE_URL` is only needed for API publishing to eBay/Depop, which fetch photos by URL. Photo links are signed; nothing else is public.

## Run with Node directly

```bash
npm ci
```

```bash
npm run web:build
```

```bash
NODE_ENV=production npm start
```

Keep it running with your process manager of choice (systemd, launchd, pm2). The process handles `SIGTERM` cleanly. Run **one** instance per database: the queue is safe with several workers, but the recurring schedule and SQLite's single-writer model are designed around one process.

## Run with Docker

> The Dockerfile and compose file were written but have **not been built or run** — Docker was not available on the machine this was developed on. Build it and run `npm test` inside the build stage before trusting it.

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

Data (database and photos) is in the `resale-ops-data` volume, mounted at `/data`.

## Environment variables

See `.env.example` for the full annotated list. Required: `APP_ENCRYPTION_KEY`, and `ADMIN_EMAIL` / `ADMIN_PASSWORD` for the first start. Everything else is optional and switches on a feature (AI, eBay, Depop, email, sale webhooks).

Secrets belong in `.env` (or your platform's secret store), never in the repository. Marketplace tokens entered through the dashboard are encrypted in the database with `APP_ENCRYPTION_KEY`.

## Database migrations

Applied automatically at start-up, in filename order, each in a transaction. To apply them without starting the server:

```bash
npm run migrate
```

To change the schema, add a new numbered file in `migrations/`; never edit one that has already run.

## Backups and recovery

What to back up: the database file (`DATA_DIR/resale-ops.db`), the photos (`DATA_DIR/images/`), and — stored somewhere else — `APP_ENCRYPTION_KEY`.

```bash
npm run backup
```

writes a consistent snapshot to `DATA_DIR/backups/` while the server is running. Schedule it (cron) and copy the result and the `images/` folder off the machine. Do not copy the live `.db` file with `cp` while the server is running; use the backup command.

To restore: stop the server, replace `resale-ops.db` with a backup (delete any `resale-ops.db-wal` and `-shm` files beside it), put `images/` back, start the server with the same `APP_ENCRYPTION_KEY`. After a restore, run **Review queue → Check marketplaces now**: listings may have changed on the marketplaces since the backup was taken, and reconciliation will show the differences.

## Monitoring

- `GET /api/health` — liveness (used by the Docker health check).
- **Overview → Background work** and **Review queue** show queued, failed and dead-lettered jobs.
- **Activity → Audit log** is the permanent record; filter by outcome "Failed" or "Denied".
- Alerts: enable email and/or a webhook in Settings → Alerts and schedules. Critical alerts (possible double sale, a delisting that could not be completed, emergency stop) should reach a phone.
- With `NODE_ENV=production` the server writes structured JSON request logs to stdout. Error text is redacted before it is logged.

## Updating

Pull the new code, `npm ci`, `npm run web:build`, take a backup, restart. Migrations apply on start.
