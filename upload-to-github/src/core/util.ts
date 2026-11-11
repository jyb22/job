import { randomBytes, createHash } from "node:crypto";

// ---- clock (overridable in tests) ------------------------------------------
let fixedNow: number | null = null;
export const clock = {
  now(): Date {
    return new Date(fixedNow ?? Date.now());
  },
  iso(): string {
    return clock.now().toISOString();
  },
  /** Test helper: freeze time (ms since epoch) or pass null to unfreeze. */
  set(ms: number | null): void {
    fixedNow = ms;
  },
  advance(ms: number): void {
    fixedNow = (fixedNow ?? Date.now()) + ms;
  },
};

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export function daysBetween(fromIso: string, to: Date = clock.now()): number {
  return (to.getTime() - new Date(fromIso).getTime()) / DAY;
}

// ---- ids --------------------------------------------------------------------
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export function newId(prefix: string): string {
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 32];
  return `${prefix}_${out}`;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---- money ------------------------------------------------------------------
export function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Parse "12.50", "$12.5", 12.5 into cents. Returns null when not a valid amount. */
export function toCents(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  const cleaned = String(input).replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function slugToken(text: string | null | undefined, len: number): string {
  const cleaned = (text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (cleaned || "X".repeat(len)).slice(0, len).padEnd(len, "X");
}

export function titleCase(text: string): string {
  return text.replace(/\b([a-z])([a-z]*)/gi, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public detail?: unknown,
  ) {
    super(message);
  }
}

/** Raised by marketplace adapters when the platform asks us to slow down. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number,
  ) {
    super(message);
  }
}

/** Raised for failures that retrying will not fix (bad request, policy rejection). */
export class PermanentError extends Error {}
