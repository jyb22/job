import type { DB } from "../db";
import { clock, newId, PermanentError, RateLimitError } from "../core/util";
import { redactSecrets } from "../security/sanitize";

// Durable background job queue stored in the application database.
//
// Guarantees:
//  - enqueue is idempotent per `idempotencyKey` (duplicate protection)
//  - a job is claimed by exactly one worker (atomic UPDATE … RETURNING)
//  - a worker that dies leaves a lease that expires; the job is re-queued
//  - failures retry with exponential backoff; rate limits honour Retry-After
//  - jobs that keep failing move to the dead-letter state and raise an alert
// Handlers must therefore be safe to run more than once for the same job.

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: "queued" | "running" | "succeeded" | "dead" | "cancelled";
  priority: number;
  run_at: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

/** Thrown by a handler to say "not now, try again later" without using up an attempt (e.g. automation is paused). */
export class DeferJob extends Error {
  constructor(
    message: string,
    public delaySeconds: number,
  ) {
    super(message);
  }
}

export type JobHandler = (payload: any, job: JobRow) => Promise<unknown>;

export interface EnqueueOptions {
  idempotencyKey?: string;
  priority?: number;
  delaySeconds?: number;
  maxAttempts?: number;
}

const LEASE_SECONDS = 120;
const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 3600;

export function backoffSeconds(attempt: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempt - 1));
}

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  readonly workerId = newId("worker");
  onDead: (job: JobRow, error: string) => void = () => {};
  onRateLimited: (job: JobRow, error: RateLimitError) => void = () => {};

  constructor(private db: DB) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Add a job. Returns the job id, or the id of the existing job when the idempotency key was already used. */
  enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}): string {
    const now = clock.now();
    const id = newId("job");
    const runAt = new Date(now.getTime() + (opts.delaySeconds ?? 0) * 1000).toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, priority, run_at, max_attempts, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(id, type, JSON.stringify(payload ?? {}), opts.priority ?? 5, runAt, opts.maxAttempts ?? 6, opts.idempotencyKey ?? null, now.toISOString(), now.toISOString());
    if (res.changes === 0 && opts.idempotencyKey) {
      return (this.db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(opts.idempotencyKey) as { id: string }).id;
    }
    return id;
  }

  /** Return jobs whose worker died mid-run (lease expired) to the queue. */
  recoverStale(): number {
    const now = clock.iso();
    return this.db
      .prepare("UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, last_error = 'Worker lease expired; job re-queued', updated_at = ? WHERE status = 'running' AND locked_until < ?")
      .run(now, now).changes;
  }

  private claim(ignoreSchedule: boolean, skip: Set<string>): JobRow | undefined {
    const now = clock.now();
    const lease = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
    const exclude = skip.size ? `AND id NOT IN (${[...skip].map(() => "?").join(",")})` : "";
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND (? OR run_at <= ?) ${exclude} ORDER BY priority, run_at, created_at LIMIT 1)
         RETURNING *`,
      )
      .get(this.workerId, lease, now.toISOString(), ignoreSchedule ? 1 : 0, now.toISOString(), ...skip) as JobRow | undefined;
  }

  /**
   * Claim and run one job. Returns false when nothing was due.
   * `deferred` collects jobs that asked to be held (e.g. automation is paused) so a drain does not spin on them.
   */
  async runOne(ignoreSchedule = false, deferred: Set<string> = new Set()): Promise<boolean> {
    const job = this.claim(ignoreSchedule, deferred);
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    const finish = (status: JobRow["status"], fields: { error?: string | null; result?: unknown; runAt?: string; attempts?: number }) => {
      this.db
        .prepare("UPDATE jobs SET status = ?, locked_by = NULL, locked_until = NULL, last_error = ?, result = ?, run_at = COALESCE(?, run_at), attempts = COALESCE(?, attempts), updated_at = ? WHERE id = ?")
        .run(status, fields.error ?? null, fields.result === undefined ? null : JSON.stringify(fields.result), fields.runAt ?? null, fields.attempts ?? null, clock.iso(), job.id);
    };
    const later = (seconds: number) => new Date(clock.now().getTime() + seconds * 1000).toISOString();

    try {
      if (!handler) throw new PermanentError(`No handler registered for job type "${job.type}"`);
      const result = await handler(JSON.parse(job.payload), job);
      finish("succeeded", { result });
    } catch (err) {
      const error = err as Error;
      const message = redactSecrets(error.message || String(err)).slice(0, 1000);
      if (error instanceof DeferJob) {
        finish("queued", { error: message, runAt: later(error.delaySeconds), attempts: job.attempts - 1 });
        deferred.add(job.id);
      } else if (error instanceof PermanentError || job.attempts >= job.max_attempts) {
        finish("dead", { error: message });
        this.onDead({ ...job, status: "dead", last_error: message }, message);
      } else if (error instanceof RateLimitError) {
        finish("queued", { error: message, runAt: later(Math.max(1, error.retryAfterSeconds)) });
        this.onRateLimited(job, error);
      } else {
        finish("queued", { error: message, runAt: later(backoffSeconds(job.attempts)) });
      }
    }
    return true;
  }

  /**
   * Run jobs until none are left (used by tests, the demo and CLI tools).
   * With `ignoreSchedule` backoff delays are skipped so retries happen immediately.
   */
  async drain(opts: { ignoreSchedule?: boolean; maxJobs?: number } = {}): Promise<number> {
    let n = 0;
    const deferred = new Set<string>();
    while (n < (opts.maxJobs ?? 500) && (await this.runOne(opts.ignoreSchedule ?? false, deferred))) n++;
    return n - deferred.size;
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.recoverStale();
    let ticks = 0;
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        if (++ticks % 60 === 0) this.recoverStale();
        for (let i = 0; i < 10 && (await this.runOne()); i++);
      } catch (error) {
        console.error("job worker error:", redactSecrets((error as Error).message));
      } finally {
        this.busy = false;
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(filter: { status?: string; limit?: number } = {}): JobRow[] {
    const sql = `SELECT * FROM jobs ${filter.status ? "WHERE status = ?" : ""} ORDER BY updated_at DESC LIMIT ?`;
    const args = filter.status ? [filter.status, filter.limit ?? 100] : [filter.limit ?? 100];
    return this.db.prepare(sql).all(...args) as JobRow[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Put a dead-lettered job back on the queue with a fresh attempt budget. */
  retryDead(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, updated_at = ? WHERE id = ? AND status = 'dead'").run(clock.iso(), clock.iso(), id).changes > 0;
  }
}
