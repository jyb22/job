import { useState } from "react";
import { api, canWrite, Card, CONDITIONS, Empty, Field, Img, Loading, MARKETPLACE_NAMES, money, MoneyInput, navigate, Status, useAction, useLoad, useMe, when, words } from "../ui";

interface Row {
  id: string;
  sku: string;
  status: string;
  title: string | null;
  brand: string | null;
  category: string | null;
  size: string | null;
  acquisition_cost_cents: number | null;
  quantity_available: number;
  quantity_sold: number;
  storage_location: string | null;
  created_at: string;
  imageId: string | null;
  risk_flags: string[];
  listings: { id: string; marketplace: string; status: string; price_cents: number; simulated: boolean }[];
  expectedSellingCents: number | null;
  estimatedProfitCents: number | null;
}

const STATUSES = ["new", "processing", "identification_required", "needs_review", "ready_to_publish", "approved", "publishing", "published", "publication_failed", "delisting_pending", "sold", "delisted", "archived"];

export function Inventory() {
  const me = useMe();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  const { data, error, reload } = useLoad<{ products: Row[] }>(`/api/products?${params}`, 6000);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p>Every item, its cost, its price and where it is listed.</p>
        </div>
        {canWrite(me) && (
          <button className="primary" onClick={() => setAdding((v) => !v)}>
            {adding ? "Close" : "Add items"}
          </button>
        )}
      </div>

      {adding && <AddItems onDone={reload} />}

      <Card
        tight
        title={
          <div className="row">
            <input placeholder="Search SKU, title, brand…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
              <option value="">All except archived</option>
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
        ) : data.products.length === 0 ? (
          <Empty>{q || status ? "Nothing matches that filter." : "No items yet. Add your first item by uploading a photo."}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Item</th>
                  <th>Status</th>
                  <th>Listed on</th>
                  <th className="right">Cost</th>
                  <th className="right">Expected sale</th>
                  <th className="right">Est. profit</th>
                  <th className="right">Qty</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id} className="click" onClick={() => navigate(`#/product/${p.id}`)}>
                    <td style={{ width: 60 }}>
                      <Img id={p.imageId} />
                    </td>
                    <td>
                      <strong>{p.title || [p.brand, p.category].filter(Boolean).join(" ") || "Unidentified item"}</strong>
                      <div className="muted small mono">
                        {p.sku}
                        {p.size ? ` · size ${p.size}` : ""}
                        {p.storage_location ? ` · ${p.storage_location}` : ""}
                      </div>
                      {p.risk_flags.length > 0 && <span className="chip warn">Flagged for review</span>}
                    </td>
                    <td>
                      <Status value={p.status} />
                    </td>
                    <td>
                      <div className="chips">
                        {p.listings
                          .filter((l) => !["delisted", "archived"].includes(l.status))
                          .map((l) => (
                            <span key={l.id} className={`chip ${l.status === "published" ? "ok" : l.status === "sold" ? "ok" : l.status === "publication_failed" ? "bad" : ""} `} title={`${words(l.status)}${l.simulated ? " (simulated)" : ""}`}>
                              {MARKETPLACE_NAMES[l.marketplace]}
                              {l.simulated ? " · sim" : ""}
                            </span>
                          ))}
                      </div>
                    </td>
                    <td className="right num">{money(p.acquisition_cost_cents)}</td>
                    <td className="right num">{money(p.expectedSellingCents)}</td>
                    <td className="right num">{money(p.estimatedProfitCents)}</td>
                    <td className="right num">{p.quantity_available}</td>
                    <td className="muted small nowrap">{when(p.created_at)}</td>
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

function AddItems({ onDone }: { onDone: () => Promise<void> }) {
  const [tab, setTab] = useState<"photos" | "file" | "manual">("photos");
  return (
    <Card title="Add items">
      <div className="tabs">
        {(
          [
            ["photos", "Upload photos"],
            ["file", "Import CSV / Excel"],
            ["manual", "Enter by hand"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "photos" && <PhotoUpload onDone={onDone} />}
      {tab === "file" && <FileImport onDone={onDone} />}
      {tab === "manual" && <ManualEntry onDone={onDone} />}
    </Card>
  );
}

function PhotoUpload({ onDone }: { onDone: () => Promise<void> }) {
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<"single" | "each">("single");
  const [cost, setCost] = useState<number | null>(null);
  const [location, setLocation] = useState("");
  const [result, setResult] = useState<{ created: { id: string; sku: string; photos: number; possibleDuplicateOf: string | null }[]; skipped: { filename: string; reason: string }[] } | null>(null);
  const [busy, run] = useAction();
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Photos" hint="JPEG, PNG or WebP. iPhone HEIC photos work when the server runs on a Mac. Choose several files at once." wide>
          <input type="file" accept="image/*" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </Field>
        <Field label="These photos show">
          <select value={mode} onChange={(e) => setMode(e.target.value as "single" | "each")}>
            <option value="single">One item (all photos)</option>
            <option value="each">A different item in each photo</option>
          </select>
        </Field>
        <Field label={mode === "each" ? "Cost of each item" : "What you paid for it"} hint="Needed to protect your profit floor.">
          <MoneyInput cents={cost} onChange={setCost} allowEmpty />
        </Field>
        <Field label="Storage location" hint="Optional: bin, shelf, box.">
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || files.length === 0}
          onClick={() =>
            run(async () => {
              const form = new FormData();
              form.set("mode", mode);
              if (cost !== null) form.set("cost_cents", String(cost));
              if (location) form.set("storage_location", location);
              for (const f of files) form.append("files", f);
              const r = await api("/api/products/upload", { form });
              setResult(r);
              setFiles([]);
              await onDone();
              return `${r.created.length} item(s) added and queued for processing`;
            })
          }
        >
          {busy ? "Uploading…" : `Upload ${files.length || ""} photo${files.length === 1 ? "" : "s"}`}
        </button>
        <span className="muted small">Each item is identified, researched, priced and drafted automatically. Nothing is published unless your automation rules allow it.</span>
      </div>
      {result && (
        <div className="stack">
          {result.created.map((c) => (
            <div key={c.id} className={`banner ${c.possibleDuplicateOf ? "warn" : "info"}`}>
              <span>
                Added <a href={`#/product/${c.id}`}>{c.sku}</a> with {c.photos} photo(s).
                {c.possibleDuplicateOf && <> It looks very similar to {c.possibleDuplicateOf} — check that it is not the same item.</>}
              </span>
            </div>
          ))}
          {result.skipped.map((s, i) => (
            <div key={i} className="banner warn">
              <span>
                Skipped {s.filename}: {s.reason}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileImport({ onDone }: { onDone: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ created: { id: string; sku: string; title: string | null }[]; skipped: { row: number; reason: string }[]; unmappedColumns: string[] } | null>(null);
  const [busy, run] = useAction();
  return (
    <div className="stack">
      <Field label="Spreadsheet" hint="First row must be headings. Recognised: Title, Brand, Model, Type, Department, Size, Color, Material, Condition, Flaws, Style number, UPC, Notes, Location, Cost, Min price, Quantity.">
        <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <div className="row">
        <button
          className="primary"
          disabled={busy || !file}
          onClick={() =>
            run(async () => {
              const form = new FormData();
              form.append("file", file!);
              const r = await api("/api/products/import", { form });
              setResult(r);
              await onDone();
              return `${r.created.length} item(s) imported`;
            })
          }
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {result && (
        <div className="banner info">
          <span>
            Imported {result.created.length} item(s).{result.skipped.length > 0 && ` Skipped ${result.skipped.length} row(s): ${result.skipped.map((s) => `row ${s.row} (${s.reason})`).join(", ")}.`}
            {result.unmappedColumns.length > 0 && ` Columns not used: ${result.unmappedColumns.join(", ")}.`}
          </span>
        </div>
      )}
    </div>
  );
}

function ManualEntry({ onDone }: { onDone: () => Promise<void> }) {
  const blank = { brand: "", model: "", category: "", department: "", size: "", color: "", material: "", condition: "", condition_notes: "", upc: "", storage_location: "" };
  const [f, setF] = useState(blank);
  const [cost, setCost] = useState<number | null>(null);
  const [qty, setQty] = useState("1");
  const [busy, run] = useAction();
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="Brand" hint='Use "Unbranded" if none.'>
          <input value={f.brand} onChange={set("brand")} />
        </Field>
        <Field label="Model / style name">
          <input value={f.model} onChange={set("model")} />
        </Field>
        <Field label="Item type" hint="t-shirt, jeans, sneakers…">
          <input value={f.category} onChange={set("category")} />
        </Field>
        <Field label="Department">
          <select value={f.department} onChange={set("department")}>
            <option value="">—</option>
            <option value="menswear">Men</option>
            <option value="womenswear">Women</option>
            <option value="kids">Kids</option>
            <option value="unisex">Unisex</option>
          </select>
        </Field>
        <Field label="Size">
          <input value={f.size} onChange={set("size")} />
        </Field>
        <Field label="Color">
          <input value={f.color} onChange={set("color")} />
        </Field>
        <Field label="Material">
          <input value={f.material} onChange={set("material")} />
        </Field>
        <Field label="Condition">
          <select value={f.condition} onChange={set("condition")}>
            <option value="">—</option>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {words(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Barcode / UPC">
          <input value={f.upc} onChange={set("upc")} inputMode="numeric" />
        </Field>
        <Field label="What you paid">
          <MoneyInput cents={cost} onChange={setCost} allowEmpty />
        </Field>
        <Field label="Quantity">
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Storage location">
          <input value={f.storage_location} onChange={set("storage_location")} />
        </Field>
        <Field label="Flaws and condition notes" wide>
          <textarea value={f.condition_notes} onChange={set("condition_notes")} />
        </Field>
      </div>
      <div className="row">
        <button
          className="primary"
          disabled={busy || (!f.brand && !f.category)}
          onClick={() =>
            run(async () => {
              const body: Record<string, unknown> = { quantity: Math.max(1, parseInt(qty, 10) || 1) };
              for (const [k, v] of Object.entries(f)) if (v) body[k] = v;
              if (cost !== null) body.acquisition_cost_cents = cost;
              const r = await api("/api/products", { body });
              setF(blank);
              setCost(null);
              await onDone();
              navigate(`#/product/${r.product.id}`);
              return `Added ${r.product.sku}`;
            })
          }
        >
          Add item
        </button>
        <span className="muted small">You can add photos on the next screen.</span>
      </div>
    </div>
  );
}
