/**
 * The organiser's orders list read by the browser (#965): slots from the chain,
 * sealed orders from our gateway, and from the server only what it alone knows.
 *
 * The rule that matters most: the server's erasure answer for exactly the roots
 * read comes BEFORE any sealed order is fetched, an erased one is never fetched
 * or shown, and a box fetched earlier is dropped once its root is erased.
 *
 * MUTATION: fetch before the answer, fetch or show an erased root, keep an
 * erased box, ignore held boxes, re-read every slot on a poll, skip the retry of
 * a failed slot, keep rows from a registration that changed, read a ledger the
 * browser cannot, or drop no-store from the gateway read, and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import { BrowserOrders, orderRoot, type BrowserOrdersDeps, type SlotRead } from "../src/lib/creator/dashboard/browser-orders.js";

const LEDGER: OrdersSeriesLedger = { chainId: 42161, contract: "0x" + "c".repeat(40), version: "ledger", onChainEventId: "0x" + "e".repeat(64) };
const ref = (c: string) => "0x" + c.repeat(64);
const root = (c: string) => c.repeat(64);
const box = (tag: string) => ({ v: 2, enc: `enc-${tag}`, ct: `ct-${tag}` }) as never;

/** A fake world: chain slots per series, gateway boxes, server status; every call logged in order. */
function world(opts: {
  slots: SlotRead[];
  erased?: string[];
  held?: Array<{ root: string; encryptedOrder: never }>;
  ledger?: OrdersSeriesLedger;
  paidAt?: Record<string, string>;
  refund?: OrdersStatus["series"][number]["refund"];
}) {
  const log: string[] = [];
  const state = { ...opts, ledger: opts.ledger ?? LEDGER, failSlots: new Set<number>(), failStatus: false, failBox: new Set<string>() };
  let statusGate: Promise<void> = Promise.resolve();
  const deps: BrowserOrdersDeps = {
    async status(roots) {
      log.push(`status:${roots.length}`);
      await statusGate;
      if (state.failStatus) throw new Error("status down");
      log.push("status-answered");
      return {
        eventId: "e1",
        eventTitle: "Gig",
        series: [
          { seriesId: "s1", seriesName: "Standing", ledger: state.ledger, paidAt: state.paidAt ?? {}, refund: state.refund ?? {} },
          { seriesId: "s0", seriesName: "Not registered", ledger: null, paidAt: {}, refund: {} },
        ],
        erased: state.erased ?? [],
        held: state.held ?? [],
      };
    },
    async nextSlots(ledgers) {
      log.push("next");
      return ledgers.map(() => state.slots.length);
    },
    async slots(_l, from, to) {
      log.push(`slots:${from}-${to}`);
      return state.slots.slice(from, to).map((s, i) => (state.failSlots.has(from + i) ? null : s));
    },
    async fetchBox(r) {
      log.push(`fetch:${r.slice(0, 2)}`);
      return state.failBox.has(r) ? null : box(r.slice(0, 2));
    },
  };
  return { log, state, deps, gate: (p: Promise<void>) => (statusGate = p) };
}

const S = (owner: string, c: string): SlotRead => ({ owner, orderRef: ref(c) });

test("the erasure answer for the roots read comes before any order is fetched", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")] });
  const reader = new BrowserOrders(w.deps, () => true);
  await reader.load();
  const answered = w.log.lastIndexOf("status-answered");
  const firstFetch = w.log.findIndex((l) => l.startsWith("fetch:"));
  assert.deepEqual(w.log.slice(0, 5), ["status:0", "status-answered", "next", "slots:0-2", "status:2"]);
  assert.ok(firstFetch > answered, "no fetch before the answer for these roots");
});

test("an answer that fails shows nothing new and fetches nothing", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const reader = new BrowserOrders(w.deps, () => true);
  await reader.load();
  w.state.slots.push(S("0x2", "b"));
  w.state.failStatus = true;
  w.log.length = 0;
  await assert.rejects(reader.load());
  assert.ok(!w.log.some((l) => l.startsWith("fetch:")));
});

test("an erased root is never fetched and its row carries no box", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")], erased: [root("b")] });
  const out = (await new BrowserOrders(w.deps, () => true).load())!;
  assert.ok(!w.log.includes("fetch:bb"));
  const b = out.orders.find((o) => o.edition === 2)!;
  assert.equal(b.erased, true);
  assert.equal(b.encryptedOrder, undefined);
  assert.deepEqual(out.orders.find((o) => o.edition === 1)!.encryptedOrder, box("aa"));
});

test("a box fetched earlier is dropped once its root is erased", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const reader = new BrowserOrders(w.deps, () => true);
  assert.ok((await reader.load())!.orders[0].encryptedOrder);
  w.state.erased = [root("a")];
  const out = (await reader.load())!;
  assert.equal(out.orders[0].encryptedOrder, undefined);
  assert.equal(out.orders[0].erased, true);
  w.state.erased = [];
  w.log.length = 0;
  await reader.load();
  assert.ok(w.log.includes("fetch:aa"), "never served from the dropped copy: fetched again");
});

test("a paid order not yet on Swarm comes from the answer, never the gateway", async () => {
  const w = world({ slots: [S("0x1", "a")], held: [{ root: root("a"), encryptedOrder: box("held") }] });
  const out = (await new BrowserOrders(w.deps, () => true).load())!;
  assert.ok(!w.log.some((l) => l.startsWith("fetch:")));
  assert.deepEqual(out.orders[0].encryptedOrder, box("held"));
});

test("a held box that is also erased is not shown", async () => {
  const w = world({ slots: [S("0x1", "a")], erased: [root("a")], held: [{ root: root("a"), encryptedOrder: box("held") }] });
  const out = (await new BrowserOrders(w.deps, () => true).load())!;
  assert.equal(out.orders[0].encryptedOrder, undefined);
});

test("a poll reads only new slots and fetches only new orders", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")] });
  const reader = new BrowserOrders(w.deps, () => true);
  await reader.load();
  w.state.slots.push(S("0x3", "c"));
  w.log.length = 0;
  const out = (await reader.load())!;
  assert.deepEqual(w.log.filter((l) => l.startsWith("slots:") || l.startsWith("fetch:")), ["slots:2-3", "fetch:cc"]);
  assert.equal(w.log.filter((l) => l.startsWith("status:")).length, 1, "the registration is not asked for again");
  assert.deepEqual(out.orders.map((o) => o.edition), [1, 2, 3]);
});

test("a slot whose read failed is not shown, and is read again on the next load", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b"), S("0x3", "c")] });
  w.state.failSlots.add(1);
  const reader = new BrowserOrders(w.deps, () => true);
  assert.deepEqual((await reader.load())!.orders.map((o) => o.edition), [1, 3]);
  w.state.failSlots.clear();
  w.log.length = 0;
  assert.deepEqual((await reader.load())!.orders.map((o) => o.edition), [1, 2, 3]);
  assert.ok(w.log.includes("slots:1-3"));
});

test("a box that failed to arrive shows no details and is fetched again next time", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  w.state.failBox.add(root("a"));
  const reader = new BrowserOrders(w.deps, () => true);
  assert.equal((await reader.load())!.orders[0].encryptedOrder, undefined);
  w.state.failBox.clear();
  assert.ok((await reader.load())!.orders[0].encryptedOrder);
});

test("rows read from a registration that changed are dropped and read again", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const reader = new BrowserOrders(w.deps, () => true);
  await reader.load();
  w.state.ledger = { ...LEDGER, onChainEventId: "0x" + "f".repeat(64) };
  w.log.length = 0;
  assert.deepEqual((await reader.load())!.orders, [], "the answer moved the registration: no rows from the old one");
  assert.equal((await reader.load())!.orders.length, 1);
  assert.ok(w.log.includes("slots:0-1"), "the new registration's slots are read from 0");
});

test("a ledger the browser cannot read hands the list back to the server", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const reader = new BrowserOrders(w.deps, () => false);
  assert.equal(await reader.load(), null);
  assert.equal(await reader.count(), null);
  assert.ok(!w.log.some((l) => l.startsWith("slots:") || l.startsWith("fetch:")));
});

test("rows carry paid time, refund, owner and edition; an empty ref fetches nothing", async () => {
  const w = world({
    slots: [S("0xaaa", "a"), { owner: "0xbbb", orderRef: ref("0") }],
    paidAt: { "0": "2026-10-31T10:00:00.000Z" },
    refund: { "1": "refunded" },
  });
  const out = (await new BrowserOrders(w.deps, () => true).load())!;
  assert.deepEqual(
    out.orders.map(({ encryptedOrder: _b, ...o }) => o),
    [
      { seriesId: "s1", seriesName: "Standing", edition: 1, claimerAddress: "0xaaa", claimedAt: "2026-10-31T10:00:00.000Z", via: "stripe" },
      { seriesId: "s1", seriesName: "Standing", edition: 2, refund: "refunded", claimerAddress: "0xbbb", claimedAt: "", via: "stripe" },
    ],
  );
  assert.equal(w.log.filter((l) => l.startsWith("fetch:")).length, 1);
});

test("the count comes from the chain once the registrations are known", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")] });
  const reader = new BrowserOrders(w.deps, () => true);
  assert.equal(await reader.count(), null, "before the first answer: ask the server");
  await reader.load();
  assert.equal(await reader.count(), 2);
});

test("orderRoot: 64 hex, lowercase, no 0x; an all-zero ref is no order", () => {
  assert.equal(orderRoot("0x" + "AB".repeat(32)), "ab".repeat(32));
  assert.equal(orderRoot("0x" + "0".repeat(64)), null);
  assert.equal(orderRoot("0x1234"), null);
});

const LIVE = readFileSync(new URL("../src/lib/creator/dashboard/browser-orders-live.ts", import.meta.url), "utf-8");

test("the live gateway read is never stored by the browser, and goes to our gateway", () => {
  assert.match(LIVE, /fetch\(`\$\{gateway\}\/bytes\/\$\{root\}`, \{ cache: "no-store",/);
  assert.match(LIVE, /\|\| WOCO_GATEWAY_URL;/);
});

test("the live status call carries the poll's no-sign-in option", () => {
  assert.match(LIVE, /authPost<OrdersStatus>\(`\/api\/events\/\$\{eventId\}\/orders\/status`, \{ roots \}, undefined, opts\)/);
});

test("the live count never reads an unreadable count as zero", () => {
  const next = LIVE.slice(LIVE.indexOf("async function nextSlots"), LIVE.indexOf("async function slots"));
  assert.match(next, /allowFailure: false,/);
});
