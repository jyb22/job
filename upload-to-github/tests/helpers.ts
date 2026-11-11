import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp, type App, type AppConfig } from "../src/app";
import type { Actor, CompRow, MarketplaceId } from "../src/core/types";
import { deepMerge } from "../src/settings/store";

export const SIM: MarketplaceId[] = ["ebay", "depop", "mercari"];
export const owner: Actor = { type: "user", id: "owner-1", role: "owner" };
export const manager: Actor = { type: "user", id: "manager-1", role: "manager" };
export const viewer: Actor = { type: "user", id: "viewer-1", role: "viewer" };

export function makeApp(config: Partial<AppConfig> = {}): App {
  const dataDir = mkdtempSync(path.join(tmpdir(), "resale-ops-test-"));
  return createApp({ dataDir, dbFile: ":memory:", saleWebhookSecret: "test-webhook-secret", ...config });
}

/** Put eBay, Depop and Mercari in simulated mode with simulated vision and comparables. */
export function useSimulation(app: App, mode: "review_only" | "semi_autonomous" | "full_autonomous" = "semi_autonomous", extra: Record<string, unknown> = {}): void {
  for (const m of SIM) app.connections.setMode(m, "simulated");
  const base = {
    ai: { provider: "simulated" },
    research: { simulated: true },
    automation: { mode, ...(mode === "full_autonomous" ? { fullAutonomyAcknowledgedAt: new Date().toISOString() } : {}) },
    marketplaces: Object.fromEntries(SIM.map((m) => [m, { enabled: true, permissions: { publish: true, reprice: true, updateContent: true } }])),
  };
  app.settings.update(deepMerge(base, extra), "test");
}

/**
 * A product whose details were entered by the operator and whose price rests on
 * real (operator-entered) sold comparables — i.e. nothing simulated about it, so
 * it is eligible for non-simulated marketplaces such as the assisted ones.
 */
export async function operatorProduct(app: App, seed = 11) {
  app.settings.update({ research: { simulated: false } }, "test");
  const product = app.products.create({ brand: "Levi's", model: "501", category: "jeans", department: "menswear", size: "32x32", color: "blue", condition: "good", acquisition_cost_cents: 900 }, owner, "manual");
  await app.products.addImage(product.id, await photo(seed), owner);
  for (const [i, priceCents] of [3400, 3600, 3800, 4000, 4200].entries()) {
    app.research.addManualComp(product.id, { marketplace: "ebay", kind: "sold", title: "Levi's 501 jeans 32x32 blue", priceCents, soldAt: new Date(Date.now() - (i + 1) * 5 * 86_400_000).toISOString() }, owner);
  }
  const result = await app.pipeline.process(product.id);
  await app.queue.drain({ ignoreSchedule: true });
  return { product: app.products.get(product.id), result, listings: app.listings.forProduct(product.id) };
}

/** A sharp, distinct test photo. Different seeds give visually different pictures. */
export async function photo(seed = 1, size = 1200): Promise<Buffer> {
  const hue = (seed * 67) % 360;
  const bars = Array.from({ length: 12 }, (_, i) => `<rect x="${60 + ((i * 97 * seed) % (size - 200))}" y="${80 + i * 70}" width="${120 + ((seed * 31 * (i + 1)) % 300)}" height="34" fill="hsl(${(hue + i * 40) % 360} 70% ${25 + ((i * seed) % 5) * 10}%)"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="hsl(${hue} 30% 88%)"/>${bars}<text x="${size / 2}" y="${size - 90}" font-family="Helvetica, Arial" font-size="110" font-weight="700" text-anchor="middle" fill="#111">ITEM ${seed}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/** Upload one photo, run the whole pipeline and all background jobs. */
export async function processedProduct(app: App, opts: { seed?: number; costCents?: number | null } = {}) {
  const product = app.products.create({ acquisition_cost_cents: opts.costCents === undefined ? 800 : opts.costCents }, owner, "upload");
  await app.products.addImage(product.id, await photo(opts.seed ?? 1), owner);
  const result = await app.pipeline.process(product.id);
  await app.queue.drain({ ignoreSchedule: true });
  return { product: app.products.get(product.id), result, listings: app.listings.forProduct(product.id) };
}

export function comp(overrides: Partial<CompRow> = {}): CompRow {
  return {
    id: `cmp_${Math.random().toString(36).slice(2)}`,
    product_id: "prd_test",
    source: "test",
    marketplace: "ebay",
    kind: "sold",
    title: "Test item",
    price_cents: 2000,
    shipping_cents: null,
    condition: null,
    size: null,
    sold_at: new Date().toISOString(),
    listed_at: null,
    url: null,
    similarity: 1,
    simulated: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a multipart/form-data body for server tests. */
export function multipart(fields: Record<string, string>, files: { field: string; filename: string; type: string; data: Buffer }[]) {
  const boundary = "----resaleopstest" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
