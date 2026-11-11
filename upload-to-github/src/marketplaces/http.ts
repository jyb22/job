import { PermanentError, RateLimitError } from "../core/util";
import { redactSecrets } from "../security/sanitize";

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpStatusError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

/**
 * Minimal JSON HTTP client for marketplace APIs with the error vocabulary the
 * job queue understands: 429 → RateLimitError (honours Retry-After),
 * other 4xx → PermanentError (retrying will not help), 5xx/network → plain
 * Error (retry with backoff). Error text is redacted before it is thrown.
 */
export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, { method: opts.method ?? "GET", headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30000) });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.ok) return parsed as T;

  const summary = redactSecrets(typeof parsed === "string" ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 600));
  const host = new URL(url).host;
  if (res.status === 429) {
    throw new RateLimitError(`${host} rate limit reached`, Number(res.headers.get("retry-after")) || 60);
  }
  if (res.status === 401) throw new HttpStatusError(401, `${host} rejected the credentials (401)`, parsed);
  if (res.status >= 400 && res.status < 500) throw new PermanentError(`${host} rejected the request (${res.status}): ${summary}`);
  throw new HttpStatusError(res.status, `${host} error ${res.status}: ${summary}`, parsed);
}
