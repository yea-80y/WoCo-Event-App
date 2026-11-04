/**
 * Allocated seating, S3 (docs/SEATING.md; S3 consult Q4 + Q6):
 * - the live holds route lists WHICH seats for a series registered seated: active
 *   holds plus seats paid in the last RESERVATION_TTL_MS (a lagging RPC replica may
 *   not show the mint yet), never a long-paid or expired hold, never another series';
 *   seats only, cacheable for a few seconds;
 * - a malformed persisted seat list loses the list, never the hold;
 * - the quantity sale paths refuse a seated series until seated holds ship (S4).
 *
 * The registry and the store resolve `.data` against the working directory when first
 * imported, so everything is imported after `before` moves into a temp dir.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const CHAIN = 42161;
const LEDGER2 = "0x" + "2e".repeat(20);
const SEATED = { event: "e0000000-0000-4000-8000-0000000005e1", series: "s0000000-0000-4000-8000-0000000005e1" };
const GENERAL = { event: "e0000000-0000-4000-8000-0000000005e2", series: "s0000000-0000-4000-8000-0000000005e2" };
const DIGEST = `0x${"57".repeat(32)}`;

const min = 60_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const hold = (id: string, ids: { event: string; series: string }, quantity: number, extra: Record<string, unknown>) => ({
  id, eventId: ids.event, seriesId: ids.series, quantity, createdAt: at(-1 * min), expiresAt: at(9 * min), ...extra,
});

let dir: string;
let cwd: string;
let app: Hono;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;

before(async () => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-seating-holds-"));
  mkdirSync(join(dir, ".data"));
  writeFileSync(join(dir, ".data", "onchain-events.json"), JSON.stringify({
    [`${SEATED.event}|${SEATED.series}`]: { onChainEventId: "0x" + "01".repeat(32), chainId: CHAIN, contract: LEDGER2, version: "ledger2", seated: true, planDigest: DIGEST },
    [`${GENERAL.event}|${GENERAL.series}`]: { onChainEventId: "0x" + "02".repeat(32), chainId: CHAIN, contract: LEDGER2, version: "ledger2" },
  }));
  writeFileSync(join(dir, ".data", "reservations.json"), JSON.stringify([
    hold("active", SEATED, 2, { seats: [4, 9] }),
    hold("paid-just-now", SEATED, 1, { seats: [20], consumedAt: at(-2 * min), expiresAt: at(-1 * min) }),
    hold("paid-long-ago", SEATED, 1, { seats: [30], consumedAt: at(-15 * min), expiresAt: at(-14 * min) }),
    hold("expired", SEATED, 1, { seats: [40], expiresAt: at(-1 * min) }),
    hold("malformed", SEATED, 2, { seats: [7, 7] }),
    hold("count-only", SEATED, 3, {}),
    hold("other-series", GENERAL, 1, { seats: [4] }),
  ]));
  process.chdir(dir);
  process.env.WOCO_EVENT_CHAIN_ID ??= String(CHAIN);
  store = await import("../src/lib/event/reservation-store.js");
  const { reservations } = await import("../src/routes/reservations.js");
  app = new Hono();
  app.route("/api/events", reservations);
});

after(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

test("seats held: live holds and seats paid in the last ten minutes, nothing else", () => {
  assert.deepEqual(store.heldSeatsFor(SEATED.event, SEATED.series), [4, 9, 20]);
  assert.deepEqual(store.heldSeatsFor(GENERAL.event, GENERAL.series), [4]);
  // The malformed list is gone; the hold still counts by quantity.
  assert.equal(store.getReservation("malformed").seats, undefined);
  assert.equal(store.heldFor(SEATED.event, SEATED.series), 2 + 2 + 3);
});

test("the holds route lists seats only for a seated registration, the same for every caller, cacheable briefly", async () => {
  const seated = await app.request(`/api/events/${SEATED.event}/series/${SEATED.series}/held`);
  assert.equal(seated.headers.get("Cache-Control"), "public, max-age=5, s-maxage=5");
  const body = await seated.json();
  assert.deepEqual(body, { ok: true, data: { held: 7, seats: [4, 9, 20] } });
  const general = await (await app.request(`/api/events/${GENERAL.event}/series/${GENERAL.series}/held`)).json();
  assert.deepEqual(general, { ok: true, data: { held: 1 } }, "a general series never lists seats");
  // Nothing about the holders.
  assert.ok(!JSON.stringify(body).match(/expires|client|ip|id/i));
});

test("a quantity hold on a seated series is refused before anything is read", async () => {
  const resp = await app.request(`/api/events/${SEATED.event}/series/${SEATED.series}/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ quantity: 1 }),
  });
  assert.equal(resp.status, 409);
  assert.deepEqual(await resp.json(), { ok: false, error: "Tickets for this event are not currently on sale" });
});

test("the cacheable holds route answers CORS '*', every other route reflects the caller's origin", async () => {
  const { corsOrigin } = await import("../src/lib/http/cors.js");
  const at = (path: string) => ({ req: { path } });
  assert.equal(corsOrigin("https://site-a.example", at(`/api/events/${SEATED.event}/series/${SEATED.series}/held`)), "*");
  assert.equal(corsOrigin("https://site-a.example", at(`/api/events/${SEATED.event}/series/${SEATED.series}/reserve`)), "https://site-a.example");
  assert.equal(corsOrigin("https://site-a.example", at(`/api/events/${SEATED.event}/series/${SEATED.series}/held/x`)), "https://site-a.example");
  assert.equal(corsOrigin("https://site-a.example"), "https://site-a.example");
  assert.equal(corsOrigin(""), "*");
});

test("the agent rail refuses a seated series in the one resolver its quote and buy share (wiring)", () => {
  const src = readFileSync(join(cwd, "src/routes/agent.ts"), "utf-8");
  const fn = src.slice(src.indexOf("async function resolveSeriesPayment("));
  const refusal = fn.indexOf("seatedSaleRefusal(eventId, seriesId)");
  assert.ok(refusal > 0 && refusal < fn.indexOf("await getEvent(eventId)"), "refused before any read");
  assert.equal((src.match(/resolveSeriesPayment\(eventId, seriesId\)/g) ?? []).length, 2, "quote and buy both resolve through it");
});

test("create-checkout applies the same refusal (wiring: the quantity checkout cannot sell a seated series)", () => {
  const src = readFileSync(join(cwd, "src/routes/stripe.ts"), "utf-8");
  const gate = src.indexOf("const sale = saleContractFor(eventId, seriesId);");
  const refusal = src.indexOf("seatedSaleRefusal(eventId, seriesId)");
  const mint = src.indexOf("const mintTarget = sale.contract;");
  assert.ok(gate > 0 && refusal > gate && refusal < mint, "refused right after the contract gate, before any chain read");
  assert.match(src.slice(refusal, mint), /return c\.json\(seatedRefusal\.body, seatedRefusal\.status\)/);
});
