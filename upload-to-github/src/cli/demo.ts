// End-to-end demonstration of the whole workflow against SIMULATED
// marketplaces, SIMULATED vision and SIMULATED comparables.
//
//   npm run demo            (uses a throwaway folder, deleted afterwards)
//   npm run demo -- --keep  (keeps the demo data in ./data/demo)
//
// Nothing here touches a real marketplace account, a real AI model or real
// money. It proves that the application logic — pipeline, pricing, policy,
// idempotent publishing, sale processing, cross-delisting, audit, reporting —
// works together. It does not prove the eBay or Depop API integrations.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../app";
import type { Actor, MarketplaceId } from "../core/types";
import { dollars } from "../core/util";

const keep = process.argv.includes("--keep");
const dataDir = keep ? path.resolve("data/demo") : mkdtempSync(path.join(tmpdir(), "resale-ops-demo-"));
const operator: Actor = { type: "user", id: "demo-operator", role: "owner" };
const SIM: MarketplaceId[] = ["ebay", "depop", "mercari"];

let stepNo = 0;
const step = (title: string) => console.log(`\n${String(++stepNo).padStart(2, " ")}. ${title}`);
const line = (text: string) => console.log(`    ${text}`);

/** A stand-in product photograph, generated locally so the demo needs no files. */
async function samplePhoto(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1400">
    <rect width="1400" height="1400" fill="#e9e6df"/>
    <path d="M430 300 L560 240 Q700 330 840 240 L970 300 L1130 470 L1010 580 L930 510 L930 1150 L470 1150 L470 510 L390 580 L270 470 Z" fill="#17181c" stroke="#000" stroke-width="6"/>
    <text x="700" y="640" font-family="Helvetica, Arial" font-size="120" font-weight="700" fill="#f4f4f4" text-anchor="middle">NIKE</text>
    <rect x="655" y="262" width="90" height="46" fill="#fff"/><text x="700" y="296" font-family="Helvetica, Arial" font-size="30" fill="#111" text-anchor="middle">M</text>
    <g stroke="#3a3b40" stroke-width="3">${Array.from({ length: 40 }, (_, i) => `<line x1="${480 + i * 11}" y1="700" x2="${484 + i * 11}" y2="1130"/>`).join("")}</g>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

async function main() {
  console.log("Resale Ops — end-to-end demonstration");
  console.log("=====================================");
  console.log("Everything below runs on SIMULATED marketplaces, SIMULATED vision and SIMULATED comparables.\n");

  const app = createApp({ dataDir });
  for (const m of SIM) app.connections.setMode(m, "simulated");
  app.settings.update(
    {
      ai: { provider: "simulated" },
      research: { simulated: true },
      automation: { mode: "semi_autonomous" },
      marketplaces: Object.fromEntries(SIM.map((m) => [m, { enabled: true, permissions: { publish: true } }])),
    },
    "demo",
  );

  step("Upload one merchandise photograph");
  const product = app.products.create({ acquisition_cost_cents: 800, storage_location: "Bin A3" }, operator, "upload");
  const { image } = await app.products.addImage(product.id, await samplePhoto(), operator);
  line(`Product ${product.id} created. Photo stored: ${image.width}×${image.height}, sharpness ${image.blur_score}, issues: ${JSON.parse(image.quality).issues.join(", ") || "none"}`);
  line(`Original kept at ${path.relative(dataDir, image.original_path)}; optimised copy at ${path.relative(dataDir, image.optimized_path!)}`);

  step("Generate a SKU");
  line(`SKU ${product.sku} · acquisition cost ${dollars(product.acquisition_cost_cents)} · quantity ${product.quantity_available}`);

  step("Identify the product (SIMULATED vision provider — fixed sample output, the photo is not analysed)");
  const run = await app.pipeline.process(product.id);
  const p = app.products.get(product.id);
  const attrs = JSON.parse(p.attributes) as Record<string, { value: string; basis: string; confidence: number }>;
  for (const [name, a] of Object.entries(attrs)) line(`${name.padEnd(13)} ${a.value.padEnd(22)} ${a.basis.padEnd(9)} confidence ${Math.round(a.confidence * 100)}%`);
  line(`Overall identification confidence: ${Math.round((p.identification_confidence ?? 0) * 100)}%`);

  step("Retrieve product information");
  const ident = JSON.parse(p.identification!);
  line(ident.summary);
  line(`Defects recorded: ${ident.defects.join("; ") || "none"} · risk flags: ${JSON.parse(p.risk_flags).join(", ") || "none"}`);

  step("Research active and sold comparables (SIMULATED data)");
  const comps = app.research.comps(p.id);
  const sold = comps.filter((c) => c.kind === "sold");
  line(`${sold.length} sold and ${comps.length - sold.length} active comparables stored; sold range ${dollars(Math.min(...sold.map((c) => c.price_cents)))}–${dollars(Math.max(...sold.map((c) => c.price_cents)))}`);

  step("Calculate recommended prices (deterministic engine)");
  const rec = app.research.latestRecommendation(p.id)!;
  line(`Basis: ${rec.basis} · premium ${dollars(rec.premiumCents)} · competitive ${dollars(rec.competitiveCents)} · expected ${dollars(rec.expectedSellingCents)} · confidence ${Math.round(rec.confidence * 100)}% · time to sale: ${rec.timeToSale}`);
  for (const d of rec.disclosures) line(`Disclosure: ${d}`);

  step("Calculate expected net profit per marketplace");
  for (const m of rec.perMarketplace) {
    line(`${m.marketplace.padEnd(8)} list ${dollars(m.listPriceCents)} · floor ${dollars(m.minAcceptableCents)} · fees ${dollars(m.atListPrice.totalFeesCents)} · net proceeds ${dollars(m.atListPrice.netProceedsCents)} · net profit ${dollars(m.atListPrice.netProfitCents)} (${m.atListPrice.marginPct}%)`);
  }

  step("Generate separate eBay, Depop and Mercari listings");
  const listings = app.listings.forProduct(p.id);
  for (const l of listings) {
    line(`${l.marketplace.padEnd(8)} [${l.writer}] ${l.title ? `title: "${l.title}"` : `first line: "${l.description.split("\n")[0]}"`}`);
  }

  step("Validate marketplace requirements and score quality");
  for (const l of listings) {
    const v = JSON.parse(l.validation);
    line(`${l.marketplace.padEnd(8)} valid: ${v.ok} · quality ${l.quality_score}/100 · category: ${l.category_name}${v.warnings.length ? ` · warnings: ${v.warnings.join(" ")}` : ""}`);
  }

  step("Check authorisation rules (deterministic policy engine, semi-autonomous mode)");
  for (const r of run.listings) line(`${r.marketplace.padEnd(8)} → ${r.outcome}`);

  step("Publish (SIMULATED marketplaces) and verify");
  const jobs = await app.queue.drain();
  line(`${jobs} background job(s) processed`);

  step("Store the listing identifiers");
  const published = app.listings.forProduct(p.id);
  for (const l of published) line(`${l.marketplace.padEnd(8)} ${l.status.padEnd(10)} external id ${l.external_id} · ${l.external_url}`);
  if (published.some((l) => l.status !== "published")) throw new Error("Demo failed: not every listing was published");

  step("Simulate a completed sale on Depop");
  const depop = published.find((l) => l.marketplace === "depop")!;
  const order = app.adapters.sim("depop").simulateSale(depop.external_id!);
  line(`Simulated buyer purchased ${order.sku} for ${dollars(order.salePriceCents)} (order ${order.externalOrderId})`);
  const poll = await app.sales.pollOrders("depop");
  line(`Order poll fetched ${poll.fetched}, recorded ${poll.recorded}`);
  const again = await app.sales.pollOrders("depop");
  line(`Second poll of the same order: fetched ${again.fetched}, recorded ${again.recorded} (duplicate ignored)`);

  step("Update centralised inventory");
  const after = app.products.get(p.id);
  line(`Available ${after.quantity_available} · sold ${after.quantity_sold} · product status: ${after.status}`);

  step("Cross-platform delisting");
  line(`${await app.queue.drain()} delisting job(s) processed`);

  step("Verify the remaining listings were ended");
  for (const l of app.listings.forProduct(p.id)) {
    const remote = await app.adapters.sim(l.marketplace).retrieveListing(l.external_id!);
    line(`${l.marketplace.padEnd(8)} local: ${l.status.padEnd(9)} marketplace reports: ${remote?.status}`);
    if (l.marketplace !== "depop" && (l.status !== "delisted" || remote?.status !== "ended")) throw new Error(`Demo failed: ${l.marketplace} listing was not ended`);
  }
  line(`Product status: ${app.products.get(p.id).status}`);
  const rec2 = await app.reconciler.run();
  line(`Reconciliation: ${rec2.checked} listing(s) checked against marketplaces, ${rec2.found} discrepancy(ies) found`);

  step("Audit log (every operation, oldest first)");
  const audit = app.audit.list({ productId: p.id, limit: 500 }).reverse();
  for (const a of audit) line(`${a.at.slice(11, 19)} ${a.actor_type.padEnd(6)} ${a.action.padEnd(34)} ${a.outcome.padEnd(7)} ${a.marketplace ?? ""}`);
  line(`${audit.length} audit entries for this product`);

  step("Profitability report (includes SIMULATED sales, flagged as such)");
  const report = app.analytics.generateReport(7, true);
  const s = report.overview.sales;
  line(`Orders ${s.orders} · revenue ${dollars(s.revenueCents)} · net proceeds ${dollars(s.netProceedsCents)} (verified ${dollars(s.netProceedsVerifiedCents)}, estimated ${dollars(s.netProceedsEstimatedCents)}) · net profit ${dollars(s.netProfitCents)} · margin ${s.marginPct}%`);
  for (const row of report.products as { sku: string; marketplace: string; salePriceCents: number; feesCents: number; feesVerified: number; costCents: number; netProfitCents: number }[]) {
    line(`${row.sku} sold on ${row.marketplace} for ${dollars(row.salePriceCents)} − fees ${dollars(row.feesCents)}${row.feesVerified ? "" : " (estimated)"} − cost ${dollars(row.costCents)} = profit ${dollars(row.netProfitCents)}`);
  }
  line(`Report stored as ${report.id}. includesSimulatedData = ${report.includesSimulatedData}`);

  await app.notifications.flush();
  console.log(`\nNotifications raised: ${app.notifications.list({ limit: 50 }).length}`);
  console.log("\nDemonstration complete. All marketplace activity above was SIMULATED.");
  await app.stop();
  if (!keep) rmSync(dataDir, { recursive: true, force: true });
  else console.log(`Demo data kept in ${dataDir}`);
}

main().catch((error) => {
  console.error("\nDEMO FAILED:", error);
  process.exit(1);
});
