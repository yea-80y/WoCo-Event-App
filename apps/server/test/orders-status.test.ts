/**
 * GET /api/events/:id/orders/status (#965): what only the server knows about an
 * event's orders, so the organiser's browser can read slots and sealed orders
 * itself. It must never cost a chain or Swarm read per ticket, must name every
 * erased order of the event (the browser fetches nothing it lists), must serve
 * paid orders not yet on Swarm, and must be as private as `/orders`.
 *
 * MUTATION: read a slot or an order in the module, drop the eventId filter or
 * the erasure check on `erased` or `held`, serve an erased hold, drop the
 * "never registered" rule, or the route's auth or organiser check, and a case
 * below goes red.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.ALLOWED_HOSTS ??= "test.woco.local";
process.env.EMAIL_HASH_SECRET ??= "test-secret-orders-status";
process.chdir(mkdtempSync(join(tmpdir(), "woco-orders-status-test-")));

const { ordersStatus } = await import("../src/lib/event/orders-status.js");
type Deps = import("../src/lib/event/orders-status.js").OrdersStatusDeps;
type OrderRecord = import("../src/lib/attendee-batch/ledger.js").OrderRecord;

const CONTRACT = { chainId: 42161, address: "0xAbC0000000000000000000000000000000000001", version: "ledger" as const };
const ON_CHAIN = "0x" + "AA".repeat(32);
const BOX = { v: 2, enc: "e1", ct: "c1" };

function record(eventId: string, extra: Partial<OrderRecord> = {}): OrderRecord {
  return { batchId: "b", kind: "checkout", eventId, createdAt: "", state: "stored", chunks: [{ address: "x", bucket: 0, slot: 0, ts: "00" }], ...extra } as OrderRecord;
}

function deps(over: Partial<Deps> = {}): Deps {
  return {
    registration: () => CONTRACT,
    paidTimes: () => new Map([[0, "2026-10-31T10:00:00.000Z"], [2, "2026-10-31T11:00:00.000Z"]]),
    refunds: () => new Map([[2, "refunded" as const]]),
    orders: () => [],
    erasureStarted: (_root, rec) => !!rec?.erasedBy || rec?.state === "burned",
    paidHeld: () => [],
    ...over,
  };
}

const EVENT = {
  eventId: "e1",
  title: "Gig",
  series: [
    { seriesId: "s1", name: "Standing", onChainEventId: ON_CHAIN, swarmManifestRef: "11".repeat(32) },
    { seriesId: "s2", name: "Not registered", onChainEventId: ON_CHAIN },
    { seriesId: "s3", name: "No id", swarmManifestRef: "22".repeat(32) },
  ],
};

test("a registered series names its registration, paid times and refunds by slot", () => {
  const out = ordersStatus(EVENT, deps());
  assert.deepEqual(out.series[0], {
    seriesId: "s1",
    seriesName: "Standing",
    ledger: { chainId: 42161, contract: CONTRACT.address.toLowerCase(), version: "ledger", onChainEventId: ON_CHAIN.toLowerCase() },
    paidAt: { "0": "2026-10-31T10:00:00.000Z", "2": "2026-10-31T11:00:00.000Z" },
    refund: { "2": "refunded" },
  });
});

test("a series that never finished registering has no ledger and no orders", () => {
  const out = ordersStatus(EVENT, deps());
  for (const s of out.series.slice(1)) assert.deepEqual({ ledger: s.ledger, paidAt: s.paidAt, refund: s.refund }, { ledger: null, paidAt: {}, refund: {} });
  const none = ordersStatus(EVENT, deps({ registration: () => undefined }));
  assert.equal(none.series[0].ledger, null);
});

test("erased lists this event's orders whose erasure has started, and only those", () => {
  const out = ordersStatus(EVENT, deps({
    orders: () => [
      { root: "r-burned", record: record("e1", { state: "burned" }) },
      { root: "r-starting", record: record("e1", { erasedBy: "request" }) },
      { root: "r-live", record: record("e1") },
      { root: "r-other-event", record: record("e2", { state: "burned" }) },
    ],
  }));
  assert.deepEqual(out.erased.sort(), ["r-burned", "r-starting"]);
});

test("held serves this event's paid unstored boxes, never an erased one or another event's", () => {
  const out = ordersStatus(EVENT, deps({
    paidHeld: () => [
      { root: "h-ok", json: JSON.stringify(BOX), eventId: "e1" },
      { root: "h-erased", json: JSON.stringify(BOX), eventId: "e1" },
      { root: "h-other", json: JSON.stringify(BOX), eventId: "e2" },
      { root: "h-bad", json: "{not json", eventId: "e1" },
    ],
    erasureStarted: (root) => root === "h-erased",
  }));
  assert.deepEqual(out.held, [{ root: "h-ok", encryptedOrder: BOX }]);
});

test("the module reads no slot, no order blob and no event: nothing per ticket", () => {
  const src = readFileSync(new URL("../src/lib/event/orders-status.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /getSlotDataAt|getOnChainEventAt|downloadFromBytes|getHeldOrder|fetch\(/);
});

test("the live erasure rule is the gateway's: erased, or an erasure has started", () => {
  const src = readFileSync(new URL("../src/lib/event/orders-status.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ erasureStarted \} from "\.\.\/attendee-batch\/order-gateway\.js";/);
  assert.match(src, /orders: listOrders,\s*erasureStarted,\s*paidHeld: paidUnstored,/);
});

let app: Hono;
before(async () => {
  const { orders } = await import("../src/routes/orders.js");
  app = new Hono();
  app.route("/api/events", orders);
});

test("as private as /orders: signed in, and the event's own organiser", async () => {
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('orders.get("/:id/orders/status"'), src.indexOf('orders.get("/:id/orders",'));
  assert.match(route, /orders\.get\("\/:id\/orders\/status", requireAuth,/);
  assert.match(route, /const event = await getEventForOwner\(eventId, parentAddress\);/);
  assert.match(route, /if \(event\.creatorAddress\.toLowerCase\(\) !== parentAddress\.toLowerCase\(\)\) \{\s*return c\.json\(\{ ok: false, error: "Only the event organizer can view orders" \}, 403\);/);
  assert.equal((await app.request("/api/events/some-event/orders/status")).status, 401);
});
