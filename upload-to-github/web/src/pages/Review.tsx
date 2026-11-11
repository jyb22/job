import { useState } from "react";
import { api, canWrite, cap, Card, Empty, Loading, MARKETPLACE_NAMES, money, SimChip, Status, useAction, useLoad, useMe, useToast, when, words } from "../ui";

interface Approval {
  id: string;
  kind: string;
  status: string;
  product_id: string | null;
  listing_id: string | null;
  marketplace: string | null;
  action: Record<string, any>;
  reasons: { code: string; message: string }[];
  risk: string;
  requested_by: string;
  requested_at: string;
  expires_at: string | null;
  decided_at: string | null;
  note: string | null;
  sku: string | null;
  productTitle: string | null;
}
interface Task {
  id: string;
  kind: "post_listing" | "end_listing" | "update_listing";
  listing_id: string;
  product_id: string;
  marketplace: string;
  marketplaceName: string;
  urgent: number;
  payload: Record<string, any>;
  created_at: string;
  sku: string | null;
  productTitle: string | null;
}
interface Data {
  approvals: Approval[];
  tasks: Task[];
  products: { id: string; sku: string; title: string | null; brand: string | null; status: string; criticalMissing: string[]; risk_flags: string[] }[];
  failedListings: { id: string; product_id: string; marketplace: string; title: string; last_error: string | null; sku: string | null; simulated: boolean }[];
  discrepancies: { id: string; kind: string; marketplace: string | null; expected: string | null; actual: string | null; detected_at: string; product_id: string | null; sku: string | null; productTitle: string | null }[];
  deadJobs: { id: string; type: string; attempts: number; last_error: string | null; updated_at: string }[];
  recentDecisions: Approval[];
}

const KIND: Record<string, string> = { "listing.publish": "Publish listing", "listing.reprice": "Change price", "listing.end": "End listing", "listing.update_content": "Edit live listing" };

export function Review({ onChange }: { onChange: () => Promise<void> }) {
  const me = useMe();
  const { data, error, reload } = useLoad<Data>("/api/review", 6000);
  const [busy, run] = useAction();
  if (!data) return <Loading error={error} />;
  const write = canWrite(me);
  const refresh = async () => {
    await reload();
    await onChange();
    // Approved work runs in the background a moment later; look again so its result shows up.
    window.setTimeout(() => void reload().then(onChange), 1500);
  };
  const nothing = !data.approvals.length && !data.tasks.length && !data.products.length && !data.failedListings.length && !data.discrepancies.length && !data.deadJobs.length;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Review queue</h1>
          <p>Everything waiting on a person: approvals, listings to post by hand, items that need details, and problems.</p>
        </div>
        {write && (
          <button disabled={busy} onClick={() => run(async () => { const r = await api("/api/reconcile", { body: {} }); await refresh(); return `Checked ${r.summary.checked} listing(s): ${r.summary.found} new discrepancy(ies)${r.summary.unverifiable ? `, ${r.summary.unverifiable} on marketplaces that cannot be checked automatically` : ""}`; })}>
            Check marketplaces now
          </button>
        )}
      </div>

      {nothing && (
        <Card>
          <Empty>Nothing needs you right now.</Empty>
        </Card>
      )}

      {data.tasks.length > 0 && (
        <Card title={`To do by hand (${data.tasks.length})`}>
          <div className="stack">
            {data.tasks.map((t) => (
              <TaskCard key={t.id} t={t} refresh={refresh} write={write} />
            ))}
          </div>
        </Card>
      )}

      {data.approvals.length > 0 && (
        <Card title={`Approvals (${data.approvals.length})`}>
          <div className="stack">
            {data.approvals.map((a) => (
              <ApprovalCard key={a.id} a={a} refresh={refresh} write={write} owner={me.role === "owner"} />
            ))}
          </div>
        </Card>
      )}

      {data.products.length > 0 && (
        <Card title={`Items that need details (${data.products.length})`} tight>
          <table>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={`#/product/${p.id}`}>
                      <strong>{p.title || p.brand || "Unidentified item"}</strong>
                    </a>
                    <div className="muted small mono">{p.sku}</div>
                  </td>
                  <td>
                    <Status value={p.status} />
                  </td>
                  <td className="small">
                    {p.criticalMissing.length > 0 && <>Missing: {p.criticalMissing.join(", ")}. </>}
                    {p.risk_flags.length > 0 && <>Flags: {p.risk_flags.map((f) => words(f)).join("; ")}.</>}
                  </td>
                  <td className="right">
                    <a href={`#/product/${p.id}`}>
                      <button className="sm">Open</button>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data.failedListings.length > 0 && (
        <Card title={`Failed publications (${data.failedListings.length})`} tight>
          <table>
            <tbody>
              {data.failedListings.map((l) => (
                <tr key={l.id}>
                  <td>
                    <a href={`#/product/${l.product_id}`}>
                      <strong>{l.title || l.sku}</strong>
                    </a>
                    <div className="muted small">
                      {MARKETPLACE_NAMES[l.marketplace]} {l.simulated && <SimChip />}
                    </div>
                  </td>
                  <td className="small">{l.last_error}</td>
                  <td className="right">
                    {write && (
                      <button className="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/listings/${l.id}/publish`, { body: {} }); await refresh(); return "Trying again"; })}>
                        Try again
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data.discrepancies.length > 0 && (
        <Card title={`Inventory discrepancies (${data.discrepancies.length})`} tight>
          <table>
            <thead>
              <tr>
                <th>Problem</th>
                <th>Item</th>
                <th>Expected</th>
                <th>Found</th>
                <th>Detected</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.discrepancies.map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className={`chip ${d.kind.includes("oversale") || d.kind.includes("still_live") || d.kind.includes("cross_delist") ? "bad" : "warn"}`}>{cap(words(d.kind))}</span>
                    {d.marketplace && <span className="muted small"> {MARKETPLACE_NAMES[d.marketplace] ?? d.marketplace}</span>}
                  </td>
                  <td>{d.product_id ? <a href={`#/product/${d.product_id}`}>{d.productTitle || d.sku}</a> : "—"}</td>
                  <td className="small">{d.expected}</td>
                  <td className="small">{d.actual}</td>
                  <td className="muted small nowrap">{when(d.detected_at)}</td>
                  <td className="right">
                    {write && (
                      <button
                        className="sm"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const resolution = window.prompt("How was this resolved?");
                            if (!resolution) return;
                            await api(`/api/discrepancies/${d.id}/resolve`, { body: { resolution } });
                            await refresh();
                            return "Marked resolved";
                          })
                        }
                      >
                        Mark resolved
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data.deadJobs.length > 0 && (
        <Card title={`Background jobs that gave up (${data.deadJobs.length})`} tight>
          <table>
            <tbody>
              {data.deadJobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <strong>{words(j.type)}</strong>
                    <div className="muted small">
                      {j.attempts} attempt(s) · {when(j.updated_at)}
                    </div>
                  </td>
                  <td className="small">{j.last_error}</td>
                  <td className="right">
                    {write && (
                      <button className="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/jobs/${j.id}/retry`, { body: {} }); await refresh(); return "Queued again"; })}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data.recentDecisions.length > 0 && (
        <Card title="Recent decisions" tight>
          <table>
            <tbody>
              {data.recentDecisions.slice(0, 12).map((a) => (
                <tr key={a.id}>
                  <td>
                    {KIND[a.kind] ?? a.kind}
                    {a.marketplace ? ` · ${MARKETPLACE_NAMES[a.marketplace]}` : ""}
                    <div className="muted small">{a.productTitle || a.sku}</div>
                  </td>
                  <td>
                    <Status value={a.status === "consumed" ? "done" : a.status} />
                  </td>
                  <td className="muted small">{a.note}</td>
                  <td className="muted small nowrap right">{when(a.decided_at ?? a.requested_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ApprovalCard({ a, refresh, write, owner }: { a: Approval; refresh: () => Promise<void>; write: boolean; owner: boolean }) {
  const [busy, run] = useAction();
  const allowed = write && (a.risk !== "high" || owner);
  const decide = (decision: "approve" | "reject") =>
    run(async () => {
      const note = decision === "reject" ? (window.prompt("Reason (optional):") ?? "") : "";
      await api(`/api/approvals/${a.id}/decide`, { body: { decision, note } });
      await refresh();
      return decision === "approve" ? "Approved" : "Rejected";
    });
  return (
    <div className="listing">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <strong>{KIND[a.kind] ?? a.kind}</strong>
          {a.marketplace && <span className="chip">{MARKETPLACE_NAMES[a.marketplace]}</span>}
          {a.risk === "high" && <span className="chip bad">High risk · owner only</span>}
        </div>
        <span className="muted small">
          Asked {when(a.requested_at)} by {a.requested_by.startsWith("agent") ? "the agent" : "a user"} · expires {a.expires_at ? new Date(a.expires_at).toLocaleDateString() : "—"}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>
        <a href={`#/product/${a.product_id}`}>{a.productTitle || a.sku || "Open item"}</a>
        {a.action.priceCents !== undefined && <span className="num"> · {money(a.action.priceCents)}</span>}
        {a.action.newPriceCents !== undefined && (
          <span className="num">
            {" "}
            · {money(a.action.fromCents)} → {money(a.action.newPriceCents)}
          </span>
        )}
      </div>
      <ul className="plain small" style={{ marginTop: 6 }}>
        {a.reasons.map((r) => (
          <li key={r.code}>{r.message}</li>
        ))}
      </ul>
      {write && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary sm" disabled={busy || !allowed} onClick={() => decide("approve")} title={allowed ? "" : "Only an owner can approve high-risk actions"}>
            Approve
          </button>
          <button className="sm" disabled={busy || !allowed} onClick={() => decide("reject")}>
            Reject
          </button>
          <span className="muted small">Approving covers exactly this listing at this price. If either changes, a new approval is needed.</span>
        </div>
      )}
    </div>
  );
}

function TaskCard({ t, refresh, write }: { t: Task; refresh: () => Promise<void>; write: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, run] = useAction();
  const toast = useToast();
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`);
    } catch {
      toast("Copy is not available in this browser — select the text instead.", true);
    }
  };
  const heading = t.kind === "post_listing" ? `Post on ${t.marketplaceName}` : t.kind === "end_listing" ? `End listing on ${t.marketplaceName}` : `Update listing on ${t.marketplaceName}`;
  return (
    <div className="listing" style={t.urgent ? { borderColor: "var(--danger)" } : undefined}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <strong>{heading}</strong>
          {t.urgent === 1 && <span className="chip bad">Sold elsewhere — do this now</span>}
        </div>
        <span className="muted small">
          <a href={`#/product/${t.product_id}`}>{t.productTitle || t.sku}</a> · {when(t.created_at)}
        </span>
      </div>

      {t.kind === "post_listing" && (
        <div className="stack" style={{ marginTop: 8 }}>
          <dl className="kv">
            {t.payload.title && (
              <>
                <dt>Title</dt>
                <dd>
                  {t.payload.title}{" "}
                  <button className="ghost sm" onClick={() => copy(t.payload.title, "Title")}>
                    Copy
                  </button>
                </dd>
              </>
            )}
            <dt>Price</dt>
            <dd className="num">{money(t.payload.priceCents)}</dd>
            <dt>Category</dt>
            <dd>{t.payload.category}</dd>
            <dt>Description</dt>
            <dd>
              <div className="pre small" style={{ maxHeight: 130, overflowY: "auto" }}>{t.payload.description}</div>
              <button className="ghost sm" onClick={() => copy(t.payload.description, "Description")}>
                Copy description
              </button>
            </dd>
            <dt>Photos</dt>
            <dd>
              <a href={`#/product/${t.product_id}`}>Open the item</a> to download the optimised photos.
            </dd>
          </dl>
          {write && (
            <div className="row">
              <input placeholder={`Paste the ${t.marketplaceName} listing link (https://…)`} value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <button className="primary sm" disabled={busy || !url} onClick={() => run(async () => { await api(`/api/tasks/${t.id}/complete`, { body: { externalUrl: url } }); await refresh(); return "Recorded as live"; })}>
                I posted it
              </button>
            </div>
          )}
        </div>
      )}

      {t.kind !== "post_listing" && (
        <div className="stack" style={{ marginTop: 8 }}>
          <div>
            {t.payload.title}
            {t.payload.change && <strong> — {t.payload.change}</strong>}
            {t.payload.url && (
              <>
                {" "}
                ·{" "}
                <a href={t.payload.url} target="_blank" rel="noreferrer noopener">
                  Open listing
                </a>
              </>
            )}
          </div>
          {write && (
            <div className="row">
              <button className="primary sm" disabled={busy} onClick={() => run(async () => { await api(`/api/tasks/${t.id}/complete`, { body: {} }); await refresh(); return "Recorded"; })}>
                {t.kind === "end_listing" ? "I ended it" : "Done"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
