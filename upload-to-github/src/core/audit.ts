import type { DB } from "../db";
import { clock } from "./util";
import type { Actor } from "./types";
import { redactObject } from "../security/sanitize";

export interface AuditEntry {
  actor: Actor;
  action: string;
  outcome?: "ok" | "denied" | "failed" | "pending";
  entityType?: string;
  entityId?: string;
  productId?: string | null;
  marketplace?: string | null;
  detail?: unknown;
}

export interface AuditRow {
  id: number;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  product_id: string | null;
  marketplace: string | null;
  outcome: string;
  detail: string | null;
}

/** Append-only record of every important operation. Detail is redacted before it is stored. */
export class AuditLog {
  private insert;

  constructor(private db: DB) {
    this.insert = db.prepare(
      "INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, product_id, marketplace, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
  }

  record(entry: AuditEntry): void {
    this.insert.run(
      clock.iso(),
      entry.actor.type,
      entry.actor.id ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.productId ?? null,
      entry.marketplace ?? null,
      entry.outcome ?? "ok",
      entry.detail === undefined ? null : JSON.stringify(redactObject(entry.detail)),
    );
  }

  list(filter: { productId?: string; action?: string; outcome?: string; limit?: number; before?: number } = {}): AuditRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.productId) { where.push("product_id = ?"); args.push(filter.productId); }
    if (filter.action) { where.push("action LIKE ?"); args.push(`${filter.action}%`); }
    if (filter.outcome) { where.push("outcome = ?"); args.push(filter.outcome); }
    if (filter.before) { where.push("id < ?"); args.push(filter.before); }
    const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(filter.limit ?? 100, 500)) as AuditRow[];
  }
}
