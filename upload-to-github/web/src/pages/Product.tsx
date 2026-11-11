import { useEffect, useState } from "react";
import { api, canWrite, cap, Card, CONDITIONS, Empty, Field, Loading, MARKETPLACE_NAMES, money, MoneyInput, SimChip, Status, useAction, useLoad, useMe, when, words } from "../ui";

interface Attr {
  value: string;
  basis: "visible" | "inferred" | "operator" | "import";
  confidence: number;
}
interface ProductData {
  product: Record<string, any> & { attributes: Record<string, Attr>; identification: any; risk_flags: string[] };
  images: { id: string; width: number; height: number; blur_score: number; view_label: string | null; quality: { issues?: string[] } }[];
  suggestedPhotos: string[];
  criticalMissing: string[];
  listings: Listing[];
  comps: { id: string; source: string; marketplace: string | null; kind: string; title: string; price_cents: number; condition: string | null; sold_at: string | null; similarity: number; simulated: number; url: string | null }[];
  pricing: Pricing | null;
  stages: { stage: string; status: string; detail: any }[];
  orders: { id: string; marketplace: string; sale_price_cents: number; fees_cents: number; fees_verified: number; net_proceeds_cents: number; net_profit_cents: number | null; status: string; sold_at: string; simulated: number }[];
  audit: { id: number; at: string; actor_type: string; action: string; outcome: string; marketplace: string | null; detail: any }[];
}
interface Listing {
  id: string;
  marketplace: string;
  marketplaceName: string;
  status: string;
  title: string;
  description: string;
  category_name: string | null;
  price_cents: number;
  original_price_cents: number;
  min_price_cents: number;
  quality_score: number | null;
  quality: { components?: { name: string; points: number; max: number; note?: string }[] };
  validation: { ok?: boolean; errors?: string[]; warnings?: string[] };
  attributes: { aiRejected?: string[]; aiNote?: string | null; keywords?: string[] };
  writer: string;
  external_id: string | null;
  external_url: string | null;
  simulated: boolean;
  integration_mode: string;
  last_error: string | null;
  published_at: string | null;
}
interface Pricing {
  basis: string;
  premiumCents: number | null;
  competitiveCents: number | null;
  fastSaleCents: number | null;
  expectedSellingCents: number | null;
  confidence: number;
  timeToSale: string;
  soldCompsUsed: number;
  activeCompsUsed: number;
  simulatedData: boolean;
  disclosures: string[];
  perMarketplace: { marketplace: string; listPriceCents: number; minAcceptableCents: number; raisedToFloor: boolean; feesVerified: boolean; atListPrice: Profit; atExpectedPrice: Profit }[];
}
interface Profit {
  totalFeesCents: number;
  sellerShippingCents: number;
  netProceedsCents: number;
  netProfitCents: number;
  marginPct: number;
}

const STAGE_ORDER = ["ingestion", "image_analysis", "identification", "attribute_extraction", "validation", "market_research", "comparable_analysis", "pricing", "listing_generation", "marketplace_mapping", "quality_validation", "authorization", "publication", "publication_verification", "inventory_sync", "monitoring"];
const BASIS_LABEL: Record<string, [string, string]> = { visible: ["Seen in photo", "info"], inferred: ["AI guess", "warn"], operator: ["You confirmed", "ok"], import: ["From import", "ok"] };
const TTS: Record<string, string> = { fast: "Fast (under ~2 weeks)", moderate: "Moderate (~2–6 weeks)", slow: "Slow (~6–12 weeks)", very_slow: "Very slow (3+ months)", unknown: "Unknown" };
const BASIS: Record<string, string> = { sold_comps: "Completed sales", sold_and_asking: "Few sales + asking prices", asking_only: "Asking prices only", cost_markup: "Cost plus markup (no market data)", none: "No data" };

export function Product({ id }: { id: string }) {
  const me = useMe();
  const { data, error, reload } = useLoad<ProductData>(`/api/products/${id}`, 5000);
  const [busy, run] = useAction();
  if (!data) return <Loading error={error} />;
  const p = data.product;
  const write = canWrite(me);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="muted small">
            <a href="#/inventory">Inventory</a> / <span className="mono">{p.sku}</span>
          </div>
          <h1>{p.title || [p.brand, p.category].filter(Boolean).join(" ") || "Unidentified item"}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <Status value={p.status} />
            <span className="muted small">
              {p.quantity_available} available · {p.quantity_sold} sold{p.storage_location ? ` · ${p.storage_location}` : ""}
            </span>
          </div>
        </div>
        {write && (
          <div className="row">
            <button disabled={busy} onClick={() => run(async () => { await api(`/api/products/${id}/process`, { body: {} }); await reload(); return "Processing started"; })}>
              Run processing again
            </button>
            {p.status !== "archived" && (
              <button disabled={busy} onClick={() => run(async () => { if (!window.confirm("Archive this item? Its drafts will be archived too.")) return; await api(`/api/products/${id}/archive`, { body: {} }); await reload(); return "Archived"; })}>
                Archive
              </button>
            )}
          </div>
        )}
      </div>

      {data.criticalMissing.length > 0 && (
        <div className="banner warn">
          <span>
            <strong>Missing:</strong> {data.criticalMissing.join(", ")}. Fill these in below, then run processing again.
          </span>
        </div>
      )}
      {p.risk_flags.length > 0 && (
        <div className="banner bad">
          <span>
            <strong>Held for your review:</strong> {p.risk_flags.map((f: string) => words(f)).join("; ")}. This item will not be published without an owner's approval.
          </span>
        </div>
      )}
      {p.identification?.simulated && (
        <div className="banner sim">
          <span>
            <strong>Simulated identification.</strong> The details below are fixed sample output, not an analysis of your photo. They can only be published to a simulated marketplace.
          </span>
        </div>
      )}

      <Card title="Workflow">
        <div className="stages">
          {STAGE_ORDER.map((name) => {
            const s = data.stages.find((x) => x.stage === name);
            return (
              <span key={name} className={`stage ${s?.status ?? ""}`} title={s ? `${s.status}${s.detail?.reason ? `: ${s.detail.reason}` : ""}` : "not started"}>
                {words(name)}
              </span>
            );
          })}
        </div>
      </Card>

      <div className="grid2">
        <Photos id={id} data={data} reload={reload} write={write} />
        <Details id={id} data={data} reload={reload} write={write} />
      </div>

      <PricingCard id={id} data={data} reload={reload} write={write} />

      <Card
        title="Listings"
        actions={
          write &&
          data.pricing && (
            <button className="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/products/${id}/listings/generate`, { body: {} }); await reload(); return "Drafts regenerated"; })}>
              Regenerate drafts
            </button>
          )
        }
      >
        {data.listings.filter((l) => l.status !== "archived").length === 0 ? (
          <Empty>No listings yet. They are drafted automatically once the item is identified and priced.</Empty>
        ) : (
          data.listings.filter((l) => l.status !== "archived").map((l) => <ListingCard key={l.id} l={l} reload={reload} write={write} />)
        )}
      </Card>

      {data.orders.length > 0 && (
        <Card title="Sales" tight>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Marketplace</th>
                <th className="right">Sold for</th>
                <th className="right">Fees</th>
                <th className="right">Net proceeds</th>
                <th className="right">Profit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.id}>
                  <td>{when(o.sold_at)}</td>
                  <td>
                    {MARKETPLACE_NAMES[o.marketplace]} {o.simulated === 1 && <SimChip />}
                  </td>
                  <td className="right num">{money(o.sale_price_cents)}</td>
                  <td className="right num">
                    {money(o.fees_cents)} {!o.fees_verified && <span className="muted small">est.</span>}
                  </td>
                  <td className="right num">{money(o.net_proceeds_cents)}</td>
                  <td className="right num">{money(o.net_profit_cents)}</td>
                  <td>
                    <Status value={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="History" tight>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
          <table>
            <tbody>
              {data.audit.map((a) => (
                <tr key={a.id}>
                  <td className="muted small nowrap">{new Date(a.at).toLocaleString()}</td>
                  <td className="small">{a.actor_type}</td>
                  <td>
                    {cap(words(a.action))}
                    {a.marketplace ? ` · ${MARKETPLACE_NAMES[a.marketplace] ?? a.marketplace}` : ""}
                    {a.detail?.reasons?.length ? <div className="muted small">{a.detail.reasons.map((r: string) => words(r)).join(", ")}</div> : null}
                  </td>
                  <td>{a.outcome !== "ok" && <Status value={a.outcome === "denied" ? "rejected" : a.outcome === "failed" ? "error" : "pending"} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Photos({ id, data, reload, write }: { id: string; data: ProductData; reload: () => Promise<void>; write: boolean }) {
  const [busy, run] = useAction();
  return (
    <Card title={`Photos (${data.images.length})`}>
      <div className="stack">
        {data.images.length === 0 ? (
          <p className="muted">No photos yet. Listings need at least one.</p>
        ) : (
          <div className="photos">
            {data.images.map((i) => (
              <div className="photo" key={i.id}>
                <a href={`/api/images/${i.id}?variant=original`} target="_blank" rel="noreferrer">
                  <img src={`/api/images/${i.id}`} alt={i.view_label ?? "Product photo"} loading="lazy" />
                </a>
                <div className="cap">
                  {i.view_label ? cap(words(i.view_label)) : `${i.width}×${i.height}`}
                  {(i.quality.issues ?? []).map((q) => (
                    <span key={q} className="chip warn" style={{ marginLeft: 4 }}>
                      {words(q)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {data.suggestedPhotos.length > 0 && data.images.length > 0 && (
          <p className="muted small">Suggested extra photos: {data.suggestedPhotos.map((s) => words(s)).join(", ")}.</p>
        )}
        {write && (
          <Field label="Add photos" hint="Originals are kept untouched; resized copies are used for listings.">
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={busy}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (!files.length) return;
                void run(async () => {
                  const form = new FormData();
                  for (const f of files) form.append("files", f);
                  const r = await api(`/api/products/${id}/images`, { form });
                  e.target.value = "";
                  await reload();
                  return `${r.added} photo(s) added`;
                });
              }}
            />
          </Field>
        )}
      </div>
    </Card>
  );
}

const FIELDS: [string, string][] = [
  ["brand", "Brand"],
  ["model", "Model / style name"],
  ["category", "Item type"],
  ["size", "Size"],
  ["color", "Color"],
  ["material", "Material"],
  ["style_number", "Style number"],
];

function Details({ id, data, reload, write }: { id: string; data: ProductData; reload: () => Promise<void>; write: boolean }) {
  const p = data.product;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<number | null>(p.acquisition_cost_cents);
  const [minPrice, setMinPrice] = useState<number | null>(p.min_price_cents);
  const [busy, run] = useAction();
  useEffect(() => {
    if (!editing) {
      setCost(p.acquisition_cost_cents);
      setMinPrice(p.min_price_cents);
    }
  }, [p.acquisition_cost_cents, p.min_price_cents, editing]);
  const start = () => {
    const init: Record<string, string> = {};
    for (const k of [...FIELDS.map(([k]) => k), "department", "condition", "condition_notes", "storage_location", "notes"]) init[k] = p[k] ?? "";
    setF(init);
    setEditing(true);
  };
  const badge = (key: string) => {
    const a = p.attributes[key];
    if (!a) return null;
    const [label, tone] = BASIS_LABEL[a.basis] ?? [a.basis, ""];
    return (
      <span className={`chip ${tone}`} title={`Confidence ${Math.round(a.confidence * 100)}%`}>
        {label}
        {a.basis === "visible" || a.basis === "inferred" ? ` · ${Math.round(a.confidence * 100)}%` : ""}
      </span>
    );
  };
  const unconfirmed = Object.values(p.attributes).some((a) => a.basis === "visible" || a.basis === "inferred");

  if (editing) {
    const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
    return (
      <Card title="Edit details">
        <div className="stack">
          <div className="form-grid">
            {FIELDS.map(([k, label]) => (
              <Field key={k} label={label}>
                <input value={f[k] ?? ""} onChange={set(k)} />
              </Field>
            ))}
            <Field label="Department">
              <select value={f.department ?? ""} onChange={set("department")}>
                <option value="">—</option>
                <option value="menswear">Men</option>
                <option value="womenswear">Women</option>
                <option value="kids">Kids</option>
                <option value="unisex">Unisex</option>
              </select>
            </Field>
            <Field label="Condition">
              <select value={f.condition ?? ""} onChange={set("condition")}>
                <option value="">—</option>
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {words(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What you paid">
              <MoneyInput cents={cost} onChange={setCost} allowEmpty />
            </Field>
            <Field label="Lowest price you'd accept" hint="Optional. The profit floor still applies.">
              <MoneyInput cents={minPrice} onChange={setMinPrice} allowEmpty />
            </Field>
            <Field label="Storage location">
              <input value={f.storage_location ?? ""} onChange={set("storage_location")} />
            </Field>
            <Field label="Flaws and condition notes" hint="Shown to buyers in every listing." wide>
              <textarea value={f.condition_notes ?? ""} onChange={set("condition_notes")} />
            </Field>
            <Field label="Private notes" wide>
              <textarea value={f.notes ?? ""} onChange={set("notes")} />
            </Field>
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const body: Record<string, unknown> = { acquisition_cost_cents: cost, min_price_cents: minPrice };
                  for (const [k, v] of Object.entries(f)) if ((p[k] ?? "") !== v) body[k] = v === "" ? null : v;
                  await api(`/api/products/${id}`, { method: "PATCH", body });
                  await api(`/api/products/${id}/process`, { body: {} });
                  setEditing(false);
                  await reload();
                  return "Saved. Re-pricing and re-drafting listings…";
                })
              }
            >
              Save and reprocess
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Details"
      actions={
        write && (
          <>
            {unconfirmed && (
              <button className="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/products/${id}/confirm`, { body: {} }); await api(`/api/products/${id}/process`, { body: {} }); await reload(); return "Details confirmed"; })} title="Mark every detail as checked by you">
                Confirm all correct
              </button>
            )}
            <button className="sm" onClick={start}>
              Edit
            </button>
          </>
        )
      }
    >
      <dl className="kv">
        {[...FIELDS, ["department", "Department"] as [string, string], ["condition", "Condition"] as [string, string]].map(([k, label]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>
              <span style={{ marginRight: 8 }}>{p[k] ? words(String(p[k])) : <span className="muted">—</span>}</span>
              {badge(k)}
            </dd>
          </div>
        ))}
        <dt>Flaws / notes</dt>
        <dd>{p.condition_notes || <span className="muted">None recorded</span>}</dd>
        <dt>What you paid</dt>
        <dd className="num">{p.acquisition_cost_cents === null ? <span className="chip warn">Not recorded</span> : money(p.acquisition_cost_cents)}</dd>
        <dt>Your minimum</dt>
        <dd className="num">{money(p.min_price_cents)}</dd>
        {p.identification_confidence !== null && (
          <>
            <dt>Identification</dt>
            <dd>{Math.round(p.identification_confidence * 100)}% confident</dd>
          </>
        )}
        {p.identification?.authenticityConcerns?.length > 0 && (
          <>
            <dt>Authenticity</dt>
            <dd style={{ color: "var(--danger)" }}>{p.identification.authenticityConcerns.join("; ")}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function PricingCard({ id, data, reload, write }: { id: string; data: ProductData; reload: () => Promise<void>; write: boolean }) {
  const pr = data.pricing;
  const [adding, setAdding] = useState(false);
  const [comp, setComp] = useState({ kind: "sold", title: "", marketplace: "", soldAt: "" });
  const [price, setPrice] = useState<number | null>(null);
  const [busy, run] = useAction();
  return (
    <Card title="Pricing and comparables" actions={pr && <span className="muted small">Calculated by fixed rules, not by AI</span>}>
      <div className="stack">
        {!pr ? (
          <p className="muted">No price yet. A price is calculated once the item is identified and comparables are gathered.</p>
        ) : (
          <>
            <div className="kpis">
              <div className="kpi">
                <div className="label">Expected selling price</div>
                <div className="value">{money(pr.expectedSellingCents)}</div>
                <div className="sub">{BASIS[pr.basis]}</div>
              </div>
              <div className="kpi">
                <div className="label">Premium · competitive · fast</div>
                <div className="value" style={{ fontSize: 16, marginTop: 6 }}>
                  {money(pr.premiumCents)} · {money(pr.competitiveCents)} · {money(pr.fastSaleCents)}
                </div>
              </div>
              <div className="kpi">
                <div className="label">Confidence</div>
                <div className="value">{Math.round(pr.confidence * 100)}%</div>
                <div className="sub">
                  {pr.soldCompsUsed} sold{pr.activeCompsUsed ? `, ${pr.activeCompsUsed} asking` : ""} comparables
                </div>
              </div>
              <div className="kpi">
                <div className="label">Time to sell (estimate)</div>
                <div className="value" style={{ fontSize: 16, marginTop: 6 }}>{TTS[pr.timeToSale]}</div>
              </div>
            </div>
            {pr.disclosures.length > 0 && (
              <div className={`banner ${pr.simulatedData ? "sim" : "warn"}`}>
                <ul className="plain">
                  {pr.disclosures.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Marketplace</th>
                    <th className="right">List price</th>
                    <th className="right">Minimum</th>
                    <th className="right">Fees</th>
                    <th className="right">Shipping you pay</th>
                    <th className="right">Net proceeds</th>
                    <th className="right">Net profit</th>
                    <th className="right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {pr.perMarketplace.map((m) => (
                    <tr key={m.marketplace}>
                      <td>
                        <strong>{MARKETPLACE_NAMES[m.marketplace]}</strong> {m.raisedToFloor && <span className="chip warn" title="The market price is below your floor">Raised to floor</span>}
                      </td>
                      <td className="right num">{money(m.listPriceCents)}</td>
                      <td className="right num">{money(m.minAcceptableCents)}</td>
                      <td className="right num">
                        {money(m.atListPrice.totalFeesCents)} {!m.feesVerified && <span className="muted small">est.</span>}
                      </td>
                      <td className="right num">{money(m.atListPrice.sellerShippingCents)}</td>
                      <td className="right num">{money(m.atListPrice.netProceedsCents)}</td>
                      <td className="right num">{money(m.atListPrice.netProfitCents)}</td>
                      <td className="right num">{m.atListPrice.marginPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="divider" />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Comparables ({data.comps.length})</h3>
          {write && (
            <button className="sm" onClick={() => setAdding((v) => !v)}>
              {adding ? "Cancel" : "Add a comparable"}
            </button>
          )}
        </div>
        {adding && (
          <div className="form-grid">
            <Field label="Type">
              <select value={comp.kind} onChange={(e) => setComp({ ...comp, kind: e.target.value })}>
                <option value="sold">Sold (completed sale)</option>
                <option value="active">Active (asking price)</option>
              </select>
            </Field>
            <Field label="Listing title" wide>
              <input value={comp.title} onChange={(e) => setComp({ ...comp, title: e.target.value })} />
            </Field>
            <Field label="Price">
              <MoneyInput cents={price} onChange={setPrice} allowEmpty />
            </Field>
            <Field label="Marketplace">
              <select value={comp.marketplace} onChange={(e) => setComp({ ...comp, marketplace: e.target.value })}>
                <option value="">—</option>
                {Object.entries(MARKETPLACE_NAMES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            {comp.kind === "sold" && (
              <Field label="Date sold">
                <input type="date" value={comp.soldAt} onChange={(e) => setComp({ ...comp, soldAt: e.target.value })} />
              </Field>
            )}
            <div className="row" style={{ alignItems: "flex-end" }}>
              <button
                className="primary"
                disabled={busy || !comp.title || !price}
                onClick={() =>
                  run(async () => {
                    await api(`/api/products/${id}/comps`, { body: { kind: comp.kind, title: comp.title, priceCents: price, marketplace: comp.marketplace || null, soldAt: comp.kind === "sold" && comp.soldAt ? new Date(comp.soldAt).toISOString() : null } });
                    setComp({ kind: "sold", title: "", marketplace: "", soldAt: "" });
                    setPrice(null);
                    setAdding(false);
                    await reload();
                    return "Comparable added and price recalculated";
                  })
                }
              >
                Add and recalculate
              </button>
            </div>
          </div>
        )}
        {data.comps.length === 0 ? (
          <p className="muted">
            No comparables found. Without a connected source of sold prices, add a few completed sales you have looked up yourself — the price is only as good as its evidence.
          </p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Source</th>
                  <th className="right">Price</th>
                  <th>When</th>
                  <th className="right">Match</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.comps.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className={`chip ${c.kind === "sold" ? "ok" : ""}`}>{c.kind === "sold" ? "Sold" : "Asking"}</span>
                    </td>
                    <td>
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer noopener">
                          {c.title}
                        </a>
                      ) : (
                        c.title
                      )}
                    </td>
                    <td className="small">
                      {words(c.source)}
                      {c.marketplace ? ` · ${MARKETPLACE_NAMES[c.marketplace] ?? c.marketplace}` : ""} {c.simulated === 1 && <SimChip />}
                    </td>
                    <td className="right num">{money(c.price_cents)}</td>
                    <td className="muted small nowrap">{c.sold_at ? when(c.sold_at) : "—"}</td>
                    <td className="right num">{Math.round(c.similarity * 100)}%</td>
                    <td className="right">
                      {write && c.source === "operator" && (
                        <button className="ghost sm" onClick={() => run(async () => { await api(`/api/comps/${c.id}`, { method: "DELETE" }); await api(`/api/products/${id}/reprice-recommendation`, { body: {} }); await reload(); })}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function resultMessage(r: { outcome: string; decision?: { reasons: { message: string }[] } }, done: string): string {
  const why = r.decision?.reasons.map((x) => x.message).join(" ") ?? "";
  if (r.outcome === "queued" || r.outcome === "executed" || r.outcome === "saved") return done;
  if (r.outcome === "needs_approval") return `Sent to the review queue for approval. ${why}`;
  if (r.outcome === "deferred") return `Held for now. ${why}`;
  throw new Error(`Not allowed. ${why}`);
}

function ListingCard({ l, reload, write }: { l: Listing; reload: () => Promise<void>; write: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(l.title);
  const [description, setDescription] = useState(l.description);
  const [price, setPrice] = useState<number | null>(l.price_cents);
  const [busy, run] = useAction();
  const draft = ["draft", "needs_review", "ready_to_publish", "approved", "publication_failed"].includes(l.status);
  const live = ["published", "awaiting_operator"].includes(l.status);
  const errors = l.validation.errors ?? [];
  const warnings = l.validation.warnings ?? [];
  const below = l.price_cents < l.min_price_cents;

  return (
    <div className="listing">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <strong>{l.marketplaceName}</strong>
          <Status value={l.status} />
          {l.simulated && <SimChip />}
          {l.integration_mode === "assisted" && <span className="chip" title="This marketplace has no listing API here: you post it, the app prepares and tracks it">You post this one</span>}
          <span className="muted small">{l.writer === "ai" ? "AI-written, fact-checked" : l.writer === "operator" ? "Edited by you" : "Template-written"}</span>
        </div>
        <div className="row">
          <span className="num">
            <strong>{money(l.price_cents)}</strong> <span className={`small ${below ? "" : "muted"}`} style={below ? { color: "var(--danger)" } : undefined}>min {money(l.min_price_cents)}</span>
          </span>
          {l.quality_score !== null && (
            <span className="row" style={{ gap: 6 }} title={(l.quality.components ?? []).map((c) => `${c.name}: ${c.points}/${c.max}`).join("\n")}>
              <span className={`meter ${l.quality_score < 75 ? "low" : ""}`}>
                <i style={{ width: `${l.quality_score}%` }} />
              </span>
              <span className="small num">{l.quality_score}/100</span>
            </span>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="banner bad" style={{ marginTop: 8 }}>
          <ul className="plain">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {l.last_error && (
        <div className="banner warn" style={{ marginTop: 8 }}>
          <span>{l.last_error}</span>
        </div>
      )}

      {editing ? (
        <div className="stack" style={{ marginTop: 10 }}>
          {l.marketplace !== "depop" && (
            <Field label={`Title (${title.length} characters)`}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          )}
          <Field label={`Description (${description.length} characters)`}>
            <textarea rows={9} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {draft && (
            <Field label="Price">
              <MoneyInput cents={price} onChange={setPrice} />
            </Field>
          )}
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const body: Record<string, unknown> = {};
                  if (title !== l.title) body.title = title;
                  if (description !== l.description) body.description = description;
                  if (draft && price !== null && price !== l.price_cents) body.priceCents = price;
                  const r = await api(`/api/listings/${l.id}`, { method: "PATCH", body });
                  setEditing(false);
                  await reload();
                  return resultMessage(r.result, "Listing saved");
                })
              }
            >
              Save
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 8 }}>
            {l.title && l.marketplace !== "depop" && <div style={{ fontWeight: 600 }}>{l.title}</div>}
            <div className="pre small" style={{ marginTop: 4, maxHeight: 150, overflowY: "auto" }}>{l.description}</div>
            <div className="muted small" style={{ marginTop: 6 }}>
              Category: {l.category_name ?? "—"}
              {warnings.length > 0 && ` · ${warnings.join(" ")}`}
              {(l.attributes.aiRejected ?? []).length > 0 && ` · AI text was rejected (${l.attributes.aiRejected!.join("; ")}); template text used instead.`}
            </div>
            {l.external_url && !l.external_url.startsWith("simulated:") && (
              <a className="small" href={l.external_url} target="_blank" rel="noreferrer noopener">
                View on {l.marketplaceName}
              </a>
            )}
          </div>
          {write && (
            <div className="row" style={{ marginTop: 10 }}>
              {draft && (
                <button className="primary sm" disabled={busy || errors.length > 0} onClick={() => run(async () => { const r = await api(`/api/listings/${l.id}/publish`, { body: {} }); await reload(); window.setTimeout(() => void reload(), 1500); return resultMessage(r.result, l.integration_mode === "assisted" ? "Prepared — see the review queue to post it" : "Publishing…"); })}>
                  {l.status === "publication_failed" ? "Try again" : "Publish"}
                </button>
              )}
              {(draft || l.status === "published") && (
                <button className="sm" onClick={() => { setTitle(l.title); setDescription(l.description); setPrice(l.price_cents); setEditing(true); }}>
                  Edit
                </button>
              )}
              {l.status === "published" && (
                <button
                  className="sm"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const input = window.prompt(`New price for ${l.marketplaceName} (minimum ${money(l.min_price_cents)}):`, (l.price_cents / 100).toFixed(2));
                      if (!input) return;
                      const cents = Math.round(parseFloat(input.replace(/[$,]/g, "")) * 100);
                      if (!Number.isFinite(cents) || cents <= 0) throw new Error("That is not a valid price.");
                      const r = await api(`/api/listings/${l.id}/reprice`, { body: { priceCents: cents } });
                      await reload();
                      return resultMessage(r.result, "Price changed");
                    })
                  }
                >
                  Change price
                </button>
              )}
              {live && (
                <button className="sm" disabled={busy} onClick={() => run(async () => { if (!window.confirm(`End this ${l.marketplaceName} listing?`)) return; const r = await api(`/api/listings/${l.id}/end`, { body: {} }); await reload(); return resultMessage(r.result, "Ending listing…"); })}>
                  End listing
                </button>
              )}
              {l.status === "published" && l.simulated && (
                <button className="sm" disabled={busy} onClick={() => run(async () => { await api("/api/simulate/sale", { body: { listingId: l.id } }); await reload(); return "Simulated sale recorded; other listings are being ended"; })}>
                  Simulate a sale
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
