import { useEffect, useState } from "react";
import { api, Card, Check, Field, Loading, MoneyInput, NumberInput, Status, useAction, useLoad, useMe, words } from "../ui";

type S = Record<string, any>;
interface Conn {
  marketplace: string;
  name: string;
  officialApi: boolean;
  apiAdapterImplemented: boolean;
  mode: string;
  environment: string;
  status: string;
  hasCredentials: boolean;
  lastValidatedAt: string | null;
  lastError: string | null;
  notes: string;
}

const TABS = ["Automation", "Pricing", "Marketplaces", "Safety", "AI and research", "Alerts and schedules", "Users"] as const;
type Tab = (typeof TABS)[number];

function setPath(obj: S, path: string, value: unknown): S {
  const keys = path.split(".");
  const out: S = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] };
      cur = cur[k];
    }
  });
  return out;
}

export function Settings({ onChange }: { onChange: () => Promise<void> }) {
  const me = useMe();
  const owner = me.role === "owner";
  const { data, error, reload } = useLoad<{ settings: S }>("/api/settings");
  const [draft, setDraft] = useState<S | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("Automation");
  const [busy, run] = useAction();
  useEffect(() => {
    if (data && !dirty) setDraft(data.settings);
  }, [data, dirty]);
  if (!draft) return <Loading error={error} />;
  const set = (path: string) => (value: unknown) => {
    setDraft((d) => setPath(d!, path, value));
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      await api("/api/settings", { method: "PUT", body: draft });
      setDirty(false);
      await reload();
      await onChange();
      return "Settings saved";
    });
  const props = { s: draft, set, owner };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>{owner ? "The rules the agent must follow. Changes are recorded in the audit log." : "Only an owner can change settings."}</p>
        </div>
        {owner && tab !== "Users" && (
          <div className="row">
            {dirty && <span className="chip warn">Unsaved changes</span>}
            <button className="primary" disabled={busy || !dirty} onClick={save}>
              Save changes
            </button>
          </div>
        )}
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Automation" && <Automation {...props} onChange={async () => { await reload(); await onChange(); }} />}
      {tab === "Pricing" && <Pricing {...props} />}
      {tab === "Marketplaces" && <Marketplaces {...props} />}
      {tab === "Safety" && <Safety {...props} />}
      {tab === "AI and research" && <Ai {...props} />}
      {tab === "Alerts and schedules" && <Alerts {...props} />}
      {tab === "Users" && <Users owner={owner} />}
    </div>
  );
}

interface P {
  s: S;
  set: (path: string) => (value: any) => void;
  owner: boolean;
}

const MODES: [string, string, string][] = [
  ["review_only", "Review only", "The agent identifies, researches, prices and drafts. Nothing goes live until you approve it."],
  ["semi_autonomous", "Semi-autonomous", "Listings that pass every check publish on their own. Anything unusual or risky waits in the review queue."],
  ["full_autonomous", "Full autonomous", "As above, plus automatic markdowns and listing edits inside the limits you set. Financial and account actions still always need you."],
];

function Automation({ s, set, owner, onChange }: P & { onChange: () => Promise<void> }) {
  const [busy, run] = useAction();
  const [ack, setAck] = useState(false);
  const a = s.automation;
  const change = (mode: string) =>
    run(async () => {
      await api("/api/automation/mode", { body: { mode, acknowledge: ack } });
      setAck(false);
      await onChange();
      return `Mode changed to ${words(mode)}`;
    });
  return (
    <div className="stack">
      <Card title="Operating mode">
        <div className="stack">
          {MODES.map(([mode, label, text]) => (
            <div key={mode} className="listing" style={a.mode === mode ? { borderColor: "var(--accent)" } : undefined}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{label}</strong> {a.mode === mode && <span className="chip ok">Current</span>}
                  <div className="muted small" style={{ marginTop: 2 }}>{text}</div>
                </div>
                {owner && a.mode !== mode && (
                  <button className="sm" disabled={busy || (mode === "full_autonomous" && !ack)} onClick={() => change(mode)}>
                    Switch to this
                  </button>
                )}
              </div>
              {mode === "full_autonomous" && a.mode !== mode && owner && (
                <div style={{ marginTop: 8 }}>
                  <Check label="I have reviewed my price floors, discount limits, thresholds and each marketplace's permissions." hint="Required before full autonomous mode can be switched on." checked={ack} onChange={setAck} />
                </div>
              )}
            </div>
          ))}
          <p className="muted small">
            In every mode the agent can never: issue refunds or credits, buy shipping labels or anything else, accept or counter offers, delete listings, or change passwords, payout details or account security. Those are not switches — they are built into the authorisation engine.
          </p>
        </div>
      </Card>
      <Card title="Approvals and the emergency stop">
        <div className="form-grid">
          <Field label="Approvals expire after (hours)" hint="An approval that is not used in time has to be asked for again.">
            <NumberInput value={a.approvalTtlHours} onChange={set("automation.approvalTtlHours")} min={1} max={720} step={1} />
          </Field>
          <div className="wide">
            <Check
              label="During an emergency stop, still end other listings when an item sells"
              hint="Recommended. Turning this off means a sold item can stay listed elsewhere and sell twice."
              checked={a.protectiveDelistingDuringStop}
              onChange={set("automation.protectiveDelistingDuringStop")}
              disabled={!owner}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Pricing({ s, set, owner }: P) {
  const p = s.pricing;
  const schedule: { afterDays: number; pct: number }[] = p.markdownSchedule;
  return (
    <div className="stack">
      <Card title="Profit protection">
        <div className="form-grid">
          <Field label="Minimum profit per item" hint="No listing is priced below the point where this is met.">
            <MoneyInput cents={p.minProfitCents} onChange={(c) => set("pricing.minProfitCents")(c ?? 0)} />
          </Field>
          <Field label="Minimum margin (%)" hint="Net profit ÷ sale price.">
            <NumberInput value={p.minMarginPct} onChange={set("pricing.minMarginPct")} min={0} max={95} />
          </Field>
          <Field label="Largest total discount (%)" hint="From the original listing price.">
            <NumberInput value={p.maxDiscountPct} onChange={set("pricing.maxDiscountPct")} min={0} max={90} />
          </Field>
          <Field label="Hours between automatic price changes">
            <NumberInput value={p.minRepriceIntervalHours} onChange={set("pricing.minRepriceIntervalHours")} min={1} step={1} />
          </Field>
        </div>
      </Card>
      <Card title="How prices are chosen">
        <div className="form-grid">
          <Field label="Default strategy">
            <select value={p.strategy} onChange={(e) => set("pricing.strategy")(e.target.value)} disabled={!owner}>
              <option value="premium">Premium — top quarter of comparable sales</option>
              <option value="competitive">Competitive — the typical sale price</option>
              <option value="fast_sale">Fast sale — bottom quarter</option>
            </select>
          </Field>
          <Field label="Round prices to">
            <select value={p.rounding} onChange={(e) => set("pricing.rounding")(e.target.value)} disabled={!owner}>
              <option value="whole">Whole dollars ($24)</option>
              <option value="x99">.99 endings ($23.99)</option>
              <option value="none">No rounding</option>
            </select>
          </Field>
          <Field label="Comparable half-life (days)" hint="A sale this old counts half as much as one from today.">
            <NumberInput value={p.compHalfLifeDays} onChange={set("pricing.compHalfLifeDays")} min={1} />
          </Field>
          <Field label="Asking-price discount (%)" hint="Asking prices are not sales; they are discounted this much before use.">
            <NumberInput value={p.askingPriceHaircutPct} onChange={set("pricing.askingPriceHaircutPct")} min={0} max={60} />
          </Field>
          <Field label="Fallback markup on cost (%)" hint="Only used when there is no market data at all.">
            <NumberInput value={p.fallbackMarkupPct} onChange={set("pricing.fallbackMarkupPct")} min={0} max={2000} />
          </Field>
        </div>
      </Card>
      <Card
        title="Markdown schedule"
        actions={
          owner && (
            <button className="sm" onClick={() => set("pricing.markdownSchedule")([...schedule, { afterDays: (schedule[schedule.length - 1]?.afterDays ?? 0) + 30, pct: Math.min(90, (schedule[schedule.length - 1]?.pct ?? 0) + 5) }])}>
              Add step
            </button>
          )
        }
      >
        <div className="stack">
          <p className="muted small">Total discount from the original price once a listing reaches each age. Applied automatically only in full autonomous mode, and never below the floor or past the discount limit.</p>
          {schedule.map((step, i) => (
            <div key={i} className="row">
              <span>After</span>
              <span style={{ width: 80 }}>
                <NumberInput value={step.afterDays} min={1} step={1} onChange={(n) => set("pricing.markdownSchedule")(schedule.map((x, j) => (j === i ? { ...x, afterDays: n } : x)))} />
              </span>
              <span>days, total discount</span>
              <span style={{ width: 80 }}>
                <NumberInput value={step.pct} min={0} max={90} onChange={(n) => set("pricing.markdownSchedule")(schedule.map((x, j) => (j === i ? { ...x, pct: n } : x)))} />
              </span>
              <span>%</span>
              {owner && (
                <button className="ghost sm" onClick={() => set("pricing.markdownSchedule")(schedule.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Marketplaces({ s, set, owner }: P) {
  const conns = useLoad<{ connections: Conn[]; publicBaseUrl: boolean; ebayKeysConfigured: boolean }>("/api/connections");
  const [busy, run] = useAction();
  const [open, setOpen] = useState<string | null>("ebay");
  const [depopKey, setDepopKey] = useState("");
  if (!conns.data) return <Loading error={conns.error} />;
  const setMode = (m: string, mode: string) =>
    run(async () => {
      await api(`/api/connections/${m}`, { method: "PUT", body: { mode } });
      await conns.reload();
      return `${m} set to ${mode} mode`;
    });

  return (
    <div className="stack">
      {!conns.data.publicBaseUrl && (
        <div className="banner info">
          <span>
            API publishing to eBay and Depop needs your photos to be reachable from the internet. Set <code>PUBLIC_BASE_URL</code> in <code>.env</code> when you deploy.
          </span>
        </div>
      )}
      {conns.data.connections.map((c) => {
        const m = s.marketplaces[c.marketplace];
        const base = `marketplaces.${c.marketplace}`;
        const isOpen = open === c.marketplace;
        return (
          <Card
            key={c.marketplace}
            title={
              <span className="row">
                {c.name}
                <Status value={c.mode === "api" ? c.status : c.mode} />
                {!m.enabled && <span className="chip">Not used</span>}
              </span>
            }
            actions={
              <button className="sm" onClick={() => setOpen(isOpen ? null : c.marketplace)}>
                {isOpen ? "Hide" : "Configure"}
              </button>
            }
          >
            <p className="muted small">{c.notes}</p>
            {c.lastError && <div className="banner warn" style={{ marginTop: 8 }}>{c.lastError}</div>}
            {isOpen && (
              <div className="stack" style={{ marginTop: 12 }}>
                <Check label={`List items on ${c.name}`} checked={m.enabled} onChange={set(`${base}.enabled`)} disabled={!owner} />

                <div className="divider" />
                <h3>How it connects</h3>
                <div className="row">
                  <select value={c.mode} disabled={!owner || busy} onChange={(e) => setMode(c.marketplace, e.target.value)} style={{ width: 320 }}>
                    <option value="assisted">Assisted — prepared here, posted by you</option>
                    {c.apiAdapterImplemented && <option value="api">Official API — published automatically</option>}
                    <option value="simulated">Simulated — demo only, nothing real is posted</option>
                    <option value="disabled">Disabled</option>
                  </select>
                  {c.mode === "api" && owner && (
                    <button className="sm" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/connections/${c.marketplace}/validate`, { body: {} }); await conns.reload(); if (!r.result.ok) throw new Error(r.result.message); return r.result.message; })}>
                      Validate connection
                    </button>
                  )}
                </div>
                {c.mode === "api" && c.marketplace === "ebay" && owner && (
                  <div className="row">
                    <button className="sm" disabled={busy || !conns.data!.ebayKeysConfigured} onClick={() => run(async () => { const r = await api("/api/connections/ebay/authorize"); window.location.href = r.url; })}>
                      {c.hasCredentials ? "Reconnect eBay account" : "Connect eBay account"}
                    </button>
                    <span className="muted small">
                      {conns.data!.ebayKeysConfigured ? `Opens eBay's sign-in (${c.environment}). You approve access there; no password is entered here.` : "Add EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RU_NAME to .env first."}
                    </span>
                  </div>
                )}
                {c.mode === "api" && c.marketplace === "depop" && owner && (
                  <div className="row">
                    <input type="password" autoComplete="off" placeholder={c.hasCredentials ? "A key is saved — paste a new one to replace it" : "Depop API key (pak_…)"} value={depopKey} onChange={(e) => setDepopKey(e.target.value)} style={{ flex: 1, minWidth: 240 }} />
                    <button className="sm" disabled={busy || !depopKey} onClick={() => run(async () => { await api("/api/connections/depop", { method: "PUT", body: { apiKey: depopKey } }); setDepopKey(""); await conns.reload(); return "Key saved (encrypted)"; })}>
                      Save key
                    </button>
                  </div>
                )}
                {c.mode === "api" && (
                  <div className="banner warn">
                    <span>This API integration was written from the marketplace's published documentation and has not been proven against a live account from this installation. Validate the connection and publish one test listing before relying on it.</span>
                  </div>
                )}

                <div className="divider" />
                <h3>What the agent may do here on its own</h3>
                <div className="grid3">
                  <Check label="Publish eligible listings" checked={m.permissions.publish} onChange={set(`${base}.permissions.publish`)} disabled={!owner} />
                  <Check label="Change prices within limits" hint="Full autonomous mode only." checked={m.permissions.reprice} onChange={set(`${base}.permissions.reprice`)} disabled={!owner} />
                  <Check label="Edit titles and descriptions" hint="Full autonomous mode only." checked={m.permissions.updateContent} onChange={set(`${base}.permissions.updateContent`)} disabled={!owner} />
                  <Check label="End listings after a sale elsewhere" hint="Keep on to avoid double sales." checked={m.permissions.end} onChange={set(`${base}.permissions.end`)} disabled={!owner} />
                  <Check label="Update quantities" checked={m.permissions.updateInventory} onChange={set(`${base}.permissions.updateInventory`)} disabled={!owner} />
                </div>

                <div className="divider" />
                <h3>Pricing and shipping</h3>
                <div className="form-grid">
                  <Field label="Strategy">
                    <select value={m.strategy} onChange={(e) => set(`${base}.strategy`)(e.target.value)} disabled={!owner}>
                      <option value="inherit">Same as default</option>
                      <option value="premium">Premium</option>
                      <option value="competitive">Competitive</option>
                      <option value="fast_sale">Fast sale</option>
                    </select>
                  </Field>
                  <Field label="Price adjustment (%)" hint="e.g. 5 to price 5% higher here.">
                    <NumberInput value={m.priceAdjustPct} onChange={set(`${base}.priceAdjustPct`)} min={-50} max={100} />
                  </Field>
                  <Field label="Who pays shipping">
                    <select value={m.shipping.payer} onChange={(e) => set(`${base}.shipping.payer`)(e.target.value)} disabled={!owner}>
                      <option value="buyer">Buyer</option>
                      <option value="seller">You (free shipping)</option>
                    </select>
                  </Field>
                  <Field label="Your shipping cost per order">
                    <MoneyInput cents={m.shipping.sellerCostCents} onChange={(c) => set(`${base}.shipping.sellerCostCents`)(c ?? 0)} />
                  </Field>
                  <Field label="Shipping charged to buyer">
                    <MoneyInput cents={m.shipping.buyerChargeCents} onChange={(c) => set(`${base}.shipping.buyerChargeCents`)(c ?? 0)} />
                  </Field>
                  <Field label="Promoted listing rate (%)">
                    <NumberInput value={m.adRatePct} onChange={set(`${base}.adRatePct`)} min={0} max={100} />
                  </Field>
                </div>

                <div className="divider" />
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h3>Fees</h3>
                  <Check label="I have checked these against the marketplace's fee page" checked={m.fees.verified} onChange={set(`${base}.fees.verified`)} disabled={!owner} />
                </div>
                <p className="muted small">{m.fees.note}</p>
                <div className="form-grid">
                  <Field label="Selling fee (%)">
                    <NumberInput value={m.fees.sellingPct} onChange={set(`${base}.fees.sellingPct`)} min={0} max={100} />
                  </Field>
                  <Field label="Selling fee, fixed per order">
                    <MoneyInput cents={m.fees.sellingFixedCents} onChange={(c) => set(`${base}.fees.sellingFixedCents`)(c ?? 0)} />
                  </Field>
                  <Field label="Payment processing (%)">
                    <NumberInput value={m.fees.paymentPct} onChange={set(`${base}.fees.paymentPct`)} min={0} max={100} />
                  </Field>
                  <Field label="Payment processing, fixed">
                    <MoneyInput cents={m.fees.paymentFixedCents} onChange={(c) => set(`${base}.fees.paymentFixedCents`)(c ?? 0)} />
                  </Field>
                  <Field label="Listing fee">
                    <MoneyInput cents={m.fees.listingFeeCents} onChange={(c) => set(`${base}.fees.listingFeeCents`)(c ?? 0)} />
                  </Field>
                  <div style={{ alignSelf: "end" }}>
                    <Check label="Percentage fees also apply to shipping" checked={m.fees.appliesToShipping} onChange={set(`${base}.fees.appliesToShipping`)} disabled={!owner} />
                  </div>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function ListEditor({ label, hint, value, onChange }: { label: string; hint: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value]);
  return (
    <Field label={label} hint={hint} wide>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange([...new Set(text.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))])} />
    </Field>
  );
}

function Safety({ s, set }: P) {
  const t = s.thresholds;
  return (
    <div className="stack">
      <Card title="When a listing may publish without you">
        <div className="form-grid">
          <Field label="Minimum listing quality (0–100)">
            <NumberInput value={t.minListingQuality} onChange={set("thresholds.minListingQuality")} min={0} max={100} step={1} />
          </Field>
          <Field label="Minimum identification confidence (%)">
            <NumberInput value={Math.round(t.minIdentificationConfidence * 100)} onChange={(n) => set("thresholds.minIdentificationConfidence")(n / 100)} min={0} max={100} step={1} />
          </Field>
          <Field label="Minimum pricing confidence (%)">
            <NumberInput value={Math.round(t.minPricingConfidence * 100)} onChange={(n) => set("thresholds.minPricingConfidence")(n / 100)} min={0} max={100} step={1} />
          </Field>
          <Field label="Highest price published automatically" hint="Anything above this always waits for you.">
            <MoneyInput cents={t.maxAutoPublishPriceCents} onChange={(c) => set("thresholds.maxAutoPublishPriceCents")(c ?? 0)} />
          </Field>
          <Field label="Largest automatic price change (%)">
            <NumberInput value={t.maxAutoPriceChangePct} onChange={set("thresholds.maxAutoPriceChangePct")} min={0} max={100} />
          </Field>
          <Field label="Sold comparables needed">
            <NumberInput value={t.minSoldComps} onChange={set("thresholds.minSoldComps")} min={0} max={50} step={1} />
          </Field>
          <div className="wide">
            <Check label="Require real completed-sale comparables before publishing automatically" hint="Without this, a price built only on asking prices or a cost markup could go live on its own." checked={t.requireSoldComps} onChange={set("thresholds.requireSoldComps")} />
          </div>
        </div>
      </Card>
      <Card title="Items that always need a person">
        <div className="form-grid">
          <Field label="Authenticity check above this price">
            <MoneyInput cents={s.risk.authenticityReviewAboveCents} onChange={(c) => set("risk.authenticityReviewAboveCents")(c ?? 0)} />
          </Field>
          <ListEditor label="Brands that always need an authenticity check" hint="Comma-separated. Items from these brands are never published without an owner's approval." value={s.risk.highRiskBrands} onChange={set("risk.highRiskBrands")} />
          <ListEditor label="Restricted words" hint="Comma-separated. A listing containing any of these cannot be published." value={s.risk.restrictedKeywords} onChange={set("risk.restrictedKeywords")} />
        </div>
      </Card>
      <Card title="Photos">
        <div className="form-grid">
          <Field label="Longest side of listing photos (px)">
            <NumberInput value={s.images.maxDimension} onChange={set("images.maxDimension")} min={400} max={4000} step={1} />
          </Field>
          <Field label="JPEG quality">
            <NumberInput value={s.images.jpegQuality} onChange={set("images.jpegQuality")} min={40} max={100} step={1} />
          </Field>
          <Field label="Smallest acceptable side (px)">
            <NumberInput value={s.images.minDimension} onChange={set("images.minDimension")} min={100} max={2000} step={1} />
          </Field>
          <Field label="Blur warning below sharpness">
            <NumberInput value={s.images.blurThreshold} onChange={set("images.blurThreshold")} min={0} />
          </Field>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>Photos are resized and compressed only. They are never retouched, and originals are kept.</p>
      </Card>
    </div>
  );
}

function Ai({ s, set, owner }: P) {
  const conns = useLoad<{ anthropicKeyConfigured: boolean; ebayKeysConfigured: boolean }>("/api/connections");
  const r = s.research;
  return (
    <div className="stack">
      <Card title="AI provider">
        <div className="form-grid">
          <Field label="Provider">
            <select value={s.ai.provider} onChange={(e) => set("ai.provider")(e.target.value)} disabled={!owner}>
              <option value="anthropic">Claude (Anthropic)</option>
              <option value="simulated">Simulated — demo output only</option>
              <option value="none">None — identify items by hand</option>
            </select>
          </Field>
          <Field label="Vision model">
            <input value={s.ai.visionModel} onChange={(e) => set("ai.visionModel")(e.target.value)} disabled={!owner} />
          </Field>
          <Field label="Writing model">
            <input value={s.ai.writerModel} onChange={(e) => set("ai.writerModel")(e.target.value)} disabled={!owner} />
          </Field>
          <Field label="Effort">
            <select value={s.ai.effort} onChange={(e) => set("ai.effort")(e.target.value)} disabled={!owner}>
              <option value="low">Low — fastest, cheapest</option>
              <option value="medium">Medium</option>
              <option value="high">High — most careful</option>
            </select>
          </Field>
          <div className="wide">
            <Check label="Let the AI polish listing text" hint="Its text is checked against the item's confirmed facts; if it adds any claim, the plain template is used instead." checked={s.ai.useAiWriter} onChange={set("ai.useAiWriter")} disabled={!owner} />
          </div>
        </div>
        {conns.data && !conns.data.anthropicKeyConfigured && s.ai.provider === "anthropic" && (
          <div className="banner warn" style={{ marginTop: 10 }}>
            <span>
              <code>ANTHROPIC_API_KEY</code> is not set, so photos cannot be identified automatically. Items will wait for you to enter their details.
            </span>
          </div>
        )}
      </Card>
      <Card title="Where comparables come from">
        <div className="stack">
          <Check label="My own past sales" hint="Verified sales of the same brand and item type. The most reliable evidence." checked={r.internalSales} onChange={set("research.internalSales")} disabled={!owner} />
          <Check label="eBay active listings (Browse API)" hint={`Asking prices only — treated as weak evidence. ${conns.data?.ebayKeysConfigured ? "" : "Needs eBay API keys in .env."}`} checked={r.ebayBrowse} onChange={set("research.ebayBrowse")} disabled={!owner} />
          <Check label="eBay sold items (Marketplace Insights API)" hint="Real sold prices, but eBay only grants this API to approved partners. If you do not have access the lookup fails and says so." checked={r.ebayInsights} onChange={set("research.ebayInsights")} disabled={!owner} />
          <Check label="Depop similar sold items" hint="Needs Depop API access." checked={r.depopPricing} onChange={set("research.depopPricing")} disabled={!owner} />
          <Check label="Simulated comparables" hint="Made-up numbers for demos. Prices built on them are never published automatically to a real marketplace." checked={r.simulated} onChange={set("research.simulated")} disabled={!owner} />
          <p className="muted small">You can always add comparables by hand on an item's page. With no source of sold prices, the system says so rather than guessing.</p>
        </div>
      </Card>
    </div>
  );
}

const ALERT_TYPES: [string, string][] = [
  ["listing_published", "Listing published"],
  ["listing_failed", "Listing failed"],
  ["item_sold", "Item sold"],
  ["cross_delist_ok", "Other listings ended after a sale"],
  ["cross_delist_failed", "Could not end a sold item's listing"],
  ["possible_oversale", "Possible double sale"],
  ["inventory_discrepancy", "Inventory discrepancy"],
  ["pricing_exception", "Pricing exception"],
  ["review_needed", "Item waiting for review"],
  ["authenticity_concern", "Authenticity concern"],
  ["operator_task", "Something to post or end by hand"],
  ["marketplace_disconnected", "Marketplace disconnected"],
  ["rate_limited", "Marketplace rate limit"],
  ["suspicious_activity", "Suspicious activity"],
  ["agent_failure", "Agent or job failure"],
  ["profitability_change", "Significant profitability change"],
];

function Alerts({ s, set, owner }: P) {
  const n = s.notifications;
  const muted: string[] = n.muted;
  return (
    <div className="stack">
      <Card title="Where alerts go">
        <div className="form-grid">
          <div className="wide">
            <Check label="Send alerts by email" hint="Needs SMTP settings in .env." checked={n.emailEnabled} onChange={set("notifications.emailEnabled")} disabled={!owner} />
          </div>
          <Field label="Email address">
            <input type="email" value={n.emailTo} onChange={(e) => set("notifications.emailTo")(e.target.value)} disabled={!owner} />
          </Field>
          <div className="wide">
            <Check label="Send alerts to a webhook" hint="A JSON POST, signed with your webhook secret. Works with Slack-compatible relays and automation tools." checked={n.webhookEnabled} onChange={set("notifications.webhookEnabled")} disabled={!owner} />
          </div>
          <Field label="Webhook address" wide>
            <input value={n.webhookUrl} onChange={(e) => set("notifications.webhookUrl")(e.target.value)} placeholder="https://" disabled={!owner} />
          </Field>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>Alerts never contain passwords, tokens, API keys or buyer details.</p>
      </Card>
      <Card title="Which alerts are sent">
        <div className="grid3">
          {ALERT_TYPES.map(([type, label]) => (
            <Check key={type} label={label} checked={!muted.includes(type)} onChange={(on) => set("notifications.muted")(on ? muted.filter((m) => m !== type) : [...muted, type])} disabled={!owner} />
          ))}
        </div>
      </Card>
      <Card title="Schedules">
        <div className="form-grid">
          <Field label="Check for new orders every (minutes)">
            <NumberInput value={s.schedules.ordersPollMinutes} onChange={set("schedules.ordersPollMinutes")} min={1} step={1} />
          </Field>
          <Field label="Compare with marketplaces every (minutes)">
            <NumberInput value={s.schedules.reconcileMinutes} onChange={set("schedules.reconcileMinutes")} min={5} step={1} />
          </Field>
          <Field label="Review listing performance every (hours)">
            <NumberInput value={s.schedules.optimizeHours} onChange={set("schedules.optimizeHours")} min={1} step={1} />
          </Field>
          <Field label="Business report every (days)">
            <NumberInput value={s.schedules.reportDays} onChange={set("schedules.reportDays")} min={1} step={1} />
          </Field>
          <Field label="A listing is stale after (days)">
            <NumberInput value={s.optimization.staleAfterDays} onChange={set("optimization.staleAfterDays")} min={1} step={1} />
          </Field>
          <Field label="…with fewer views than">
            <NumberInput value={s.optimization.minViews} onChange={set("optimization.minViews")} min={0} step={1} />
          </Field>
        </div>
      </Card>
      <Card title="Location">
        <div className="form-grid">
          <Field label="Country code">
            <input value={s.location.countryCode} maxLength={2} onChange={(e) => set("location.countryCode")(e.target.value.toUpperCase())} disabled={!owner} />
          </Field>
          <Field label="State / region">
            <input value={s.location.state} onChange={(e) => set("location.state")(e.target.value)} disabled={!owner} />
          </Field>
          <Field label="Currency">
            <input value={s.location.currency} maxLength={3} onChange={(e) => set("location.currency")(e.target.value.toUpperCase())} disabled={!owner} />
          </Field>
        </div>
      </Card>
    </div>
  );
}

function Users({ owner }: { owner: boolean }) {
  const { data, error, reload } = useLoad<{ users: { id: string; email: string; role: string; disabled: number; created_at: string }[] }>(owner ? "/api/users" : null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("manager");
  const [busy, run] = useAction();
  if (!owner) return <Card>Only an owner can manage users.</Card>;
  if (!data) return <Loading error={error} />;
  return (
    <div className="stack">
      <Card title="People with access" tight>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{words(u.role)}</td>
                <td>{u.disabled ? <span className="chip">Disabled</span> : <span className="chip ok">Active</span>}</td>
                <td className="right">
                  <button className="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/users/${u.id}/disabled`, { body: { disabled: !u.disabled } }); await reload(); })}>
                    {u.disabled ? "Enable" : "Disable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Add a person">
        <div className="form-grid">
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Temporary password" hint="At least 12 characters.">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="owner">Owner — everything, including settings and high-risk approvals</option>
              <option value="manager">Manager — day-to-day operations and normal approvals</option>
              <option value="viewer">Viewer — read only</option>
            </select>
          </Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={busy || !email || password.length < 12} onClick={() => run(async () => { await api("/api/users", { body: { email, password, role } }); setEmail(""); setPassword(""); await reload(); return "User added"; })}>
            Add user
          </button>
        </div>
      </Card>
    </div>
  );
}
