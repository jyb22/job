import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// ---- API client -----------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "resale-ops" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, credentials: "same-origin" });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.includes("/auth/")) window.dispatchEvent(new Event("rs-unauthenticated"));
    const detail = Array.isArray(data?.detail) ? ` (${data.detail.map((d: any) => `${d.path}: ${d.message}`).join("; ")})` : "";
    throw new ApiError((data?.message ?? `Request failed (${res.status})`) + detail, res.status, data?.error, data?.detail);
  }
  return data as T;
}

/** Load data, with reload() and optional polling. */
export function useLoad<T>(path: string | null, pollMs?: number): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const current = useRef(path);
  current.current = path;
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      if (current.current === path) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs, path]);
  return { data, error, loading, reload };
}

// ---- toast ------------------------------------------------------------------------
const ToastCtx = createContext<(message: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; bad: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((message: string, bad = false) => {
    setToast({ message, bad });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), bad ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">
          {toast.message}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/** Run an action with a busy flag; failures become a toast instead of an unhandled error. */
export function useAction(): [boolean, (fn: () => Promise<string | void>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = useCallback(
    async (fn: () => Promise<string | void>) => {
      setBusy(true);
      try {
        const message = await fn();
        if (message) toast(message);
      } catch (e) {
        toast((e as Error).message, true);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return [busy, run];
}

// ---- formatting ---------------------------------------------------------------------
export const money = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
export const toCents = (text: string): number | null => {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
};
export const fromCents = (cents: number | null | undefined): string => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));
export const when = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
};
export const words = (s: string | null | undefined): string => (s ?? "").replace(/[_.:]/g, " ");
export const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const STATUS_TONE: Record<string, string> = {
  published: "ok", sold: "ok", verified: "ok", done: "ok", approved: "info", connected: "ok", succeeded: "ok",
  ready_to_publish: "info", publishing: "info", processing: "info", awaiting_operator: "warn", new: "info", queued: "info", running: "info",
  needs_review: "warn", identification_required: "warn", delisting_pending: "warn", pending: "warn", unverified: "warn", assisted: "",
  publication_failed: "bad", conflict: "bad", dead: "bad", error: "bad", rejected: "bad", expired: "", disconnected: "bad",
  delisted: "", archived: "", draft: "", simulated: "sim",
};
const STATUS_LABEL: Record<string, string> = {
  awaiting_operator: "Waiting for you to post",
  identification_required: "Needs identification",
  ready_to_publish: "Ready to publish",
  publication_failed: "Publish failed",
  delisting_pending: "Ending…",
  needs_review: "Needs review",
};
export function Status({ value }: { value: string | null | undefined }) {
  const v = value ?? "unknown";
  return <span className={`chip ${STATUS_TONE[v] ?? ""}`}>{STATUS_LABEL[v] ?? cap(words(v))}</span>;
}
export const SimChip = () => <span className="chip sim" title="Simulated: nothing was sent to a real marketplace">Simulated</span>;

// ---- small components ---------------------------------------------------------------
export function Card({ title, actions, children, tight }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; tight?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header>
          <h2>{title}</h2>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`body ${tight ? "tight" : ""}`}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, alert }: { label: string; value: ReactNode; sub?: ReactNode; alert?: boolean }) {
  return (
    <div className={`kpi ${alert ? "alert" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      {label}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Check({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/** Dollar input bound to a cents value. Commits on blur so partial typing is not rejected. */
export function MoneyInput({ cents, onChange, placeholder, allowEmpty }: { cents: number | null; onChange: (cents: number | null) => void; placeholder?: string; allowEmpty?: boolean }) {
  const [text, setText] = useState(fromCents(cents));
  useEffect(() => setText(fromCents(cents)), [cents]);
  return (
    <input
      inputMode="decimal"
      value={text}
      placeholder={placeholder ?? "0.00"}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() === "" && allowEmpty) return onChange(null);
        const c = toCents(text);
        if (c === null) setText(fromCents(cents));
        else onChange(c);
      }}
    />
  );
}

export function NumberInput({ value, onChange, min, max, step }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text);
        if (!Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) setText(String(value));
        else onChange(step === 1 ? Math.round(n) : n);
      }}
    />
  );
}

export function Loading({ error }: { error?: string | null }) {
  return <div className="empty">{error ? `Could not load: ${error}` : "Loading…"}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Img({ id, className, alt }: { id: string | null | undefined; className?: string; alt?: string }) {
  if (!id) return <div className={`${className ?? "thumb"} blank`}>No photo</div>;
  return <img className={className ?? "thumb"} src={`/api/images/${id}`} alt={alt ?? ""} loading="lazy" />;
}

export const MARKETPLACE_NAMES: Record<string, string> = { ebay: "eBay", depop: "Depop", mercari: "Mercari", poshmark: "Poshmark", etsy: "Etsy", facebook: "Facebook" };
export const CONDITIONS = ["new_with_tags", "new_without_tags", "like_new", "excellent", "good", "fair", "poor"];

export function navigate(hash: string) {
  window.location.hash = hash;
}

export interface Me {
  id: string;
  email: string;
  role: "owner" | "manager" | "viewer";
}
export const MeCtx = createContext<Me>({ id: "", email: "", role: "viewer" });
export const useMe = () => useContext(MeCtx);
export const canWrite = (me: Me) => me.role !== "viewer";
