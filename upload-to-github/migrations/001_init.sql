-- Resale Ops: initial schema. All money is stored as integer cents.
-- Timestamps are ISO-8601 UTC strings.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','viewer')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE sku_counter (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO sku_counter (id, value) VALUES (1, 0);

-- ---------------------------------------------------------------- inventory
CREATE TABLE products (
  id                    TEXT PRIMARY KEY,
  sku                   TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL,
  title                 TEXT,
  brand                 TEXT,
  model                 TEXT,
  category              TEXT,
  department            TEXT,
  size                  TEXT,
  color                 TEXT,
  material              TEXT,
  condition             TEXT,
  condition_notes       TEXT,
  style_number          TEXT,
  upc                   TEXT,
  notes                 TEXT,
  -- JSON: { [name]: { value, basis: 'visible'|'inferred'|'operator', confidence } }
  attributes            TEXT NOT NULL DEFAULT '{}',
  -- JSON: raw identification result (defects, accessories, concerns, missing views)
  identification        TEXT,
  identification_confidence REAL,
  -- JSON: string[] risk flags raised by deterministic checks
  risk_flags            TEXT NOT NULL DEFAULT '[]',
  acquisition_cost_cents INTEGER,
  extra_cost_cents      INTEGER NOT NULL DEFAULT 0,
  min_price_cents       INTEGER,
  storage_location      TEXT,
  quantity_available    INTEGER NOT NULL DEFAULT 1 CHECK (quantity_available >= 0),
  quantity_reserved     INTEGER NOT NULL DEFAULT 0 CHECK (quantity_reserved >= 0),
  quantity_sold         INTEGER NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  source                TEXT NOT NULL DEFAULT 'upload',
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  archived_at           TEXT
);
CREATE INDEX idx_products_status ON products(status);

CREATE TABLE product_images (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  original_path  TEXT NOT NULL,
  optimized_path TEXT,
  sha256         TEXT NOT NULL,
  phash          TEXT,
  width          INTEGER,
  height         INTEGER,
  bytes          INTEGER,
  blur_score     REAL,
  quality        TEXT NOT NULL DEFAULT '{}',
  view_label     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_images_product ON product_images(product_id);
CREATE INDEX idx_images_sha ON product_images(sha256);

CREATE TABLE inventory_movements (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  delta_available INTEGER NOT NULL DEFAULT 0,
  delta_reserved  INTEGER NOT NULL DEFAULT 0,
  delta_sold      INTEGER NOT NULL DEFAULT 0,
  ref             TEXT,
  at              TEXT NOT NULL
);
CREATE INDEX idx_movements_product ON inventory_movements(product_id);

CREATE TABLE reservations (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity   INTEGER NOT NULL,
  ref        TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL CHECK (status IN ('held','released','consumed')),
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- research
CREATE TABLE comps (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,
  marketplace    TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('sold','active')),
  title          TEXT NOT NULL,
  price_cents    INTEGER NOT NULL,
  shipping_cents INTEGER,
  condition      TEXT,
  size           TEXT,
  sold_at        TEXT,
  listed_at      TEXT,
  url            TEXT,
  similarity     REAL NOT NULL,
  simulated      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_comps_product ON comps(product_id);

CREATE TABLE price_recommendations (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,
  result      TEXT NOT NULL
);
CREATE INDEX idx_price_rec_product ON price_recommendations(product_id, computed_at);

-- ---------------------------------------------------------------- listings
CREATE TABLE listings (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  marketplace      TEXT NOT NULL,
  status           TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  category_id      TEXT,
  category_name    TEXT,
  attributes       TEXT NOT NULL DEFAULT '{}',
  price_cents      INTEGER NOT NULL,
  original_price_cents INTEGER NOT NULL,
  min_price_cents  INTEGER NOT NULL,
  quality_score    INTEGER,
  quality          TEXT NOT NULL DEFAULT '{}',
  validation       TEXT NOT NULL DEFAULT '{}',
  writer           TEXT NOT NULL DEFAULT 'template',
  external_id      TEXT,
  external_url     TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  simulated        INTEGER NOT NULL DEFAULT 0,
  integration_mode TEXT NOT NULL DEFAULT 'assisted',
  last_error       TEXT,
  published_at     TEXT,
  ended_at         TEXT,
  last_synced_at   TEXT,
  last_repriced_at TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_listings_product ON listings(product_id);
CREATE INDEX idx_listings_status ON listings(status);
-- At most one live (non-terminal) listing per product per marketplace.
CREATE UNIQUE INDEX uq_listings_live ON listings(product_id, marketplace)
  WHERE status NOT IN ('delisted','sold','archived');

CREATE TABLE listing_revisions (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  field      TEXT NOT NULL,
  before     TEXT,
  after      TEXT,
  reason     TEXT,
  -- JSON snapshot of metrics at the time of the change, for before/after evaluation
  metrics_before TEXT
);
CREATE INDEX idx_revisions_listing ON listing_revisions(listing_id, at);

CREATE TABLE listing_metrics (
  id          TEXT PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  impressions INTEGER,
  views       INTEGER,
  watchers    INTEGER,
  likes       INTEGER,
  offers      INTEGER,
  source      TEXT NOT NULL,
  simulated   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_metrics_listing ON listing_metrics(listing_id, captured_at);

CREATE TABLE workflow_stages (
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL,
  detail      TEXT,
  started_at  TEXT,
  finished_at TEXT,
  PRIMARY KEY (product_id, stage)
);

-- ---------------------------------------------------------------- sales
CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  marketplace           TEXT NOT NULL,
  external_order_id     TEXT NOT NULL,
  product_id            TEXT REFERENCES products(id),
  sku                   TEXT NOT NULL,
  listing_id            TEXT REFERENCES listings(id),
  quantity              INTEGER NOT NULL,
  sale_price_cents      INTEGER NOT NULL,
  shipping_charged_cents INTEGER NOT NULL DEFAULT 0,
  fees_cents            INTEGER NOT NULL,
  fees_verified         INTEGER NOT NULL DEFAULT 0,
  shipping_cost_cents   INTEGER NOT NULL DEFAULT 0,
  net_proceeds_cents    INTEGER NOT NULL,
  cost_cents            INTEGER,
  net_profit_cents      INTEGER,
  status                TEXT NOT NULL CHECK (status IN ('verified','conflict')),
  source                TEXT NOT NULL,
  simulated             INTEGER NOT NULL DEFAULT 0,
  sold_at               TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  UNIQUE (marketplace, external_order_id, sku)
);
CREATE INDEX idx_orders_product ON orders(product_id);
CREATE INDEX idx_orders_sold_at ON orders(sold_at);

CREATE TABLE processed_events (
  event_key   TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  received_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- control
CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  product_id   TEXT,
  listing_id   TEXT,
  marketplace  TEXT,
  action       TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  reasons      TEXT NOT NULL,
  risk         TEXT NOT NULL DEFAULT 'normal',
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by   TEXT,
  decided_at   TEXT,
  expires_at   TEXT,
  note         TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE UNIQUE INDEX uq_approvals_pending ON approvals(fingerprint) WHERE status = 'pending';

CREATE TABLE manual_tasks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('post_listing','end_listing','update_listing')),
  listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open','done','cancelled')),
  urgent      INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  done_at     TEXT,
  done_by     TEXT
);
CREATE INDEX idx_tasks_status ON manual_tasks(status);

CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','dead','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 5,
  run_at          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 6,
  idempotency_key TEXT UNIQUE,
  locked_by       TEXT,
  locked_until    TEXT,
  last_error      TEXT,
  result          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_jobs_ready ON jobs(status, run_at, priority);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  product_id  TEXT,
  marketplace TEXT,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','denied','failed','pending')),
  detail      TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_product ON audit_log(product_id);
CREATE INDEX idx_audit_action ON audit_log(action);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  product_id TEXT,
  delivery   TEXT NOT NULL DEFAULT '{}',
  read_at    TEXT
);
CREATE INDEX idx_notifications_at ON notifications(at);

CREATE TABLE marketplace_connections (
  marketplace       TEXT PRIMARY KEY,
  mode              TEXT NOT NULL CHECK (mode IN ('api','assisted','simulated','disabled')),
  environment       TEXT NOT NULL DEFAULT 'sandbox',
  status            TEXT NOT NULL DEFAULT 'not_connected',
  credentials_enc   TEXT,
  account           TEXT,
  last_validated_at TEXT,
  last_error        TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE discrepancies (
  id          TEXT PRIMARY KEY,
  product_id  TEXT,
  listing_id  TEXT,
  marketplace TEXT,
  kind        TEXT NOT NULL,
  expected    TEXT,
  actual      TEXT,
  dedupe_key  TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution  TEXT
);
CREATE UNIQUE INDEX uq_discrepancy_open ON discrepancies(dedupe_key) WHERE resolved_at IS NULL;

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data         TEXT NOT NULL
);

-- Persistent store for the SIMULATED marketplace adapter (demo and tests only).
CREATE TABLE sim_marketplace_listings (
  marketplace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  sku         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status      TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (marketplace, external_id),
  UNIQUE (marketplace, idempotency_key)
);
