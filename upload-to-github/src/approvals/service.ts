import type { Ctx } from "../context";
import { parseJson, type Actor } from "../core/types";
import { AppError, clock, HOUR, newId } from "../core/util";
import type { Reason } from "../policy/engine";

export interface ApprovalRow {
  id: string;
  kind: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  product_id: string | null;
  listing_id: string | null;
  marketplace: string | null;
  action: string;
  fingerprint: string;
  reasons: string;
  risk: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  note: string | null;
}

export interface ApprovalRequest {
  kind: string;
  productId?: string | null;
  listingId?: string | null;
  marketplace?: string | null;
  action: Record<string, unknown>;
  fingerprint: string;
  reasons: Reason[];
  risk: "normal" | "high";
  requestedBy: Actor;
}

/**
 * The human approval queue. An approval is bound to a fingerprint of exactly
 * what was shown to the approver (action, listing, price, content); if any of
 * that changes, the approval no longer matches and a new one is required.
 * Approvals expire, and are consumed when the action runs.
 */
export class ApprovalService {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  /** Open a request (or return the one already pending for the same fingerprint). */
  request(req: ApprovalRequest): ApprovalRow {
    const existing = this.db.prepare("SELECT * FROM approvals WHERE fingerprint = ? AND status = 'pending'").get(req.fingerprint) as ApprovalRow | undefined;
    if (existing) return existing;
    const ttl = this.ctx.settings.get().automation.approvalTtlHours;
    const id = newId("apr");
    const now = clock.now();
    this.db
      .prepare("INSERT INTO approvals (id, kind, status, product_id, listing_id, marketplace, action, fingerprint, reasons, risk, requested_by, requested_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, req.kind, req.productId ?? null, req.listingId ?? null, req.marketplace ?? null, JSON.stringify(req.action), req.fingerprint, JSON.stringify(req.reasons), req.risk, `${req.requestedBy.type}:${req.requestedBy.id ?? ""}`, now.toISOString(), new Date(now.getTime() + ttl * HOUR).toISOString());
    this.ctx.audit.record({ actor: req.requestedBy, action: "approval.requested", outcome: "pending", entityType: "approval", entityId: id, productId: req.productId, marketplace: req.marketplace, detail: { kind: req.kind, reasons: req.reasons.map((r) => r.code), risk: req.risk } });
    const codes = req.reasons.map((r) => r.code);
    this.ctx.notifications.notify({
      type: codes.includes("risk_flags") ? "authenticity_concern" : codes.some((c) => c === "price_floor" || c === "max_discount" || c === "max_auto_price") ? "pricing_exception" : "review_needed",
      severity: req.risk === "high" ? "warning" : "info",
      title: `Approval needed: ${req.kind}${req.marketplace ? ` on ${req.marketplace}` : ""}`,
      body: req.reasons.map((r) => `• ${r.message}`).join("\n"),
      productId: req.productId,
    });
    return this.get(id);
  }

  get(id: string): ApprovalRow {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (!row) throw new AppError("not_found", "Approval not found", 404);
    return row;
  }

  list(status?: string, limit = 200): ApprovalRow[] {
    this.expire();
    return this.db.prepare(`SELECT * FROM approvals ${status ? "WHERE status = ?" : ""} ORDER BY requested_at DESC LIMIT ?`).all(...(status ? [status, limit] : [limit])) as ApprovalRow[];
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
  }

  /** A granted, unexpired, not-yet-used approval for exactly this fingerprint. */
  findValid(fingerprint: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE fingerprint = ? AND status = 'approved' AND expires_at > ? ORDER BY decided_at DESC LIMIT 1").get(fingerprint, clock.iso()) as ApprovalRow | undefined;
  }

  consume(id: string): void {
    this.db.prepare("UPDATE approvals SET status = 'consumed' WHERE id = ? AND status = 'approved'").run(id);
  }

  /** A human decision. High-risk approvals need an owner. The approved action is then carried out. */
  async decide(id: string, decision: "approve" | "reject", actor: Actor, note?: string): Promise<ApprovalRow> {
    this.expire();
    const row = this.get(id);
    if (actor.type !== "user" || (actor.role !== "owner" && actor.role !== "manager")) throw new AppError("forbidden", "Only an owner or manager can decide approvals.", 403);
    if (row.risk === "high" && actor.role !== "owner") throw new AppError("owner_required", "High-risk approvals must be decided by an owner.", 403);
    if (row.status !== "pending") throw new AppError("not_pending", `This approval is already ${row.status}.`, 409);
    // An approval covers exactly what was shown. If the listing's price or text changed since, it is void.
    if (decision === "approve" && row.listing_id && this.ctx.listings.currentFingerprint(row) !== row.fingerprint) {
      this.invalidate(row.id, "The listing changed after this approval was requested.");
      throw new AppError("stale_approval", "The listing has changed since this approval was requested, so it can no longer be approved. Request approval again for the current version.", 409);
    }
    const ttl = this.ctx.settings.get().automation.approvalTtlHours;
    const now = clock.now();
    this.db
      .prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, expires_at = ?, note = ? WHERE id = ?")
      .run(decision === "approve" ? "approved" : "rejected", actor.id ?? null, now.toISOString(), new Date(now.getTime() + ttl * HOUR).toISOString(), note?.slice(0, 500) ?? null, id);
    this.ctx.audit.record({ actor, action: decision === "approve" ? "approval.approved" : "approval.rejected", entityType: "approval", entityId: id, productId: row.product_id, marketplace: row.marketplace, detail: { kind: row.kind, note } });
    const decided = this.get(id);
    if (decision === "approve") await this.ctx.listings.onApproved(decided, actor);
    else this.ctx.listings.onRejected(decided, actor);
    return this.get(id);
  }

  private invalidate(id: string, reason: string): void {
    const res = this.db.prepare("UPDATE approvals SET status = 'expired', note = ? WHERE id = ? AND status IN ('pending','approved')").run(reason, id);
    if (res.changes) this.ctx.audit.record({ actor: { type: "system", id: "system" }, action: "approval.invalidated", entityType: "approval", entityId: id, detail: { reason } });
  }

  /** Void every open approval for a listing whose price or content has just changed. */
  invalidateForListing(listingId: string, reason: string): number {
    const rows = this.db.prepare("SELECT id FROM approvals WHERE listing_id = ? AND status IN ('pending','approved')").all(listingId) as { id: string }[];
    for (const r of rows) this.invalidate(r.id, reason);
    return rows.length;
  }

  /** Expire stale requests so an old approval can never authorise a later action. */
  expire(): number {
    const now = clock.iso();
    const stale = this.db.prepare("SELECT * FROM approvals WHERE status IN ('pending','approved') AND expires_at <= ?").all(now) as ApprovalRow[];
    for (const row of stale) {
      this.db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(row.id);
      this.ctx.audit.record({ actor: { type: "system", id: "system" }, action: "approval.expired", entityType: "approval", entityId: row.id, productId: row.product_id, detail: { kind: row.kind, was: row.status } });
    }
    return stale.length;
  }

  view(row: ApprovalRow) {
    return { ...row, action: parseJson<Record<string, unknown>>(row.action, {}), reasons: parseJson<Reason[]>(row.reasons, []) };
  }
}
