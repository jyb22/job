import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app";
import { AGENT } from "../src/core/types";
import { PermanentError } from "../src/core/util";
import type { SaleEvent } from "../src/inventory/sales";
import { makeApp, manager, operatorProduct, owner, processedProduct, SIM, useSimulation } from "./helpers";

const sale = (sku: string, marketplace: SaleEvent["marketplace"], orderId: string, extra: Partial<SaleEvent> = {}): SaleEvent => ({ marketplace, externalOrderId: orderId, sku, quantity: 1, salePriceCents: 2200, ...extra });

describe("inventory updates", () => {
  it("a sale reduces available stock, increases sold, and records profit", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app, { costCents: 800 });
    const r = app.sales.recordSale(sale(product.sku, "depop", "D-1"), "marketplace_api");
    expect(r.status).toBe("recorded");
    const after = app.products.get(product.id);
    expect(after).toMatchObject({ quantity_available: 0, quantity_sold: 1 });
    // Depop default schedule: 3.3% + $0.45 = $1.18 on $22.00, estimated because the event carried no fee.
    expect(r.order).toMatchObject({ fees_cents: 118, fees_verified: 0, net_proceeds_cents: 2082, cost_cents: 800, net_profit_cents: 1282, status: "verified" });
    const movements = app.db.prepare("SELECT kind, delta_available, delta_sold FROM inventory_movements WHERE product_id = ? ORDER BY at").all(product.id);
    expect(movements).toEqual([{ kind: "intake", delta_available: 1, delta_sold: 0 }, { kind: "sale", delta_available: -1, delta_sold: 1 }]);
  });

  it("uses the marketplace's real fees when it reports them, and marks them verified", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    const r = app.sales.recordSale(sale(product.sku, "depop", "D-2", { feesCents: 411 }), "marketplace_api");
    expect(r.order).toMatchObject({ fees_cents: 411, fees_verified: 1, net_proceeds_cents: 1789 });
  });

  it("one-of-one items default to a quantity of one", () => {
    const app = makeApp();
    expect(app.products.create({}, owner, "manual").quantity_available).toBe(1);
  });

  it("multi-quantity items keep their other listings and push the new quantity", async () => {
    const app = makeApp();
    useSimulation(app);
    const product = app.products.create({ brand: "Nike", category: "t-shirt", size: "M", condition: "good", color: "black", acquisition_cost_cents: 500, quantity: 3 }, owner, "manual");
    await app.products.addImage(product.id, await (await import("./helpers")).photo(3), owner);
    await app.pipeline.process(product.id);
    await app.queue.drain({ ignoreSchedule: true });
    const listings = app.listings.forProduct(product.id);
    expect(listings.every((l) => l.status === "published")).toBe(true);

    const r = app.sales.recordSale(sale(product.sku, "ebay", "E-1"), "marketplace_api");
    expect(r.crossDelist).toHaveLength(0);
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.products.get(product.id)).toMatchObject({ quantity_available: 2, quantity_sold: 1, status: "published" });
    expect(app.listings.forProduct(product.id).every((l) => l.status === "published")).toBe(true);
    for (const l of listings) expect((await app.adapters.sim(l.marketplace).retrieveListing(l.external_id!))?.quantity).toBe(2);
  });

  it("stock can never go negative", async () => {
    const app = makeApp();
    const p = app.products.create({}, owner, "manual");
    expect(() => app.db.prepare("UPDATE products SET quantity_available = -1 WHERE id = ?").run(p.id)).toThrow(/CHECK/);
  });

  it("reservations hold stock, are idempotent, refuse to oversell, and release", () => {
    const app = makeApp();
    const p = app.products.create({ quantity: 2 }, owner, "manual");
    expect(app.sales.reserve(p.id, 1, "offer-1")).toBe(true);
    expect(app.sales.reserve(p.id, 1, "offer-1")).toBe(true); // same reference: no double hold
    expect(app.products.get(p.id)).toMatchObject({ quantity_available: 1, quantity_reserved: 1 });
    expect(app.sales.reserve(p.id, 2, "offer-2")).toBe(false);
    expect(app.sales.release("offer-1")).toBe(true);
    expect(app.sales.release("offer-1")).toBe(false);
    expect(app.products.get(p.id)).toMatchObject({ quantity_available: 2, quantity_reserved: 0 });
  });

  it("expired reservations are released", () => {
    const app = makeApp();
    const p = app.products.create({}, owner, "manual");
    app.sales.reserve(p.id, 1, "hold", -1);
    expect(app.sales.expireReservations()).toBe(1);
    expect(app.products.get(p.id).quantity_available).toBe(1);
  });
});

describe("duplicate-event prevention", () => {
  it("the same order delivered twice is recorded once", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    expect(app.sales.recordSale(sale(product.sku, "depop", "D-9"), "marketplace_api").status).toBe("recorded");
    expect(app.sales.recordSale(sale(product.sku, "depop", "D-9"), "signed_webhook").status).toBe("duplicate");
    expect(app.sales.orders()).toHaveLength(1);
    expect(app.products.get(product.id).quantity_sold).toBe(1);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM discrepancies").get()).toEqual({ n: 0 });
  });

  it("polling the same orders repeatedly does not double-count", async () => {
    const app = makeApp();
    useSimulation(app);
    const { listings } = await processedProduct(app);
    const depop = listings.find((l) => l.marketplace === "depop")!;
    app.adapters.sim("depop").simulateSale(depop.external_id!);
    expect((await app.sales.pollOrders("depop")).recorded).toBe(1);
    expect((await app.sales.pollOrders("depop")).recorded).toBe(0);
    expect((await app.sales.pollOrders("depop")).recorded).toBe(0);
    expect(app.sales.orders()).toHaveLength(1);
  });

  it("a sale for an unknown SKU is reported, not silently dropped, and can be processed later", async () => {
    const app = makeApp();
    const r = app.sales.recordSale(sale("RS-0000-999999", "ebay", "E-404"), "marketplace_api");
    expect(r.status).toBe("unknown_sku");
    expect(app.reconciler.list().map((d) => d.kind)).toContain("sale_for_unknown_sku");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM processed_events").get()).toEqual({ n: 0 });
  });
});

describe("cross-platform delisting", () => {
  it("ends every other listing after a verified sale and verifies each one", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product, listings } = await processedProduct(app);
    const depop = listings.find((l) => l.marketplace === "depop")!;
    app.adapters.sim("depop").simulateSale(depop.external_id!);
    await app.sales.pollOrders("depop");
    expect(app.products.get(product.id).status).toBe("delisting_pending");
    expect(app.listings.forProduct(product.id).filter((l) => l.status === "delisting_pending")).toHaveLength(2);
    await app.queue.drain({ ignoreSchedule: true });

    const after = Object.fromEntries(app.listings.forProduct(product.id).map((l) => [l.marketplace, l]));
    expect(after.depop!.status).toBe("sold");
    for (const m of ["ebay", "mercari"] as const) {
      expect(after[m]!.status).toBe("delisted");
      expect((await app.adapters.sim(m).retrieveListing(after[m]!.external_id!))?.status).toBe("ended");
      expect(app.adapters.sim(m).calls.end).toBe(1);
    }
    expect(app.products.get(product.id).status).toBe("sold");
    const actions = app.audit.list({ productId: product.id, limit: 500 }).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["sale.recorded", "inventory.updated", "cross_delist.started", "listing.ended"]));
    const types = app.notifications.list().map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(["item_sold", "cross_delist_ok"]));
  });

  it("retries a failed delisting and succeeds without ending anything twice", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product, listings } = await processedProduct(app);
    const ebay = app.adapters.sim("ebay");
    ebay.failNext("end");
    ebay.failNext("end");
    app.sales.recordSale(sale(product.sku, "depop", "D-3"), "marketplace_api");
    await app.queue.runOne(true);
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.listings.forProduct(product.id).find((l) => l.marketplace === "ebay")!.status).toBe("delisted");
    expect(ebay.calls.end).toBe(3);
    expect(listings).toHaveLength(3);
  });

  it("when a delisting cannot be completed the operator is alerted and a discrepancy is opened", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    app.adapters.sim("mercari").failNext("end", new PermanentError("Listing is locked by the marketplace"));
    app.sales.recordSale(sale(product.sku, "depop", "D-4"), "marketplace_api");
    await app.queue.drain({ ignoreSchedule: true });
    const mercari = app.listings.forProduct(product.id).find((l) => l.marketplace === "mercari")!;
    expect(mercari.status).toBe("delisting_pending"); // still flagged as not ended, never falsely marked done
    expect(app.products.get(product.id).status).toBe("delisting_pending");
    const alert = app.notifications.list().find((n) => n.type === "cross_delist_failed")!;
    expect(alert.severity).toBe("critical");
    expect(app.reconciler.list().map((d) => d.kind)).toContain("cross_delist_failed");
    expect(app.audit.list({ productId: product.id, action: "listing.end_failed" })).toHaveLength(1);
  });

  it("a delisting is not reported as done until the marketplace confirms it", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    const ebay = app.adapters.sim("ebay");
    const real = ebay.endListing.bind(ebay);
    let ignored = false;
    ebay.endListing = async (id) => {
      if (!ignored) {
        ignored = true; // the marketplace accepts the call but leaves the listing live
        return;
      }
      return real(id);
    };
    app.sales.recordSale(sale(product.sku, "depop", "D-5"), "marketplace_api");
    await app.queue.runOne(true);
    const afterFirst = app.listings.forProduct(product.id).find((l) => l.marketplace === "ebay")!;
    expect(afterFirst.status).toBe("delisting_pending");
    expect(afterFirst.last_error).toMatch(/still shows the listing as active/);
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.listings.forProduct(product.id).find((l) => l.marketplace === "ebay")!.status).toBe("delisted");
  });

  it("assisted marketplaces get an urgent task; the listing stays 'ending' until the operator confirms", async () => {
    const app = makeApp();
    useSimulation(app, "semi_autonomous", { marketplaces: { poshmark: { enabled: true, permissions: { publish: true } } } });
    const { product } = await operatorProduct(app);
    const posh = app.listings.forProduct(product.id).find((l) => l.marketplace === "poshmark")!;
    expect(posh.status).toBe("awaiting_operator");
    expect(posh.simulated).toBe(0);
    const postTask = app.listings.tasks("open").find((t) => t.listing_id === posh.id && t.kind === "post_listing")!;
    await expect(async () => app.listings.completeTask(postTask.id, manager, {})).rejects.toThrow(/link/);
    app.listings.completeTask(postTask.id, manager, { externalUrl: "https://poshmark.com/listing/example-123" });
    expect(app.listings.get(posh.id).status).toBe("published");

    app.sales.recordSale(sale(product.sku, "ebay", "E-7"), "marketplace_api");
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.listings.get(posh.id).status).toBe("delisting_pending");
    const endTask = app.listings.tasks("open").find((t) => t.listing_id === posh.id && t.kind === "end_listing")!;
    expect(endTask.urgent).toBe(1);
    expect(app.notifications.list().some((n) => n.type === "operator_task" && n.severity === "critical")).toBe(true);
    expect(app.products.get(product.id).status).toBe("delisting_pending");
    app.listings.completeTask(endTask.id, manager);
    expect(app.listings.get(posh.id).status).toBe("delisted");
    expect(app.products.get(product.id).status).toBe("sold");
  });

  it("a listing that was prepared but never posted is simply cancelled", async () => {
    const app = makeApp();
    useSimulation(app, "semi_autonomous", { marketplaces: { facebook: { enabled: true, permissions: { publish: true } } } });
    const { product } = await operatorProduct(app);
    const fb = app.listings.forProduct(product.id).find((l) => l.marketplace === "facebook")!;
    expect(fb.status).toBe("awaiting_operator");
    app.sales.recordSale(sale(product.sku, "ebay", "E-8"), "marketplace_api");
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.listings.get(fb.id).status).toBe("delisted");
    expect(app.listings.tasks("open").filter((t) => t.listing_id === fb.id)).toHaveLength(0);
  });

  it("drafts for a sold item are archived so they can never be published", async () => {
    const app = makeApp();
    useSimulation(app, "review_only");
    const { product, listings } = await processedProduct(app);
    await app.approvals.decide(app.approvals.list("pending").find((a) => a.marketplace === "ebay")!.id, "approve", owner);
    await app.queue.drain({ ignoreSchedule: true });
    app.sales.recordSale(sale(product.sku, "ebay", "E-9"), "marketplace_api");
    await app.queue.drain({ ignoreSchedule: true });
    const after = app.listings.forProduct(product.id);
    expect(after.find((l) => l.marketplace === "ebay")!.status).toBe("sold");
    expect(after.filter((l) => l.marketplace !== "ebay").every((l) => l.status === "archived")).toBe(true);
    expect(app.approvals.list("pending")).toHaveLength(0); // nothing is left waiting on a decision for a sold item
    expect(() => app.listings.requestPublish(listings.find((l) => l.marketplace === "depop")!.id, owner)).toThrow(/cannot be published/);
  });

  it("cross-delisting still runs during an emergency stop", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    app.settings.update({ automation: { emergencyStop: true } }, "owner-1");
    app.sales.recordSale(sale(product.sku, "depop", "D-6"), "marketplace_api");
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.listings.forProduct(product.id).filter((l) => l.status === "delisted")).toHaveLength(2);
  });

  it("if the agent lacks permission to end listings, a human is asked urgently", async () => {
    const app = makeApp();
    useSimulation(app, "semi_autonomous", { marketplaces: { ebay: { permissions: { end: false } } } });
    const { product } = await processedProduct(app);
    const r = app.sales.recordSale(sale(product.sku, "depop", "D-7"), "marketplace_api");
    expect(r.crossDelist.find((c) => c.marketplace === "ebay")!.outcome).toBe("needs_approval");
    expect(app.notifications.list().some((n) => n.type === "cross_delist_failed" && n.severity === "critical")).toBe(true);
    const approval = app.approvals.list("pending").find((a) => a.kind === "listing.end")!;
    await app.approvals.decide(approval.id, "approve", manager);
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.listings.forProduct(product.id).find((l) => l.marketplace === "ebay")!.status).toBe("delisted");
  });
});

describe("concurrent sale handling", () => {
  it("the same one-of-one item selling on two marketplaces: one sale wins, the other is flagged as a possible double sale", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    const first = app.sales.recordSale(sale(product.sku, "ebay", "E-100"), "marketplace_api");
    const second = app.sales.recordSale(sale(product.sku, "mercari", "M-100"), "marketplace_api");
    expect(first.status).toBe("recorded");
    expect(second.status).toBe("conflict");
    expect(app.products.get(product.id)).toMatchObject({ quantity_available: 0, quantity_sold: 1 });
    expect(app.sales.orders().map((o) => o.status).sort()).toEqual(["conflict", "verified"]);
    expect(app.reconciler.list().map((d) => d.kind)).toContain("possible_oversale");
    const alert = app.notifications.list().find((n) => n.type === "possible_oversale")!;
    expect(alert.severity).toBe("critical");
    // The conflicting sale is excluded from revenue: only one unit existed.
    expect(app.analytics.overview(true).sales).toMatchObject({ orders: 1, revenueCents: 2200 });
  });

  it("two independent database connections racing for the last unit never both succeed", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "resale-ops-race-"));
    const key = Buffer.alloc(32, 7).toString("base64");
    const a = createApp({ dataDir, encryptionKey: key });
    const b = createApp({ dataDir, encryptionKey: key });
    const skus: string[] = [];
    for (let i = 0; i < 25; i++) skus.push(a.products.create({ acquisition_cost_cents: 500 }, owner, "manual").sku);
    const results = await Promise.all(
      skus.flatMap((sku, i) => [
        Promise.resolve().then(() => a.sales.recordSale(sale(sku, "ebay", `E-${i}`), "marketplace_api").status),
        Promise.resolve().then(() => b.sales.recordSale(sale(sku, "depop", `D-${i}`), "marketplace_api").status),
      ]),
    );
    expect(results.filter((r) => r === "recorded")).toHaveLength(25);
    expect(results.filter((r) => r === "conflict")).toHaveLength(25);
    const rows = a.db.prepare("SELECT quantity_available, quantity_sold FROM products").all() as { quantity_available: number; quantity_sold: number }[];
    expect(rows.every((r) => r.quantity_available === 0 && r.quantity_sold === 1)).toBe(true);
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'verified'").get()).toEqual({ n: 25 });
    await a.stop();
    await b.stop();
  });

  it("a sale arriving while the other listings are still being ended is caught as a conflict", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    app.sales.recordSale(sale(product.sku, "depop", "D-200"), "marketplace_api");
    // Before the delisting jobs run, eBay reports its own sale of the same item.
    const late = app.sales.recordSale(sale(product.sku, "ebay", "E-200"), "marketplace_api");
    expect(late.status).toBe("conflict");
    await app.queue.drain({ ignoreSchedule: true });
    expect(app.products.get(product.id).quantity_sold).toBe(1);
  });
});

describe("reconciliation", () => {
  it("reports nothing when the app and the marketplaces agree", async () => {
    const app = makeApp();
    useSimulation(app);
    await processedProduct(app);
    expect(await app.reconciler.run()).toMatchObject({ checked: 3, found: 0 });
  });

  it("detects a listing that ended, changed price or changed quantity on the marketplace", async () => {
    const app = makeApp();
    useSimulation(app);
    const { listings } = await processedProduct(app);
    const by = Object.fromEntries(listings.map((l) => [l.marketplace, l]));
    app.adapters.sim("ebay").tamper(by.ebay!.external_id!, { status: "ended" });
    app.adapters.sim("depop").tamper(by.depop!.external_id!, { priceCents: 999 });
    app.adapters.sim("mercari").tamper(by.mercari!.external_id!, { quantity: 5 });
    const summary = await app.reconciler.run();
    expect(summary.found).toBe(3);
    expect(app.reconciler.list().map((d) => d.kind).sort()).toEqual(["ended_on_marketplace", "price_mismatch", "quantity_mismatch"]);
    expect(app.notifications.list().filter((n) => n.type === "inventory_discrepancy")).toHaveLength(3);
    // Running again does not duplicate open discrepancies…
    expect((await app.reconciler.run()).found).toBe(0);
    // …and they close on their own once the difference is gone.
    app.adapters.sim("depop").tamper(by.depop!.external_id!, { priceCents: by.depop!.price_cents });
    expect((await app.reconciler.run()).autoResolved).toBe(1);
  });

  it("finds a sold item that is still live on a marketplace and ends it", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product, listings } = await processedProduct(app);
    app.sales.recordSale(sale(product.sku, "depop", "D-300"), "marketplace_api");
    await app.queue.drain({ ignoreSchedule: true });
    const ebay = listings.find((l) => l.marketplace === "ebay")!;
    app.adapters.sim("ebay").tamper(ebay.external_id!, { status: "active", quantity: 1 }); // the marketplace quietly relisted it
    const summary = await app.reconciler.run();
    expect(summary.found).toBe(1);
    expect(app.reconciler.list()[0]!.kind).toBe("still_live_on_marketplace");
    await app.queue.drain({ ignoreSchedule: true });
    expect((await app.adapters.sim("ebay").retrieveListing(ebay.external_id!))?.status).toBe("ended");
  });

  it("says which listings it cannot check automatically", async () => {
    const app = makeApp();
    useSimulation(app, "semi_autonomous", { marketplaces: { poshmark: { enabled: true, permissions: { publish: true } } } });
    const { product } = await operatorProduct(app);
    const posh = app.listings.forProduct(product.id).find((l) => l.marketplace === "poshmark")!;
    app.listings.completeTask(app.listings.tasks("open").find((t) => t.listing_id === posh.id)!.id, manager, { externalUrl: "https://poshmark.com/listing/x" });
    expect(await app.reconciler.run()).toMatchObject({ checked: 3, unverifiable: 1 });
  });
});

describe("simulated data cannot reach a real marketplace", () => {
  it("an item identified and priced from simulated data is held on a non-simulated marketplace", async () => {
    const app = makeApp();
    useSimulation(app, "semi_autonomous", { marketplaces: { poshmark: { enabled: true, permissions: { publish: true } } } });
    const { product } = await processedProduct(app);
    const by = Object.fromEntries(app.listings.forProduct(product.id).map((l) => [l.marketplace, l]));
    expect(by.ebay!.status).toBe("published"); // simulated marketplace: fine
    expect(by.poshmark!.status).toBe("needs_review"); // real marketplace: refused
    const approval = app.approvals.list("pending").find((a) => a.marketplace === "poshmark")!;
    const reasons = JSON.parse(approval.reasons).map((r: { code: string }) => r.code);
    expect(reasons).toEqual(expect.arrayContaining(["risk_flags", "real_market_data"]));
    expect(app.listings.tasks("open")).toHaveLength(0);
  });
});

describe("sale sources", () => {
  it("the agent itself cannot be a sale source: only the API, a signed webhook or an operator", async () => {
    const app = makeApp();
    useSimulation(app);
    const { product } = await processedProduct(app);
    const r = app.sales.recordSale(sale(product.sku, "mercari", "M-1"), "operator", manager);
    expect(r.order?.source).toBe("operator");
    expect(app.audit.list({ action: "sale.recorded" })[0]).toMatchObject({ actor_type: "user", actor_id: "manager-1" });
    expect(AGENT.type).toBe("agent");
  });

  it("simulated sales are kept out of real totals", async () => {
    const app = makeApp();
    useSimulation(app);
    const { listings } = await processedProduct(app);
    app.adapters.sim("depop").simulateSale(listings.find((l) => l.marketplace === "depop")!.external_id!);
    await app.sales.pollOrders("depop");
    expect(app.analytics.overview(false).sales.orders).toBe(0);
    expect(app.analytics.overview(false).simulated.orders).toBe(1);
    expect(app.analytics.overview(true).sales.orders).toBe(1);
    expect(SIM).toContain("depop");
  });
});
