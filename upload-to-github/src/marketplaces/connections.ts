import type { DB } from "../db";
import { MARKETPLACES, type MarketplaceId, parseJson } from "../core/types";
import { clock } from "../core/util";
import type { SecretBox } from "../security/crypto";
import type { AdapterMode } from "./adapter";
import { SPECS } from "./specs";

export type ConnectionMode = AdapterMode | "disabled";

export interface Connection {
  marketplace: MarketplaceId;
  mode: ConnectionMode;
  environment: string;
  status: string;
  account: Record<string, unknown>;
  lastValidatedAt: string | null;
  lastError: string | null;
  hasCredentials: boolean;
}

interface Row {
  marketplace: MarketplaceId;
  mode: ConnectionMode;
  environment: string;
  status: string;
  credentials_enc: string | null;
  account: string | null;
  last_validated_at: string | null;
  last_error: string | null;
}

/** Marketplace connection state. Credentials are encrypted at rest and never returned by `get`/`list`. */
export class ConnectionStore {
  constructor(
    private db: DB,
    private box: SecretBox,
  ) {}

  private row(marketplace: MarketplaceId): Row {
    let row = this.db.prepare("SELECT * FROM marketplace_connections WHERE marketplace = ?").get(marketplace) as Row | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO marketplace_connections (marketplace, mode, environment, status, updated_at) VALUES (?, 'assisted', 'production', 'assisted', ?)")
        .run(marketplace, clock.iso());
      row = this.db.prepare("SELECT * FROM marketplace_connections WHERE marketplace = ?").get(marketplace) as Row;
    }
    return row;
  }

  get(marketplace: MarketplaceId): Connection {
    const r = this.row(marketplace);
    return {
      marketplace,
      mode: r.mode,
      environment: r.environment,
      status: r.status,
      account: parseJson(r.account, {}),
      lastValidatedAt: r.last_validated_at,
      lastError: r.last_error,
      hasCredentials: !!r.credentials_enc,
    };
  }

  list(): (Connection & { name: string; integration: string; apiNotes: string })[] {
    return MARKETPLACES.map((m) => ({ ...this.get(m), name: SPECS[m].name, integration: SPECS[m].integration, apiNotes: SPECS[m].apiNotes }));
  }

  credentials<T extends Record<string, unknown>>(marketplace: MarketplaceId): T | null {
    const r = this.row(marketplace);
    if (!r.credentials_enc) return null;
    return JSON.parse(this.box.decrypt(r.credentials_enc)) as T;
  }

  saveCredentials(marketplace: MarketplaceId, credentials: Record<string, unknown> | null): void {
    this.row(marketplace);
    this.db
      .prepare("UPDATE marketplace_connections SET credentials_enc = ?, updated_at = ? WHERE marketplace = ?")
      .run(credentials ? this.box.encrypt(JSON.stringify(credentials)) : null, clock.iso(), marketplace);
  }

  setMode(marketplace: MarketplaceId, mode: ConnectionMode, environment?: string): void {
    const r = this.row(marketplace);
    this.db
      .prepare("UPDATE marketplace_connections SET mode = ?, environment = ?, status = ?, updated_at = ? WHERE marketplace = ?")
      .run(mode, environment ?? r.environment, mode === "api" ? "unverified" : mode, clock.iso(), marketplace);
  }

  setStatus(marketplace: MarketplaceId, status: string, error: string | null, validated = false): void {
    this.row(marketplace);
    this.db
      .prepare("UPDATE marketplace_connections SET status = ?, last_error = ?, last_validated_at = COALESCE(?, last_validated_at), updated_at = ? WHERE marketplace = ?")
      .run(status, error, validated ? clock.iso() : null, clock.iso(), marketplace);
  }

  setAccount(marketplace: MarketplaceId, account: Record<string, unknown>): void {
    this.row(marketplace);
    this.db.prepare("UPDATE marketplace_connections SET account = ?, updated_at = ? WHERE marketplace = ?").run(JSON.stringify(account), clock.iso(), marketplace);
  }
}
