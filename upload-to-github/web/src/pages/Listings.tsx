import { useState } from "react";
import { Card, Empty, Loading, MARKETPLACE_NAMES, money, navigate, SimChip, Status, useLoad, when, words } from "../ui";

interface Row {
  id: string;
  product_id: string;
  sku: string;
  productTitle: string | null;
  marketplace: string;
  status: string;
  title: string;
  description: string;
  price_cents: number;
  min_price_cents: number;
  original_price_cents: number;
  quality_score: number | null;
  simulated: boolean;
  integration_mode: string;
  published_at: string | null;
  updated_at: string;
  metrics: { views: number | null; likes: number | null; watchers: number | null; offers: number | null } | null;
}

const STATUSES = ["needs_review", "ready_to_publish", "approved", "publishing", "awaiting_operator", "published", "publication_failed", "delisting_pending", "sold", "delisted"];

export function Listings() {
  const [status, setStatus] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (marketplace) params.set("marketplace", marketplace);
  const { data, error } = useLoad<{ listings: Row[] }>(`/api/listings?${params}`, 8000);
  const rows = data?.listings.filter((l) => status || l.status !== "archived") ?? [];
  const known = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Listings</h1>
          <p>Every listing on every marketplace. Open an item to edit, publish, reprice or end it.</p>
        </div>
      </div>
      <Card
        tight
        title={
          <div className="row">
            <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} style={{ width: 180 }}>
              <option value="">All marketplaces</option>
              {Object.entries(MARKETPLACE_NAMES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {words(s)}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {!data ? (
          <Loading error={error} />
        ) : rows.length === 0 ? (
          <Empty>No listings match.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Listing</th>
                  <th>Marketplace</th>
                  <th>Status</th>
                  <th className="right">Price</th>
                  <th className="right">Minimum</th>
                  <th className="right">Quality</th>
                  <th className="right" title="Only shown where the marketplace reports it or you entered it">Views</th>
                  <th className="right">Likes / watchers</th>
                  <th>Listed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="click" onClick={() => navigate(`#/product/${l.product_id}`)}>
                    <td>
                      <strong>{l.title || l.description.split("\n")[0]}</strong>
                      <div className="muted small mono">{l.sku}</div>
                    </td>
                    <td className="nowrap">
                      {MARKETPLACE_NAMES[l.marketplace]} {l.simulated && <SimChip />}
                    </td>
                    <td>
                      <Status value={l.status} />
                    </td>
                    <td className="right num">
                      {money(l.price_cents)}
                      {l.price_cents < l.original_price_cents && <div className="muted small">was {money(l.original_price_cents)}</div>}
                    </td>
                    <td className="right num">{money(l.min_price_cents)}</td>
                    <td className="right num">{l.quality_score ?? "—"}</td>
                    <td className="right num">{known(l.metrics?.views)}</td>
                    <td className="right num">{l.metrics ? `${known(l.metrics.likes)} / ${known(l.metrics.watchers)}` : "—"}</td>
                    <td className="muted small nowrap">{when(l.published_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
