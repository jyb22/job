import { Card, Empty, Kpi, Loading, money, Status, useLoad, when } from "../ui";

interface Data {
  overview: {
    inventory: { products: number; units: number; acquisitionCostCents: number; productsWithUnknownCost: number; unsoldCostCents: number };
    listings: { active: number; listedValueCents: number };
    sales: { orders: number; unitsSold: number; revenueCents: number; netProceedsCents: number; netProceedsVerifiedCents: number; netProceedsEstimatedCents: number; netProfitCents: number; marginPct: number | null; ordersMissingCost: number };
    simulated: { orders: number; revenueCents: number };
    attention: Record<string, number>;
  };
  marketplaces: { marketplace: string; name: string; mode: string; connectionStatus: string; activeListings: number; listedValueCents: number; waiting: number; failed: number; orders: number; revenueCents: number; netProfitCents: number; marginPct: number | null }[];
  jobs: Record<string, number>;
}

const ATTENTION: [string, string, string][] = [
  ["approvals", "approvals waiting for your decision", "#/review"],
  ["urgentTasks", "sold items still listed elsewhere — end them now", "#/review"],
  ["operatorTasks", "listings to post or update by hand", "#/review"],
  ["identificationRequired", "products that need identifying", "#/review"],
  ["needsReview", "products that need review", "#/review"],
  ["failedPublications", "listings that failed to publish", "#/review"],
  ["discrepancies", "inventory discrepancies", "#/review"],
  ["deadJobs", "background jobs that gave up", "#/review"],
];

export function Overview() {
  const { data, error } = useLoad<Data>("/api/overview", 10000);
  const notes = useLoad<{ notifications: { id: string; at: string; severity: string; title: string; body: string }[] }>("/api/notifications", 15000);
  if (!data) return <Loading error={error} />;
  const o = data.overview;
  const attention = ATTENTION.filter(([key]) => (o.attention[key] ?? 0) > 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Where the business stands right now.</p>
        </div>
        <a href="#/inventory">
          <button className="primary">Add items</button>
        </a>
      </div>

      {attention.length > 0 && (
        <Card title="Needs your attention">
          <ul className="plain">
            {attention.map(([key, label, href]) => (
              <li key={key}>
                <a href={href}>
                  <strong>{o.attention[key]}</strong> {label}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="kpis">
        <Kpi label="Units in stock" value={o.inventory.units} sub={`${o.inventory.products} products`} />
        <Kpi label="Active listings" value={o.listings.active} sub={`${money(o.listings.listedValueCents)} asking (projected)`} />
        <Kpi label="Cost of unsold stock" value={money(o.inventory.unsoldCostCents)} sub={o.inventory.productsWithUnknownCost ? `${o.inventory.productsWithUnknownCost} with no cost recorded` : "from recorded costs"} />
        <Kpi label="Units sold" value={o.sales.unitsSold} sub={`${o.sales.orders} orders`} />
        <Kpi label="Revenue" value={money(o.sales.revenueCents)} sub="recorded sales" />
        <Kpi label="Net proceeds" value={money(o.sales.netProceedsCents)} sub={`${money(o.sales.netProceedsVerifiedCents)} verified · ${money(o.sales.netProceedsEstimatedCents)} fees estimated`} />
        <Kpi label="Net profit" value={money(o.sales.netProfitCents)} sub={o.sales.ordersMissingCost ? `${o.sales.ordersMissingCost} sale(s) missing a cost` : "after fees, shipping and cost"} />
        <Kpi label="Profit margin" value={o.sales.marginPct === null ? "—" : `${o.sales.marginPct}%`} sub="net profit ÷ revenue" />
      </div>
      {o.simulated.orders > 0 && (
        <div className="banner sim">
          <span>
            <strong>{o.simulated.orders} simulated sale(s)</strong> ({money(o.simulated.revenueCents)}) exist from demo activity. They are left out of every figure above.
          </span>
        </div>
      )}

      <Card title="Marketplaces" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Marketplace</th>
                <th>Connection</th>
                <th className="right">Active</th>
                <th className="right">Asking value</th>
                <th className="right">Waiting</th>
                <th className="right">Orders</th>
                <th className="right">Revenue</th>
                <th className="right">Net profit</th>
                <th className="right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {data.marketplaces.map((m) => (
                <tr key={m.marketplace}>
                  <td>
                    <strong>{m.name}</strong>
                  </td>
                  <td>
                    <Status value={m.mode === "api" ? m.connectionStatus : m.mode} />
                  </td>
                  <td className="right num">{m.activeListings}</td>
                  <td className="right num">{money(m.listedValueCents)}</td>
                  <td className="right num">{m.waiting + m.failed}</td>
                  <td className="right num">{m.orders}</td>
                  <td className="right num">{money(m.revenueCents)}</td>
                  <td className="right num">{money(m.netProfitCents)}</td>
                  <td className="right num">{m.marginPct === null ? "—" : `${m.marginPct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid2">
        <Card title="Recent alerts" actions={<a href="#/activity">All activity</a>} tight>
          {notes.data?.notifications.length ? (
            <table>
              <tbody>
                {notes.data.notifications.slice(0, 8).map((n) => (
                  <tr key={n.id}>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {n.severity !== "info" && <Status value={n.severity === "critical" ? "error" : "pending"} />}
                        <strong>{n.title}</strong>
                      </div>
                      <div className="muted small pre">{n.body}</div>
                    </td>
                    <td className="right muted small nowrap">{when(n.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No alerts yet.</Empty>
          )}
        </Card>
        <Card title="Background work">
          <dl className="kv">
            <dt>Queued</dt>
            <dd className="num">{data.jobs.queued ?? 0}</dd>
            <dt>Running</dt>
            <dd className="num">{data.jobs.running ?? 0}</dd>
            <dt>Completed</dt>
            <dd className="num">{data.jobs.succeeded ?? 0}</dd>
            <dt>Gave up</dt>
            <dd className="num">{data.jobs.dead ?? 0}</dd>
          </dl>
          <p className="muted small" style={{ marginTop: 10 }}>
            Order checks, reconciliation, markdowns and reports run on a schedule. Jobs that fail retry with increasing delays before giving up.
          </p>
        </Card>
      </div>
    </div>
  );
}
