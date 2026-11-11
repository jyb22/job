import { useState } from "react";
import { api, canWrite, Card, Empty, Field, Loading, MARKETPLACE_NAMES, money, MoneyInput, SimChip, Status, useAction, useLoad, useMe, when, words } from "../ui";

interface Order {
  id: string;
  marketplace: string;
  external_order_id: string;
  product_id: string | null;
  sku: string;
  quantity: number;
  sale_price_cents: number;
  fees_cents: number;
  fees_verified: number;
  shipping_cost_cents: number;
  net_proceeds_cents: number;
  net_profit_cents: number | null;
  status: string;
  source: string;
  simulated: number;
  sold_at: string;
}

export function Sales() {
  const me = useMe();
  const { data, error, reload } = useLoad<{ orders: Order[] }>("/api/sales", 8000);
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Sales</h1>
          <p>Recorded sales. When an item sells, its other listings are ended automatically or queued for you to end.</p>
        </div>
        {canWrite(me) && (
          <button className="primary" onClick={() => setOpen((v) => !v)}>
            {open ? "Close" : "Record a sale"}
          </button>
        )}
      </div>
      {open && <RecordSale onDone={reload} />}
      <Card tight>
        {!data ? (
          <Loading error={error} />
        ) : data.orders.length === 0 ? (
          <Empty>No sales yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sold</th>
                  <th>Item</th>
                  <th>Marketplace</th>
                  <th className="right">Sold for</th>
                  <th className="right">Fees</th>
                  <th className="right">Shipping</th>
                  <th className="right">Net proceeds</th>
                  <th className="right">Profit</th>
                  <th>Reported by</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap">{when(o.sold_at)}</td>
                    <td>
                      {o.product_id ? (
                        <a className="mono" href={`#/product/${o.product_id}`}>
                          {o.sku}
                        </a>
                      ) : (
                        <span className="mono">{o.sku}</span>
                      )}
                      {o.quantity > 1 && <span className="muted small"> × {o.quantity}</span>}
                    </td>
                    <td className="nowrap">
                      {MARKETPLACE_NAMES[o.marketplace]} {o.simulated === 1 && <SimChip />}
                    </td>
                    <td className="right num">{money(o.sale_price_cents)}</td>
                    <td className="right num">
                      {money(o.fees_cents)} {!o.fees_verified && <span className="muted small" title="Estimated from your fee schedule; the marketplace did not report its fee">est.</span>}
                    </td>
                    <td className="right num">{money(o.shipping_cost_cents)}</td>
                    <td className="right num">{money(o.net_proceeds_cents)}</td>
                    <td className="right num">{o.net_profit_cents === null ? <span className="muted small">no cost</span> : money(o.net_profit_cents)}</td>
                    <td className="small">{words(o.source)}</td>
                    <td>{o.status === "conflict" ? <span className="chip bad">Possible double sale</span> : <Status value={o.status} />}</td>
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

function RecordSale({ onDone }: { onDone: () => Promise<void> }) {
  const [marketplace, setMarketplace] = useState("mercari");
  const [sku, setSku] = useState("");
  const [orderId, setOrderId] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [fees, setFees] = useState<number | null>(null);
  const [shipping, setShipping] = useState<number | null>(null);
  const [busy, run] = useAction();
  return (
    <Card title="Record a sale">
      <div className="stack">
        <p className="muted small">For marketplaces with no orders API (Mercari, Poshmark, Facebook, Etsy). Sales on API-connected marketplaces are picked up automatically.</p>
        <div className="form-grid">
          <Field label="Marketplace">
            <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
              {Object.entries(MARKETPLACE_NAMES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="SKU">
            <input value={sku} onChange={(e) => setSku(e.target.value.trim())} placeholder="RS-2611-000001" />
          </Field>
          <Field label="Order number" hint="From the marketplace. Stops the same sale being counted twice.">
            <input value={orderId} onChange={(e) => setOrderId(e.target.value.trim())} />
          </Field>
          <Field label="Sold for">
            <MoneyInput cents={price} onChange={setPrice} allowEmpty />
          </Field>
          <Field label="Fees charged" hint="Leave blank to estimate from your fee schedule.">
            <MoneyInput cents={fees} onChange={setFees} allowEmpty />
          </Field>
          <Field label="Shipping you paid" hint="Leave blank to use your shipping settings.">
            <MoneyInput cents={shipping} onChange={setShipping} allowEmpty />
          </Field>
        </div>
        <div className="row">
          <button
            className="primary"
            disabled={busy || !sku || !orderId || price === null}
            onClick={() =>
              run(async () => {
                const body: Record<string, unknown> = { marketplace, sku, externalOrderId: orderId, quantity: 1, salePriceCents: price };
                if (fees !== null) body.feesCents = fees;
                if (shipping !== null) body.shippingCostCents = shipping;
                const r = await api("/api/sales", { body });
                await onDone();
                if (r.status === "duplicate") return "That order was already recorded.";
                if (r.status === "unknown_sku") throw new Error("No item has that SKU.");
                if (r.status === "conflict") throw new Error("This item had already sold. Recorded as a possible double sale — check the review queue.");
                setSku("");
                setOrderId("");
                setPrice(null);
                setFees(null);
                setShipping(null);
                return `Sale recorded. ${r.crossDelist.length} other listing(s) are being ended.`;
              })
            }
          >
            Record sale
          </button>
        </div>
      </div>
    </Card>
  );
}
