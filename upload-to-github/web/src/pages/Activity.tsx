import { useState } from "react";
import { api, cap, Card, Empty, Loading, MARKETPLACE_NAMES, Status, useAction, useLoad, when, words } from "../ui";

interface Entry {
  id: number;
  at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  product_id: string | null;
  marketplace: string | null;
  outcome: string;
  detail: any;
}
interface Note {
  id: string;
  at: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  product_id: string | null;
  read_at: string | null;
  delivery: string;
}

const FILTERS: [string, string][] = [
  ["", "Everything"],
  ["authorization", "Authorisation checks"],
  ["listing", "Listings"],
  ["sale", "Sales"],
  ["inventory", "Inventory"],
  ["cross_delist", "Cross-delisting"],
  ["pricing", "Pricing"],
  ["ai", "AI decisions"],
  ["approval", "Approvals"],
  ["automation", "Automation controls"],
  ["settings", "Settings"],
  ["connection", "Connections"],
  ["auth", "Sign-ins"],
  ["job", "Background jobs"],
];

export function Activity() {
  const [tab, setTab] = useState<"log" | "alerts">("log");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const params = new URLSearchParams({ limit: "200" });
  if (action) params.set("action", action);
  if (outcome) params.set("outcome", outcome);
  const log = useLoad<{ entries: Entry[] }>(tab === "log" ? `/api/audit?${params}` : null, 8000);
  const notes = useLoad<{ notifications: Note[]; unread: number }>(tab === "alerts" ? "/api/notifications" : null, 8000);
  const [busy, run] = useAction();

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>A permanent record of every decision and action, and every alert raised.</p>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>
          Audit log
        </button>
        <button className={tab === "alerts" ? "active" : ""} onClick={() => setTab("alerts")}>
          Alerts
        </button>
      </div>

      {tab === "log" && (
        <Card
          tight
          title={
            <div className="row">
              <select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 220 }}>
                {FILTERS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 170 }}>
                <option value="">Any outcome</option>
                <option value="ok">Succeeded</option>
                <option value="pending">Waiting</option>
                <option value="denied">Denied</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          }
        >
          {!log.data ? (
            <Loading error={log.error} />
          ) : log.data.entries.length === 0 ? (
            <Empty>Nothing recorded for that filter.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Marketplace</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.entries.map((e) => (
                    <tr key={e.id} className="click" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <td className="muted small nowrap">{new Date(e.at).toLocaleString()}</td>
                      <td className="small">{e.actor_type === "agent" ? "Agent" : e.actor_type === "user" ? "User" : "System"}</td>
                      <td>
                        {cap(words(e.action))}
                        {e.product_id && (
                          <>
                            {" · "}
                            <a href={`#/product/${e.product_id}`} onClick={(ev) => ev.stopPropagation()}>
                              item
                            </a>
                          </>
                        )}
                        {open === e.id && e.detail && <pre className="pre small mono" style={{ margin: "6px 0 0" }}>{JSON.stringify(e.detail, null, 2)}</pre>}
                      </td>
                      <td className="small">{e.marketplace ? (MARKETPLACE_NAMES[e.marketplace] ?? e.marketplace) : ""}</td>
                      <td>{e.outcome === "ok" ? <span className="muted small">ok</span> : <Status value={e.outcome === "denied" ? "rejected" : e.outcome === "failed" ? "error" : "pending"} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === "alerts" && (
        <Card
          tight
          title={`Alerts${notes.data?.unread ? ` (${notes.data.unread} unread)` : ""}`}
          actions={
            <button className="sm" disabled={busy || !notes.data?.unread} onClick={() => run(async () => { await api("/api/notifications/read", { body: { id: "all" } }); await notes.reload(); })}>
              Mark all read
            </button>
          }
        >
          {!notes.data ? (
            <Loading error={notes.error} />
          ) : notes.data.notifications.length === 0 ? (
            <Empty>No alerts yet.</Empty>
          ) : (
            <table>
              <tbody>
                {notes.data.notifications.map((n) => (
                  <tr key={n.id} style={n.read_at ? { opacity: 0.65 } : undefined}>
                    <td style={{ width: 110 }}>
                      <span className={`chip ${n.severity === "critical" ? "bad" : n.severity === "warning" ? "warn" : "info"}`}>{cap(n.severity)}</span>
                    </td>
                    <td>
                      <strong>{n.title}</strong>
                      <div className="pre small muted">{n.body}</div>
                      {n.product_id && (
                        <a className="small" href={`#/product/${n.product_id}`}>
                          Open item
                        </a>
                      )}
                    </td>
                    <td className="muted small nowrap right">{when(n.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
