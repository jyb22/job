import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server";
import type { App } from "../src/app";
import { hmacHex } from "../src/security/crypto";
import { makeApp, multipart, photo, SIM, useSimulation } from "./helpers";

// Test accounts for this local, in-memory instance only.
const PASSWORDS = { owner: "owner-test-password-1", manager: "manager-test-password-1", viewer: "viewer-test-password-1" };

let app: App;
let server: FastifyInstance;
const cookies: Record<string, string> = {};

async function login(role: keyof typeof PASSWORDS): Promise<string> {
  const res = await server.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${role}@example.test`, password: PASSWORDS[role] } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "rs_session")!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  return `rs_session=${cookie.value}`;
}

const call = (role: keyof typeof PASSWORDS | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({
    method: method as "GET",
    url,
    payload: payload as object,
    headers: { ...(role ? { cookie: cookies[role]! } : {}), ...(method !== "GET" ? { "x-requested-with": "resale-ops" } : {}), ...headers },
  });

beforeAll(async () => {
  app = makeApp();
  useSimulation(app, "review_only");
  for (const role of ["owner", "manager", "viewer"] as const) app.auth.createUser(`${role}@example.test`, PASSWORDS[role], role);
  server = await buildServer(app);
  for (const role of ["owner", "manager", "viewer"] as const) cookies[role] = await login(role);
});

describe("API authentication", () => {
  it("health is public; everything else needs a session", async () => {
    expect((await call(null, "GET", "/api/health")).statusCode).toBe(200);
    for (const url of ["/api/overview", "/api/products", "/api/settings", "/api/audit", "/api/review", "/api/sales", "/api/connections", "/api/users"]) {
      expect((await call(null, "GET", url)).statusCode, url).toBe(401);
    }
  });

  it("rejects a wrong password without saying whether the account exists", async () => {
    const wrong = await server.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@example.test", password: "not-the-password" } });
    const unknown = await server.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@example.test", password: "not-the-password" } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().message).toBe(unknown.json().message);
  });

  it("rejects a forged or expired session cookie", async () => {
    expect((await server.inject({ method: "GET", url: "/api/overview", headers: { cookie: "rs_session=forged-value" } })).statusCode).toBe(401);
    const stale = await login("viewer");
    app.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash != ''").run(new Date(Date.now() - 1000).toISOString());
    expect((await server.inject({ method: "GET", url: "/api/overview", headers: { cookie: stale } })).statusCode).toBe(401);
    for (const role of ["owner", "manager", "viewer"] as const) cookies[role] = await login(role);
  });

  it("only a hash of the session token is stored", () => {
    const token = cookies.owner!.split("=")[1]!;
    const rows = app.db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });

  it("state-changing requests without the anti-forgery header are refused", async () => {
    const res = await server.inject({ method: "POST", url: "/api/automation/pause", payload: { paused: true }, headers: { cookie: cookies.owner! } });
    expect(res.statusCode).toBe(403);
    expect(app.settings.get().automation.paused).toBe(false);
  });

  it("locks an account after repeated failures", async () => {
    app.auth.createUser("lockme@example.test", "lockme-test-password-1", "viewer");
    for (let i = 0; i < 8; i++) expect(() => app.auth.login("lockme@example.test", "bad-password-attempt")).toThrow(/incorrect/);
    expect(() => app.auth.login("lockme@example.test", "lockme-test-password-1")).toThrow(/Too many/);
    expect(app.notifications.list().some((n) => n.type === "suspicious_activity")).toBe(true);
  });

  it("sends security headers", async () => {
    const res = await call("viewer", "GET", "/api/overview");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});

describe("API authorisation by role", () => {
  it("a viewer can read but cannot change anything", async () => {
    expect((await call("viewer", "GET", "/api/products")).statusCode).toBe(200);
    const attempts: [string, string, unknown][] = [
      ["POST", "/api/products", { brand: "Nike", category: "t-shirt" }],
      ["POST", "/api/sales", { marketplace: "ebay", externalOrderId: "x", sku: "x", salePriceCents: 100 }],
      ["POST", "/api/automation/pause", { paused: true }],
      ["POST", "/api/automation/emergency-stop", {}],
      ["PUT", "/api/settings", { pricing: { minProfitCents: 0 } }],
      ["POST", "/api/reconcile", {}],
      ["POST", "/api/users", { email: "x@example.test", password: "password-password", role: "owner" }],
    ];
    for (const [method, url, body] of attempts) expect((await call("viewer", method, url, body)).statusCode, url).toBe(403);
  });

  it("a manager can operate but cannot change settings, connections, users, the mode or release the stop", async () => {
    expect((await call("manager", "POST", "/api/products", { brand: "Nike", category: "t-shirt", size: "M", condition: "good" })).statusCode).toBe(200);
    const denied: [string, string, unknown][] = [
      ["PUT", "/api/settings", { pricing: { minProfitCents: 0 } }],
      ["PUT", "/api/connections/depop", { mode: "api", apiKey: "pak_test_key_value" }],
      ["POST", "/api/users", { email: "x@example.test", password: "password-password", role: "owner" }],
      ["POST", "/api/automation/mode", { mode: "full_autonomous", acknowledge: true }],
      ["POST", "/api/automation/release", {}],
      ["GET", "/api/users", undefined],
    ];
    for (const [method, url, body] of denied) expect((await call("manager", method, url, body)).statusCode, url).toBe(403);
    expect(app.settings.get().pricing.minProfitCents).toBe(500);
  });

  it("the settings endpoint cannot be used to switch mode, stop or pause behind the audited controls", async () => {
    const res = await call("owner", "PUT", "/api/settings", { automation: { mode: "full_autonomous", emergencyStop: true, paused: true, fullAutonomyAcknowledgedAt: "2020-01-01T00:00:00Z" }, pricing: { minProfitCents: 700 } });
    expect(res.statusCode).toBe(200);
    expect(app.settings.get().automation).toMatchObject({ mode: "review_only", emergencyStop: false, paused: false, fullAutonomyAcknowledgedAt: null });
    expect(app.settings.get().pricing.minProfitCents).toBe(700);
    await call("owner", "PUT", "/api/settings", { pricing: { minProfitCents: 500 } });
  });

  it("full autonomous mode needs an owner and an explicit acknowledgement", async () => {
    expect((await call("owner", "POST", "/api/automation/mode", { mode: "full_autonomous" })).statusCode).toBe(400);
    expect(app.settings.get().automation.mode).toBe("review_only");
    expect((await call("owner", "POST", "/api/automation/mode", { mode: "full_autonomous", acknowledge: true })).statusCode).toBe(200);
    expect(app.settings.get().automation.fullAutonomyAcknowledgedAt).not.toBeNull();
    await call("owner", "POST", "/api/automation/mode", { mode: "review_only" });
    expect(app.audit.list({ action: "automation.mode_changed" }).length).toBe(2);
  });

  it("invalid settings are rejected with a clear message", async () => {
    const res = await call("owner", "PUT", "/api/settings", { pricing: { minMarginPct: 400 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_settings");
  });

  it("API connections are refused for marketplaces with no official seller API", async () => {
    const res = await call("owner", "PUT", "/api/connections/mercari", { mode: "api" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/No public seller API/);
    expect(app.connections.get("mercari").mode).toBe("simulated");
  });

  it("saving a marketplace key is audited without recording the key, and it is never returned", async () => {
    const res = await call("owner", "PUT", "/api/connections/depop", { apiKey: "pak_test_0123456789abcdef" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("pak_test_0123456789abcdef");
    const audit = app.audit.list({ action: "connection.updated" })[0]!;
    expect(audit.detail).not.toContain("pak_test");
    expect(JSON.parse(audit.detail!)).toMatchObject({ credentialsChanged: true });
    expect((await call("owner", "GET", "/api/connections")).body).not.toContain("pak_test_0123456789abcdef");
    await call("owner", "PUT", "/api/connections/depop", { apiKey: "" });
  });
});

describe("emergency stop over the API", () => {
  it("a manager can engage it, only an owner can release it, and both are audited", async () => {
    expect((await call("manager", "POST", "/api/automation/emergency-stop", { reason: "Something looks wrong" })).statusCode).toBe(200);
    expect(app.settings.get().automation.emergencyStop).toBe(true);
    expect((await call("manager", "POST", "/api/automation/release", {})).statusCode).toBe(403);
    expect(app.settings.get().automation.emergencyStop).toBe(true);
    // Reads keep working while stopped.
    expect((await call("viewer", "GET", "/api/overview")).json().automation.emergencyStop).toBe(true);
    expect((await call("viewer", "GET", "/api/analytics")).statusCode).toBe(200);
    expect((await call("owner", "POST", "/api/automation/release", {})).statusCode).toBe(200);
    expect(app.settings.get().automation.emergencyStop).toBe(false);
    expect(app.audit.list({ action: "automation.emergency_stop" }).map((a) => a.action).sort()).toEqual(["automation.emergency_stop", "automation.emergency_stop_released"]);
    expect(app.notifications.list().some((n) => n.title === "Emergency stop engaged" && n.severity === "critical")).toBe(true);
  });
});

describe("uploads over the API", () => {
  it("creates a product from a photo, skips exact duplicates and rejects non-images", async () => {
    const jpg = await photo(21);
    const first = multipart({ mode: "single", cost_cents: "900", process: "false" }, [{ field: "files", filename: "a.jpg", type: "image/jpeg", data: jpg }]);
    const res = await call("manager", "POST", "/api/products/upload", first.payload, first.headers);
    expect(res.statusCode).toBe(200);
    const created = res.json().created;
    expect(created).toHaveLength(1);
    expect(created[0].photos).toBe(1);
    expect(app.products.get(created[0].id).acquisition_cost_cents).toBe(900);

    const again = multipart({ mode: "single", process: "false" }, [
      { field: "files", filename: "same.jpg", type: "image/jpeg", data: jpg },
      { field: "files", filename: "evil.jpg", type: "image/jpeg", data: Buffer.from("<?php echo 1; ?>") },
    ]);
    const res2 = await call("manager", "POST", "/api/products/upload", again.payload, again.headers);
    expect(res2.json().created).toHaveLength(0);
    expect(res2.json().skipped.map((s: { reason: string }) => s.reason)).toEqual([expect.stringMatching(/already on/), "Not a readable image"]);
  });

  it("each-photo mode makes one product per photo", async () => {
    const body = multipart({ mode: "each", process: "false" }, [
      { field: "files", filename: "1.jpg", type: "image/jpeg", data: await photo(31) },
      { field: "files", filename: "2.jpg", type: "image/jpeg", data: await photo(32) },
    ]);
    const res = await call("manager", "POST", "/api/products/upload", body.payload, body.headers);
    expect(res.json().created).toHaveLength(2);
  });

  it("serves images only by database id, never by path", async () => {
    const product = app.products.list()[0]!;
    const image = app.products.images(app.products.list().find((p) => app.products.images(p.id).length > 0)!.id)[0]!;
    expect((await call("viewer", "GET", `/api/images/${image.id}`)).statusCode).toBe(200);
    expect((await call("viewer", "GET", `/api/images/${encodeURIComponent("../../etc/passwd")}`)).statusCode).toBe(404);
    expect((await call(null, "GET", `/api/images/${image.id}`)).statusCode).toBe(401);
    expect((await call(null, "GET", `/public/img/${image.id}.jpg?s=wrong`)).statusCode).toBe(404);
    expect((await call(null, "GET", `/public/img/${image.id}.jpg?s=${app.box.sign(image.id)}`)).statusCode).toBe(200);
    expect(product.id).toBeTruthy();
  });

  it("rejects unknown fields and invalid values on product edits", async () => {
    const id = app.products.list()[0]!.id;
    expect((await call("manager", "PATCH", `/api/products/${id}`, { status: "published" })).statusCode).toBe(400);
    expect((await call("manager", "PATCH", `/api/products/${id}`, { quantity_available: 99 })).statusCode).toBe(400);
    expect((await call("manager", "PATCH", `/api/products/${id}`, { condition: "immaculate" })).statusCode).toBe(400);
    expect((await call("manager", "PATCH", `/api/products/${id}`, { acquisition_cost_cents: -5 })).statusCode).toBe(400);
  });
});

describe("sale webhooks", () => {
  const body = (sku: string, order: string) => JSON.stringify({ marketplace: "mercari", externalOrderId: order, sku, quantity: 1, salePriceCents: 1800 });

  it("accepts a correctly signed sale and ignores a replay", async () => {
    const product = app.products.create({ acquisition_cost_cents: 500 }, { type: "user", id: "t", role: "owner" }, "manual");
    const payload = body(product.sku, "WH-1");
    const headers = { "content-type": "application/json", "x-signature": hmacHex("test-webhook-secret", payload) };
    const res = await server.inject({ method: "POST", url: "/api/webhooks/sale", payload, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("recorded");
    expect((await server.inject({ method: "POST", url: "/api/webhooks/sale", payload, headers })).json().status).toBe("duplicate");
    expect(app.products.get(product.id).quantity_sold).toBe(1);
  });

  it("rejects a missing, wrong or mismatched signature and records nothing", async () => {
    const product = app.products.create({}, { type: "user", id: "t", role: "owner" }, "manual");
    const payload = body(product.sku, "WH-2");
    const tampered = payload.replace("1800", "1");
    const cases = [
      {},
      { "x-signature": "0".repeat(64) },
      { "x-signature": hmacHex("wrong-secret", payload) },
    ];
    for (const extra of cases) {
      const res = await server.inject({ method: "POST", url: "/api/webhooks/sale", payload, headers: { "content-type": "application/json", ...extra } });
      expect(res.statusCode).toBe(401);
    }
    const res = await server.inject({ method: "POST", url: "/api/webhooks/sale", payload: tampered, headers: { "content-type": "application/json", "x-signature": hmacHex("test-webhook-secret", payload) } });
    expect(res.statusCode).toBe(401);
    expect(app.products.get(product.id).quantity_sold).toBe(0);
    expect(app.audit.list({ action: "webhook.rejected" }).length).toBeGreaterThanOrEqual(4);
  });

  it("is refused entirely when no webhook secret is configured", async () => {
    const bare = makeApp({ saleWebhookSecret: undefined });
    const s = await buildServer(bare);
    const payload = body("RS-1", "WH-3");
    const res = await s.inject({ method: "POST", url: "/api/webhooks/sale", payload, headers: { "content-type": "application/json", "x-signature": hmacHex("", payload) } });
    expect(res.statusCode).toBe(401);
  });
});

describe("the operator workflow over the API", () => {
  it("process → review queue → approve → publish → simulated sale → cross-delist → report", async () => {
    const created = await call("manager", "POST", "/api/products", { brand: "Nike", model: "Club Tee", category: "t-shirt", department: "menswear", size: "M", color: "black", condition: "good", acquisition_cost_cents: 700 });
    const id = created.json().product.id;
    const upload = multipart({}, [{ field: "files", filename: "p.jpg", type: "image/jpeg", data: await photo(41) }]);
    expect((await call("manager", "POST", `/api/products/${id}/images`, upload.payload, upload.headers)).json().added).toBe(1);
    await app.queue.drain({ ignoreSchedule: true });
    await app.pipeline.process(id);

    const review = (await call("manager", "GET", "/api/review")).json();
    const mine = review.approvals.filter((a: { product_id: string }) => a.product_id === id);
    expect(mine).toHaveLength(3);
    for (const a of mine) expect((await call("manager", "POST", `/api/approvals/${a.id}/decide`, { decision: "approve" })).statusCode).toBe(200);
    await app.queue.drain({ ignoreSchedule: true });

    const detail = (await call("viewer", "GET", `/api/products/${id}`)).json();
    expect(detail.listings.map((l: { status: string }) => l.status)).toEqual(["published", "published", "published"]);
    expect(detail.listings.every((l: { simulated: boolean }) => l.simulated)).toBe(true);
    expect(detail.pricing.simulatedData).toBe(true);

    const depop = detail.listings.find((l: { marketplace: string }) => l.marketplace === "depop");
    expect((await call("manager", "POST", "/api/simulate/sale", { listingId: depop.id })).statusCode).toBe(200);
    await app.queue.drain({ ignoreSchedule: true });
    const after = (await call("viewer", "GET", `/api/products/${id}`)).json();
    expect(after.product.status).toBe("sold");
    expect(after.listings.map((l: { marketplace: string; status: string }) => `${l.marketplace}:${l.status}`).sort()).toEqual(["depop:sold", "ebay:delisted", "mercari:delisted"]);

    const report = (await call("manager", "POST", "/api/reports", { days: 7, includeSimulated: true })).json().report;
    expect(report.includesSimulatedData).toBe(true);
    expect(report.period.orders).toBeGreaterThanOrEqual(1);
    const real = (await call("viewer", "GET", "/api/analytics")).json();
    expect(real.overview.simulated.orders).toBeGreaterThanOrEqual(1);
    expect(SIM).toHaveLength(3);
  });

  it("a simulated sale is refused for a listing that is not on a simulated marketplace", async () => {
    app.connections.setMode("ebay", "assisted");
    const listing = app.listings.list({ marketplace: "ebay" })[0]!;
    const res = await call("manager", "POST", "/api/simulate/sale", { listingId: listing.id });
    expect(res.statusCode).toBe(400);
    app.connections.setMode("ebay", "simulated");
  });
});
