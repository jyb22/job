import type { Ctx } from "../context";
import type { Actor, Role } from "../core/types";
import { AppError, clock, DAY, newId, sha256Hex } from "../core/util";
import { hashPassword, randomToken, verifyPassword } from "../security/crypto";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: string;
}

const SESSION_DAYS = 14;
const MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

/** Local accounts with three roles: owner (everything), manager (day-to-day operations), viewer (read only). */
export class AuthService {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  createUser(email: string, password: string, role: Role, by: Actor = { type: "system", id: "setup" }): UserRow {
    const clean = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new AppError("bad_email", "Enter a valid email address.", 400);
    if (password.length < 12) throw new AppError("weak_password", "Passwords must be at least 12 characters.", 400);
    if (this.db.prepare("SELECT 1 FROM users WHERE email = ?").get(clean)) throw new AppError("exists", "A user with that email already exists.", 409);
    const id = newId("usr");
    this.db.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(id, clean, hashPassword(password), role, clock.iso());
    this.ctx.audit.record({ actor: by, action: "user.created", entityType: "user", entityId: id, detail: { role } });
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  }

  /** Returns a session token, or throws. Repeated failures for one email are temporarily locked out. */
  login(email: string, password: string): { token: string; user: UserRow } {
    const key = email.trim().toLowerCase();
    const f = this.failures.get(key);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) throw new AppError("locked", "Too many failed sign-in attempts. Try again later.", 429);
    const user = this.db.prepare("SELECT * FROM users WHERE email = ?").get(key) as UserRow | undefined;
    // Always run the hash so response time does not reveal whether the email exists.
    const ok = verifyPassword(password, user?.password_hash ?? "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") && !!user && !user.disabled;
    if (!ok || !user) {
      const next = { count: (f?.count ?? 0) + 1, until: Date.now() + LOCK_MINUTES * 60_000 };
      this.failures.set(key, next);
      this.ctx.audit.record({ actor: { type: "system", id: "auth" }, action: "auth.login_failed", outcome: "denied", detail: { attempts: next.count } });
      if (next.count === MAX_FAILURES) {
        this.ctx.notifications.notify({ type: "suspicious_activity", severity: "warning", title: "Repeated failed sign-in attempts", body: `An account was locked for ${LOCK_MINUTES} minutes after ${MAX_FAILURES} failed sign-in attempts.` });
      }
      throw new AppError("invalid_credentials", "Email or password is incorrect.", 401);
    }
    this.failures.delete(key);
    const token = randomToken();
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha256Hex(token), user.id, new Date(clock.now().getTime() + SESSION_DAYS * DAY).toISOString(), clock.iso());
    this.ctx.audit.record({ actor: { type: "user", id: user.id, role: user.role }, action: "auth.login", entityType: "user", entityId: user.id });
    return { token, user };
  }

  /** Resolve a session token to a user, or null. Only a hash of the token is stored. */
  authenticate(token: string | undefined): UserRow | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0")
      .get(sha256Hex(token), clock.iso()) as UserRow | undefined;
    return row ?? null;
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
  }

  users(): Omit<UserRow, "password_hash">[] {
    return this.db.prepare("SELECT id, email, role, disabled, created_at FROM users ORDER BY created_at").all() as Omit<UserRow, "password_hash">[];
  }

  setDisabled(userId: string, disabled: boolean, by: Actor): void {
    if (disabled) {
      const owners = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?").get(userId) as { n: number };
      if (owners.n === 0) throw new AppError("last_owner", "The last active owner cannot be disabled.", 409);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
    this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
    this.ctx.audit.record({ actor: by, action: disabled ? "user.disabled" : "user.enabled", entityType: "user", entityId: userId });
  }

  actorFor(user: UserRow): Actor {
    return { type: "user", id: user.id, role: user.role };
  }
}
