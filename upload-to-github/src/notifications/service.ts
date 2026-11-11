import nodemailer, { type Transporter } from "nodemailer";
import type { DB } from "../db";
import { clock, newId } from "../core/util";
import { hmacHex } from "../security/crypto";
import { redactSecrets } from "../security/sanitize";
import type { NotificationType, Settings } from "../settings/schema";

export interface NotificationInput {
  type: NotificationType;
  severity?: "info" | "warning" | "critical";
  title: string;
  body: string;
  productId?: string | null;
}

export interface SmtpConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  from?: string;
}

export interface NotificationRow {
  id: string;
  at: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  product_id: string | null;
  delivery: string;
  read_at: string | null;
}

/**
 * In-app notifications are always recorded. Email and webhook delivery are
 * optional and best-effort. Every message is passed through secret redaction
 * first, so tokens, keys and passwords cannot leak into a notification.
 */
export class NotificationService {
  private transport: Transporter | null = null;
  /** Deliveries in flight; awaited by tests and on shutdown. */
  private pending = new Set<Promise<void>>();
  fetchImpl: typeof fetch = fetch;

  constructor(
    private db: DB,
    private getSettings: () => Settings,
    private smtp: SmtpConfig,
    private webhookSecret?: string,
  ) {
    if (smtp.host) {
      this.transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port ?? 587,
        secure: (smtp.port ?? 587) === 465,
        auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      });
    }
  }

  notify(input: NotificationInput): string {
    const settings = this.getSettings().notifications;
    const id = newId("ntf");
    const title = redactSecrets(input.title).slice(0, 200);
    const body = redactSecrets(input.body).slice(0, 2000);
    const severity = input.severity ?? "info";
    const muted = settings.muted.includes(input.type);
    this.db
      .prepare("INSERT INTO notifications (id, at, type, severity, title, body, product_id, delivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, clock.iso(), input.type, severity, title, body, input.productId ?? null, JSON.stringify({ muted }));
    if (!muted) {
      const p = this.deliver(id, input.type, severity, title, body).finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
    return id;
  }

  private async deliver(id: string, type: string, severity: string, title: string, body: string): Promise<void> {
    const settings = this.getSettings().notifications;
    const delivery: Record<string, string> = {};
    if (settings.emailEnabled && settings.emailTo) {
      if (!this.transport) delivery.email = "skipped: SMTP is not configured";
      else {
        try {
          await this.transport.sendMail({ from: this.smtp.from ?? this.smtp.user, to: settings.emailTo, subject: `[Resale Ops] ${title}`, text: body });
          delivery.email = "sent";
        } catch (error) {
          delivery.email = `failed: ${redactSecrets((error as Error).message).slice(0, 200)}`;
        }
      }
    }
    if (settings.webhookEnabled && settings.webhookUrl) {
      try {
        const payload = JSON.stringify({ id, type, severity, title, body, at: clock.iso() });
        const res = await this.fetchImpl(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(this.webhookSecret ? { "X-Signature": hmacHex(this.webhookSecret, payload) } : {}) },
          body: payload,
          signal: AbortSignal.timeout(10000),
        });
        delivery.webhook = res.ok ? "sent" : `failed: HTTP ${res.status}`;
      } catch (error) {
        delivery.webhook = `failed: ${redactSecrets((error as Error).message).slice(0, 200)}`;
      }
    }
    if (Object.keys(delivery).length) this.db.prepare("UPDATE notifications SET delivery = ? WHERE id = ?").run(JSON.stringify(delivery), id);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  list(opts: { unreadOnly?: boolean; limit?: number } = {}): NotificationRow[] {
    return this.db
      .prepare(`SELECT * FROM notifications ${opts.unreadOnly ? "WHERE read_at IS NULL" : ""} ORDER BY at DESC LIMIT ?`)
      .all(opts.limit ?? 100) as NotificationRow[];
  }

  unreadCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL").get() as { n: number }).n;
  }

  markRead(id: string | "all"): void {
    if (id === "all") this.db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(clock.iso());
    else this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(clock.iso(), id);
  }
}
