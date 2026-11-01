/**
 * POST /api/events/:id/orders/status (#965): what only the server knows about an
 * event's orders, so the organiser's browser can read slots and sealed orders
 * itself. It must never cost a chain or Swarm read per ticket, must answer
 * erasure BY ROOT for every order the browser read (the browser fetches nothing
 * it lists), must not answer about another event's orders, must serve paid
 * orders not yet on Swarm, and must be as private as `/orders`.
 *
 * MUTATION: read a slot or an order in the module, answer erasure only through a
 * record's eventId, answer for another event's root, drop the erasure check on
 * `held`, accept malformed or unbounded roots, drop the "never registered" rule,
 * or the route's auth or organiser check, and a case below goes red.
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

const { ordersStatus, parseStatusRoots, MAX_STATUS_ROOTS } = await import("../src/lib/event/orders-status.js");
type Deps = import("../src/lib/event/orders-status.js").OrdersStatusDeps;
type OrderRecord = import("../src/lib/attendee-batch/ledger.js").OrderRecord;

const CONTRACT = { chainId: 42161, address: "0xAbC0000000000000000000000000000000000001", version: "ledger" as const };
const ON_CHAIN = "0x" + "AA".repeat(32);
const BOX = { v: 2, enc: "e1", ct: "c1" };
const R = (c: string) => c.repeat(64);

function record(eventId: string | undefined, extra: Partial<OrderRecord> = {}): OrderRecord {
  return {
    batchId: "b",
    kind: "checkout",
    ...(eventId ? { eventId } : {}),
    createdAt: "",
    state: "stored",
    chunks: [{ address: "x", bucket: 0, slot: 0, ts: "00" }],
    ...extra,
  } as OrderRecord;
}

function deps(over: Partial<Deps> = {}, records: Record<string, OrderRecord> = {}): Deps {
  return {
    registration: () => CONTRACT,
    paidTimes: () => new Map([[0, "2026-10-31T10:00:00.000Z"], [2, "2026-10-31T11:00:00.000Z"]]),
    refunds: () => new Map([[2, "refunded" as const]]),
    orders: () => Object.entries(records).map(([root, rec]) => ({ root, record: rec })),
    record: (root) => records[root] ?? null,
    erasureStarted: (root, rec = records[root] ?? null) => !!rec?.erasedBy || rec?.state === "burned",
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
  const out = ordersStatus(EVENT, [], deps());
  assert.deepEqual(out.series[0], {
    seriesId: "s1",
    seriesName: "Standing",
    ledger: { chainId: 42161, contract: CONTRACT.address.toLowerCase(), version: "ledger", onChainEventId: ON_CHAIN.toLowerCase() },
    paidAt: { "0": "2026-10-31T10:00:00.000Z", "2": "2026-10-31T11:00:00.000Z" },
    refund: { "2": "refunded" },
  });
});

test("a series that never finished registering has no ledger and no orders", () => {
  const out = ordersStatus(EVENT, [], deps());
  for (const s of out.series.slice(1)) assert.deepEqual({ ledger: s.ledger, paidAt: s.paidAt, refund: s.refund }, { ledger: null, paidAt: {}, refund: {} });
  assert.equal(ordersStatus(EVENT, [], deps({ registration: () => undefined })).series[0].ledger, null);
});

test("erasure is answered by root for every root asked, even with no eventId on the record", () => {
  const records = {
    [R("a")]: record(undefined, { state: "burned" }),
    [R("b")]: record("e1", { erasedBy: "request" }),
    [R("c")]: record("e1"),
  };
  const out = ordersStatus(EVENT, [R("a"), R("b"), R("c"), R("d")], deps({}, records));
  assert.deepEqual(out.erased.sort(), [R("a"), R("b")]);
});

test("the event's own erased records are listed even when not asked about", () => {
  const records = { [R("b")]: record("e1", { state: "burned" }), [R("c")]: record("e1") };
  assert.deepEqual(ordersStatus(EVENT, [], deps({}, records)).erased, [R("b")]);
});

test("another event's order is never answered, asked or not", () => {
  const records = { [R("e")]: record("e2", { state: "burned" }) };
  assert.deepEqual(ordersStatus(EVENT, [R("e")], deps({}, records)).erased, []);
});

test("held serves this event's paid unstored boxes, never an erased one or another event's", () => {
  const out = ordersStatus(EVENT, [], deps({
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

test("roots: 64-hex only, normalised, deduplicated, bounded", () => {
  assert.deepEqual(parseStatusRoots(undefined), []);
  assert.deepEqual(parseStatusRoots(["0x" + "AB".repeat(32), "ab".repeat(32)]), ["ab".repeat(32)]);
  assert.equal(parseStatusRoots("ab".repeat(32)), null);
  assert.equal(parseStatusRoots(["zz".repeat(32)]), null);
  assert.equal(parseStatusRoots([42]), null);
  assert.equal(parseStatusRoots(Array.from({ length: MAX_STATUS_ROOTS + 1 }, () => "ab".repeat(32))), null);
});

test("the module reads no slot, no order blob and no event: nothing per ticket", () => {
  const src = readFileSync(new URL("../src/lib/event/orders-status.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /getSlotDataAt|getOnChainEventAt|downloadFromBytes|getHeldOrder|fetch\(/);
});

test("the live erasure rule is the gateway's: erased, or an erasure has started", () => {
  const src = readFileSync(new URL("../src/lib/event/orders-status.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ erasureStarted \} from "\.\.\/attendee-batch\/order-gateway\.js";/);
  assert.match(src, /orders: listOrders,\s*record: getOrderRecord,\s*erasureStarted,\s*paidHeld: paidUnstored,/);
});

let app: Hono;
before(async () => {
  const { orders } = await import("../src/routes/orders.js");
  app = new Hono();
  app.route("/api/events", orders);
});

test("as private as /orders: signed in, and the event's own organiser", async () => {
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('orders.post("/:id/orders/status"'), src.indexOf('orders.get("/:id/orders",'));
  assert.match(route, /orders\.post\("\/:id\/orders\/status", requireAuth,/);
  assert.match(route, /const event = await getEventForOwner\(eventId, parentAddress\);/);
  assert.match(route, /if \(event\.creatorAddress\.toLowerCase\(\) !== parentAddress\.toLowerCase\(\)\) \{\s*return c\.json\(\{ ok: false, error: "Only the event organizer can view orders" \}, 403\);/);
  assert.match(route, /if \(!roots\) return c\.json\(\{ ok: false, error: `roots must be up to \$\{MAX_STATUS_ROOTS\} order references` \}, 400\);/);
  const res = await app.request("/api/events/some-event/orders/status", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  assert.equal(res.status, 401);
});

test("an unreadable attendee ledger answers nothing, on /orders/status and /orders alike", () => {
  // It would read as "nothing erased" and hand out every box (Fable sign-off S2).
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  for (const opener of ['orders.post("/:id/orders/status"', 'orders.get("/:id/orders",']) {
    const at = src.indexOf(opener);
    const guard = src.indexOf("if (!ledgerReadable()) return c.json({ ok: false, error: ATTENDEE_LEDGER_UNAVAILABLE }, 503);", at);
    const firstRead = src.indexOf("await getEventForOwner(", at);
    assert.ok(at >= 0 && guard > at && guard < firstRead, `${opener}: the guard comes before any read`);
  }
});

test("/orders (the browser's fallback) uses the same erasure rule as the status answer", () => {
  const src = readFileSync(new URL("../src/routes/orders.ts", import.meta.url), "utf8");
  assert.match(src, /const erased = swarmHex \? erasureStarted\(swarmHex\) : false;/);
  assert.doesNotMatch(src, /isOrderErased\(/);
});
