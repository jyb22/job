import { useState } from "react";
import { api, canWrite, cap, Card, Check, Empty, Kpi, Loading, MARKETPLACE_NAMES, money, SimChip, useAction, useLoad, useMe, when, words } from "../ui";

interface Data {
  overview: { sales: { orders: number; revenueCents: number; netProceedsCents: number; netProfitCents: number; marginPct: number | null }; simulated: { orders: number } };
  marketplaces: { marketplace: string; name: string; orders: number; revenueCents: number; feesCents: number; feesVerifiedOrders: number; netProceedsCents: number; netProfitCents: number; marginPct: number | null; averageSaleCents: number | null; averageDaysToSell: number | null; activeListings: number }[];
  categories: { category: string; orders: number; revenueCents: number; netProfitCents: number; averageSaleCents: number; averageDaysToSell: number | null; marginPct: number | null }[];
  products: { id: string; sku: string; title: string | null; marketplace: string; salePriceCents: number; feesCents: number; feesVerified: number; costCents: number | null; netProfitCents: number | null; soldAt: string; daysToSell: number | null; simulated: number }[];
  aging: { buckets: { label: string; products: number; units: number; costCents: number }[]; slowest: { id: string; sku: string; title: string | null; brand: string | null; ageDays: number; status: string }[] };
  velocity: { windowDays: number; unitsSold: number; unitsPerWeek: number; revenueCents: number; sellThroughPct: number | null; inventoryTurnover: number | null };
  insights: { kind: string; message: string; basis: string }[];
  metricSupport: { marketplace: string; name: string; automaticMetrics: boolean; note: string }[];
}
interface Opt {
  metricsCollected: number;
  metricsUnavailable: number;
  recommendations: { listingId: string; productId: string; marketplace: string; title: string; ageDays: number; kind: string; message: string }[];
  evaluations: { listingId: string; marketplace: string; title: string; field: string; at: string; before: string | null; after: string | null; verdict: string }[];
}
interface Report {
  id: string;
  generated_at: string;
  data: { title: string; includesSimulatedData: boolean; period: { orders: number; revenueCents: number; netProfitCents: number; marginPct: number | null; ordersWithVerifiedFees: number; ordersWithEstimatedFees: number } };
}

const VERDICT: Record<string, [string, string]> = { sold_after_change: ["Sold after the change", "ok"], more_engagement: ["More engagement since", "ok"], no_improvement: ["No improvement yet", "warn"], not_enough_data: ["Not enough data", ""] };

export function Analytics() {
  const me = useMe();
  const [sim, setSim] = useState(false);
  const { data, error } = useLoad<Data>(`/api/analytics${sim ? "?simulated=1" : ""}`);
  const opt = useLoad<Opt>("/api/optimization");
  const reports = useLoad<{ reports: Report[] }>("/api/reports");
  const [busy, run] = useAction();
  if (!data) return <Loading error={error} />;
  const maxAge = Math.max(1, ...data.aging.buckets.map((b) => b.units));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Results from recorded sales. Projections and estimates are always labelled.</p>
        </div>
        {data.overview.simulated.orders > 0 && <Check label="Include simulated sales" checked={sim} onChange={setSim} />}
      </div>
      {sim && (
        <div className="banner sim">
          <span>
            <strong>Simulated sales are included</strong> in the figures below. They are demo data, not income.
          </span>
        </div>
      )}

      <div className="kpis">
        <Kpi label="Orders" value={data.overview.sales.orders} />
        <Kpi label="Revenue" value={money(data.overview.sales.revenueCents)} />
        <Kpi label="Net profit" value={money(data.overview.sales.netProfitCents)} sub={data.overview.sales.marginPct === null ? undefined : `${data.overview.sales.marginPct}% margin`} />
        <Kpi label={`Units / week (last ${data.velocity.windowDays} days)`} value={data.velocity.unitsPerWeek} sub={`${data.velocity.unitsSold} sold`} />
        <Kpi label="Sell-through" value={data.velocity.sellThroughPct === null ? "—" : `${data.velocity.sellThroughPct}%`} sub="sold ÷ (sold + in stock)" />
        <Kpi label="Inventory turnover" value={data.velocity.inventoryTurnover ?? "—"} sub="cost sold ÷ cost on hand" />
      </div>

      <Card title="What the numbers say">
        <ul className="plain">
          {data.insights.map((i, n) => (
            <li key={n}>
              {i.message} <span className="muted small">({i.basis})</span>
            </li>
          ))}
        </ul>
        <p className="muted small" style={{ marginTop: 8 }}>
          These are observations to inform your buying. The system never purchases inventory or commits money.
        </p>
      </Card>

      <Card title="By marketplace" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Marketplace</th>
                <th className="right">Orders</th>
                <th className="right">Revenue</th>
                <th className="right">Fees</th>
                <th className="right">Net proceeds</th>
                <th className="right">Net profit</th>
                <th className="right">Margin</th>
                <th className="right">Avg sale</th>
                <th className="right">Avg days to sell</th>
              </tr>
            </thead>
            <tbody>
              {data.marketplaces.map((m) => (
                <tr key={m.marketplace}>
                  <td>
                    <strong>{m.name}</strong>
                  </td>
                  <td className="right num">{m.orders}</td>
                  <td className="right num">{money(m.revenueCents)}</td>
                  <td className="right num">
                    {money(m.feesCents)}
                    {m.orders > 0 && m.feesVerifiedOrders < m.orders && <span className="muted small"> est.</span>}
                  </td>
                  <td className="right num">{money(m.netProceedsCents)}</td>
                  <td className="right num">{money(m.netProfitCents)}</td>
                  <td className="right num">{m.marginPct === null ? "—" : `${m.marginPct}%`}</td>
                  <td className="right num">{money(m.averageSaleCents)}</td>
                  <td className="right num">{m.averageDaysToSell ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid2">
        <Card title="By category" tight>
          {data.categories.length === 0 ? (
            <Empty>No sales yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="right">Orders</th>
                  <th className="right">Profit</th>
                  <th className="right">Margin</th>
                  <th className="right">Days to sell</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.category}>
                    <td>{cap(c.category)}</td>
                    <td className="right num">{c.orders}</td>
                    <td className="right num">{money(c.netProfitCents)}</td>
                    <td className="right num">{c.marginPct === null ? "—" : `${c.marginPct}%`}</td>
                    <td className="right num">{c.averageDaysToSell ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Unsold stock by age">
          <div className="stack">
            {data.aging.buckets.map((b) => (
              <div key={b.label}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>{b.label}</span>
                  <span className="num muted small">
                    {b.units} unit(s) · {money(b.costCents)} cost
                  </span>
                </div>
                <div className="bar">
                  <div className="track">
                    <i style={{ width: `${(b.units / maxAge) * 100}%` }} />
                  </div>
                </div>
              </div>
            ))}
            {data.aging.slowest.length > 0 && (
              <p className="muted small">
                Longest in stock:{" "}
                {data.aging.slowest.slice(0, 4).map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && ", "}
                    <a href={`#/product/${s.id}`}>{s.title || s.brand || s.sku}</a> ({s.ageDays}d)
                  </span>
                ))}
              </p>
            )}
          </div>
        </Card>
      </div>

      <Card title="Profit by sale" tight>
        {data.products.length === 0 ? (
          <Empty>No sales yet.</Empty>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Marketplace</th>
                  <th className="right">Sold for</th>
                  <th className="right">Fees</th>
                  <th className="right">Cost</th>
                  <th className="right">Profit</th>
                  <th className="right">Days to sell</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <a href={`#/product/${p.id}`}>{p.title || p.sku}</a>
                    </td>
                    <td className="nowrap">
                      {MARKETPLACE_NAMES[p.marketplace]} {p.simulated === 1 && <SimChip />}
                    </td>
                    <td className="right num">{money(p.salePriceCents)}</td>
                    <td className="right num">
                      {money(p.feesCents)}
                      {!p.feesVerified && <span className="muted small"> est.</span>}
                    </td>
                    <td className="right num">{money(p.costCents)}</td>
                    <td className="right num">{money(p.netProfitCents)}</td>
                    <td className="right num">{p.daysToSell ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Listing performance"
        actions={
          canWrite(me) && (
            <button className="sm" disabled={busy} onClick={() => run(async () => { const r = await api("/api/optimization/run", { body: {} }); await opt.reload(); return `Checked live listings: ${r.recommendations.length} suggestion(s). Price changes went through your rules.`; })}>
              Run optimisation now
            </button>
          )
        }
      >
        <div className="stack">
          <div className="chips">
            {data.metricSupport.map((m) => (
              <span key={m.marketplace} className={`chip ${m.automaticMetrics ? "ok" : ""}`} title={m.note}>
                {m.name}: {m.automaticMetrics ? "metrics collected" : "no automatic metrics"}
              </span>
            ))}
          </div>
          {!opt.data ? (
            <Loading error={opt.error} />
          ) : opt.data.recommendations.length === 0 ? (
            <p className="muted">No suggestions for live listings right now.</p>
          ) : (
            <table>
              <tbody>
                {opt.data.recommendations.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <a href={`#/product/${r.productId}`}>{r.title}</a>
                      <div className="muted small">
                        {MARKETPLACE_NAMES[r.marketplace]} · listed {r.ageDays} days
                      </div>
                    </td>
                    <td>
                      <span className="chip warn">{cap(words(r.kind))}</span>
                    </td>
                    <td className="small">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {opt.data && opt.data.evaluations.length > 0 && (
            <>
              <div className="divider" />
              <h3>Did past changes help?</h3>
              <table>
                <tbody>
                  {opt.data.evaluations.slice(0, 15).map((e, i) => (
                    <tr key={i}>
                      <td>
                        {e.title}
                        <div className="muted small">
                          {MARKETPLACE_NAMES[e.marketplace]} · {when(e.at)}
                        </div>
                      </td>
                      <td className="small">{e.field === "price_cents" ? `Price ${money(Number(e.before))} → ${money(Number(e.after))}` : `${cap(e.field)} rewritten`}</td>
                      <td>
                        <span className={`chip ${VERDICT[e.verdict]?.[1] ?? ""}`}>{VERDICT[e.verdict]?.[0] ?? e.verdict}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </Card>

      <Card
        title="Business reports"
        actions={
          canWrite(me) && (
            <>
              <button className="sm" disabled={busy} onClick={() => run(async () => { await api("/api/reports", { body: { days: 7, includeSimulated: sim } }); await reports.reload(); return "Weekly report generated"; })}>
                Generate 7-day report
              </button>
              <button className="sm" disabled={busy} onClick={() => run(async () => { await api("/api/reports", { body: { days: 30, includeSimulated: sim } }); await reports.reload(); return "30-day report generated"; })}>
                30-day
              </button>
            </>
          )
        }
        tight
      >
        {!reports.data?.reports.length ? (
          <Empty>No reports yet. One is generated automatically on the schedule in Settings.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Report</th>
                <th className="right">Orders</th>
                <th className="right">Revenue</th>
                <th className="right">Net profit</th>
                <th className="right">Margin</th>
                <th>Fees</th>
                <th>Generated</th>
              </tr>
            </thead>
            <tbody>
              {reports.data.reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.data.title} {r.data.includesSimulatedData && <SimChip />}
                  </td>
                  <td className="right num">{r.data.period.orders}</td>
                  <td className="right num">{money(r.data.period.revenueCents)}</td>
                  <td className="right num">{money(r.data.period.netProfitCents)}</td>
                  <td className="right num">{r.data.period.marginPct === null ? "—" : `${r.data.period.marginPct}%`}</td>
                  <td className="small muted">
                    {r.data.period.ordersWithVerifiedFees} verified · {r.data.period.ordersWithEstimatedFees} estimated
                  </td>
                  <td className="muted small nowrap">{when(r.generated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
