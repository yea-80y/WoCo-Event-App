/**
 * The organiser's orders list read by the browser (#965): slots from the chain,
 * and from the server only what it alone knows. Sealed orders come later, from
 * the background queue (detail-queue.test.ts), under the `coverage` read here.
 *
 * The rule that matters most: the server's erasure answer for exactly the roots
 * read is the ONLY thing that makes a root fetchable - an erased root never is,
 * and a row whose root is erased never carries a box, whatever the queue holds.
 *
 * MUTATION: offer an erased or held root as fetchable, attach a box to an erased
 * row, prefer the queue's box over a held one, re-read every slot on a poll, skip
 * the retry of a failed slot, keep rows from a registration that changed, read a
 * ledger the browser cannot, mark an old sale as recent, reuse an epoch, drop
 * no-store from the gateway read, or fall back to the server's full read when a
 * chain read or the answer failed, and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import { BrowserOrders, OrdersStatusUnavailable, RECENT_SALE_MS, orderRoot, type BrowserOrdersDeps, type SlotRead } from "../src/lib/creator/dashboard/browser-orders.js";

const LEDGER: OrdersSeriesLedger = { chainId: 42161, contract: "0x" + "c".repeat(40), version: "ledger", onChainEventId: "0x" + "e".repeat(64) };
const ref = (c: string) => "0x" + c.repeat(64);
const root = (c: string) => c.repeat(64);
const box = (tag: string) => ({ v: 2, enc: `enc-${tag}`, ct: `ct-${tag}` }) as never;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

/** A fake world: chain slots per series, server status; every call logged in order. */
function world(opts: {
  slots: SlotRead[];
  erased?: string[];
  held?: Array<{ root: string; encryptedOrder: never }>;
  ledger?: OrdersSeriesLedger;
  paidAt?: Record<string, string>;
  refund?: OrdersStatus["series"][number]["refund"];
}) {
  const log: string[] = [];
  const state = { ...opts, ledger: opts.ledger ?? LEDGER, failSlots: new Set<number>(), failStatus: false, failNext: false };
  const deps: BrowserOrdersDeps = {
    async status(roots) {
      log.push(`status:${roots.length}`);
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
      if (state.failNext) throw new Error("rpc down");
      return ledgers.map(() => state.slots.length);
    },
    async slots(_l, from, to) {
      log.push(`slots:${from}-${to}`);
      return state.slots.slice(from, to).map((s, i) => (state.failSlots.has(from + i) ? null : s));
    },
  };
  return { log, state, deps };
}

const S = (owner: string, c: string): SlotRead => ({ owner, orderRef: ref(c) });
const reader = (deps: BrowserOrdersDeps, canRead = true) => new BrowserOrders(deps, () => canRead, () => NOW);
/** The queue's side, faked: it holds a box for every root it is asked about. */
const queueHasAll = (r: string) => box(`q-${r.slice(0, 2)}`);

test("rows and coverage come from the answer for exactly the roots read", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")] });
  const read = (await reader(w.deps).loadRows())!;
  assert.deepEqual(w.log, ["status:0", "status-answered", "next", "slots:0-2", "status:2", "status-answered"]);
  assert.deepEqual([...read.coverage.fetchable].sort(), [root("a"), root("b")]);
  assert.ok(read.rows.orders.every((o) => o.encryptedOrder === undefined), "no box before the queue fetches one");
});

test("an answer that fails shows nothing new", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const r = reader(w.deps);
  await r.loadRows();
  w.state.slots.push(S("0x2", "b"));
  w.state.failStatus = true;
  await assert.rejects(r.loadRows(), OrdersStatusUnavailable, "tagged, so the dashboard does not ask the server's full read");
});

test("an erased root is never fetchable, and its row never carries a box", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")], erased: [root("b")] });
  const r = reader(w.deps);
  const read = (await r.loadRows())!;
  assert.ok(!read.coverage.fetchable.has(root("b")));
  const out = r.build(queueHasAll);
  const b = out.orders.find((o) => o.edition === 2)!;
  assert.equal(b.erased, true);
  assert.equal(b.encryptedOrder, undefined, "even when the queue still holds one");
  assert.deepEqual(out.orders.find((o) => o.edition === 1)!.encryptedOrder, box("q-aa"));
});

test("an answer that erases a root later takes it out of coverage and off its row", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const r = reader(w.deps);
  assert.ok((await r.loadRows())!.coverage.fetchable.has(root("a")));
  w.state.erased = [root("a")];
  const read = (await r.loadRows())!;
  assert.ok(!read.coverage.fetchable.has(root("a")));
  assert.equal(r.build(queueHasAll).orders[0].encryptedOrder, undefined);
});

test("a paid order not yet on Swarm comes from the answer: never fetchable, never the queue's box", async () => {
  const w = world({ slots: [S("0x1", "a")], held: [{ root: root("a"), encryptedOrder: box("held") }] });
  const r = reader(w.deps);
  const read = (await r.loadRows())!;
  assert.equal(read.coverage.fetchable.size, 0);
  assert.deepEqual(read.rows.orders[0].encryptedOrder, box("held"));
  assert.deepEqual(r.build(queueHasAll).orders[0].encryptedOrder, box("held"));
});

test("a held box that is also erased is not shown", async () => {
  const w = world({ slots: [S("0x1", "a")], erased: [root("a")], held: [{ root: root("a"), encryptedOrder: box("held") }] });
  const r = reader(w.deps);
  await r.loadRows();
  assert.equal(r.build(queueHasAll).orders[0].encryptedOrder, undefined);
});

test("a poll reads only new slots and asks for the registration once", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")] });
  const r = reader(w.deps);
  await r.loadRows();
  w.state.slots.push(S("0x3", "c"));
  w.log.length = 0;
  const read = (await r.loadRows())!;
  assert.deepEqual(w.log.filter((l) => l.startsWith("slots:")), ["slots:2-3"]);
  assert.equal(w.log.filter((l) => l.startsWith("status:")).length, 1, "the registration is not asked for again");
  assert.deepEqual(w.log.filter((l) => l.startsWith("status:")), ["status:3"], "the answer covers every root shown");
  assert.deepEqual(read.rows.orders.map((o) => o.edition), [1, 2, 3]);
});

test("a slot whose read failed is not shown, and is read again on the next load", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b"), S("0x3", "c")] });
  w.state.failSlots.add(1);
  const r = reader(w.deps);
  assert.deepEqual((await r.loadRows())!.rows.orders.map((o) => o.edition), [1, 3]);
  w.state.failSlots.clear();
  w.log.length = 0;
  assert.deepEqual((await r.loadRows())!.rows.orders.map((o) => o.edition), [1, 2, 3]);
  assert.ok(w.log.includes("slots:1-3"));
});

test("rows read from a registration that changed are dropped and read again", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const r = reader(w.deps);
  await r.loadRows();
  w.state.ledger = { ...LEDGER, onChainEventId: "0x" + "f".repeat(64) };
  w.log.length = 0;
  assert.deepEqual((await r.loadRows())!.rows.orders, [], "the answer moved the registration: no rows from the old one");
  assert.equal((await r.loadRows())!.rows.orders.length, 1);
  assert.ok(w.log.includes("slots:0-1"), "the new registration's slots are read from 0");
});

test("a ledger the browser cannot read hands the list back to the server", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const r = reader(w.deps, false);
  assert.equal(await r.loadRows(), null);
  assert.equal(await r.count(), null);
  assert.ok(!w.log.some((l) => l.startsWith("slots:")));
});

test("rows carry paid time, refund, owner and edition; an empty ref is not fetchable", async () => {
  const w = world({
    slots: [S("0xaaa", "a"), { owner: "0xbbb", orderRef: ref("0") }],
    paidAt: { "0": "2026-10-31T10:00:00.000Z" },
    refund: { "1": "refunded" },
  });
  const read = (await reader(w.deps).loadRows())!;
  assert.deepEqual(read.rows.orders, [
    { seriesId: "s1", seriesName: "Standing", edition: 1, claimerAddress: "0xaaa", claimedAt: "2026-10-31T10:00:00.000Z", via: "stripe" },
    { seriesId: "s1", seriesName: "Standing", edition: 2, refund: "refunded", claimerAddress: "0xbbb", claimedAt: "", via: "stripe" },
  ]);
  assert.deepEqual([...read.coverage.fetchable], [root("a")]);
});

test("a sale paid in the last few minutes is recent; an older one is not", async () => {
  const w = world({
    slots: [S("0x1", "a"), S("0x2", "b"), S("0x3", "c")],
    paidAt: { "0": new Date(NOW - 60_000).toISOString(), "1": new Date(NOW - RECENT_SALE_MS - 1).toISOString() },
  });
  const read = (await reader(w.deps).loadRows())!;
  assert.deepEqual([...read.coverage.recent], [root("a")], "no paid time = not known to be recent");
});

test("every answer is a new, later epoch, stamped with the reader's clock", async () => {
  const w = world({ slots: [S("0x1", "a")] });
  const r = reader(w.deps);
  const one = (await r.loadRows())!.coverage;
  const two = (await r.loadRows())!.coverage;
  assert.ok(two.epoch > one.epoch);
  assert.equal(two.at, NOW);
});

test("rootOf names the row's order root; none before a read", async () => {
  const w = world({ slots: [S("0x1", "a"), { owner: "0x2", orderRef: ref("0") }] });
  const r = reader(w.deps);
  assert.equal(r.rootOf({ seriesId: "s1", edition: 1 }), null);
  await r.loadRows();
  assert.equal(r.rootOf({ seriesId: "s1", edition: 1 }), root("a"));
  assert.equal(r.rootOf({ seriesId: "s1", edition: 2 }), null);
});

test("the count comes from the chain once the registrations are known", async () => {
  const w = world({ slots: [S("0x1", "a"), S("0x2", "b")] });
  const r = reader(w.deps);
  assert.equal(await r.count(), null, "before the first answer: ask the server");
  await r.loadRows();
  assert.equal(await r.count(), 2);
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

test("every live multicall is one eth_call: viem's 1 KB split is off (Fable sign-off S4)", () => {
  const calls = LIVE.match(/client\.multicall\(\{[^}]*?allowFailure/g) ?? [];
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /batchSize: 0,/);
});

const DASH = readFileSync(new URL("../src/lib/creator/dashboard/Dashboard.svelte", import.meta.url), "utf-8");

test("only a ledger the browser cannot read reaches the server's full read (Fable consult Q7)", () => {
  const read = DASH.slice(DASH.indexOf("async function readOrders"), DASH.indexOf("async function refreshOrders"));
  const caught = read.slice(read.indexOf("} catch (err) {"));
  assert.match(caught, /^\} catch \(err\) \{[^}]*return null;\s*\}\s*const data = \(await getEventOrdersSWR/, "a failed chain read or answer returns before the full read");
  assert.equal(read.match(/getEventOrdersSWR/g)?.length, 1);
});

test("the queue only ever gets coverage from a successful read", () => {
  assert.equal(DASH.match(/queue\.cover\(/g)?.length, 1);
  assert.match(DASH, /const read = await reader\.loadRows\(opts\);\s*if \(read\) \{\s*queue\.cover\(read\.coverage\);/);
});
