/**
 * Opening sealed orders in a worker (#965): order-opener-core.ts (the worker's
 * logic) and order-opener.ts (the page's side), over a fake port.
 *
 * The rules: keys belong to one unlock epoch; a request from another epoch opens
 * nothing; "lock" overwrites the worker's keys and closes it; anything still
 * waiting reads as locked; the page's own key arrays are overwritten at hand-over;
 * a worker that fails to start makes the page open the orders itself, never hang.
 *
 * MUTATION: open under a stale epoch, skip the wipe on lock or re-key, keep a
 * reply from an old epoch, leave a waiting request hanging on lock or on a failed
 * start, or leave the page's copy of a key intact, and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOpenerCore, type OpenerReply, type OpenerRequest } from "../src/lib/creator/dashboard/order-opener-core.js";
import { OrderOpener, type OpenerPort } from "../src/lib/creator/dashboard/order-opener.js";

const ctx = (eventId: string, seriesId: string) => ({ info: "woco/order/v2", aad: `${eventId}/${seriesId}` });
const flush = () => new Promise<void>((r) => setImmediate(r));

function core(open: (keys: Uint8Array[], box: unknown) => Promise<unknown> = async (_k, box) => ({ opened: box })) {
  const replies: OpenerReply[] = [];
  let closed = 0;
  const handle = createOpenerCore({
    open: (keys, box) => open(keys, box),
    context: ctx,
    post: (r) => replies.push(r),
    close: () => void closed++,
  });
  return { handle, replies, closed: () => closed };
}

test("core: opens a batch under the current epoch, one result per job, failures marked", async () => {
  const c = core(async (_k, box) => {
    if (box === "bad") throw new Error("tag");
    return { opened: box };
  });
  await c.handle({ type: "keys", epoch: 1, secretKeys: [new Uint8Array([1, 2])] });
  await c.handle({ type: "open", req: 7, epoch: 1, eventId: "e", jobs: [{ id: 0, seriesId: "s", box: "a" }, { id: 1, seriesId: "s", box: "bad" }] });
  assert.deepEqual(c.replies, [{ type: "opened", req: 7, epoch: 1, results: [{ id: 0, data: { opened: "a" } }, { id: 1 }] }]);
});

test("core: binds each box to the event and the job's series", async () => {
  const seen: unknown[] = [];
  const replies: OpenerReply[] = [];
  const handle = createOpenerCore({
    open: async (_k, _b, c) => void seen.push(c),
    context: ctx,
    post: (r) => replies.push(r),
    close: () => {},
  });
  await handle({ type: "keys", epoch: 1, secretKeys: [new Uint8Array(1)] });
  await handle({ type: "open", req: 1, epoch: 1, eventId: "ev", jobs: [{ id: 0, seriesId: "slot-series", box: {} }] });
  assert.deepEqual(seen, [{ info: "woco/order/v2", aad: "ev/slot-series" }]);
});

test("core: a request from another epoch, or with no keys, opens nothing", async () => {
  let opened = 0;
  const c = core(async () => void opened++);
  await c.handle({ type: "open", req: 1, epoch: 1, eventId: "e", jobs: [{ id: 0, seriesId: "s", box: "a" }] });
  await c.handle({ type: "keys", epoch: 2, secretKeys: [new Uint8Array(1)] });
  await c.handle({ type: "open", req: 2, epoch: 1, eventId: "e", jobs: [{ id: 0, seriesId: "s", box: "a" }] });
  assert.equal(opened, 0);
  assert.deepEqual(c.replies, [{ type: "stale", req: 1 }, { type: "stale", req: 2 }]);
});

test("core: lock overwrites the keys and closes; re-keying overwrites the old ones", async () => {
  const c = core();
  const first = new Uint8Array([9, 9, 9]);
  const second = new Uint8Array([7, 7]);
  await c.handle({ type: "keys", epoch: 1, secretKeys: [first] });
  await c.handle({ type: "keys", epoch: 2, secretKeys: [second] });
  assert.deepEqual([...first], [0, 0, 0], "the replaced generation is overwritten");
  await c.handle({ type: "lock" });
  assert.deepEqual([...second], [0, 0]);
  assert.equal(c.closed(), 1);
  await c.handle({ type: "open", req: 3, epoch: 2, eventId: "e", jobs: [{ id: 0, seriesId: "s", box: "a" }] });
  assert.deepEqual(c.replies, [{ type: "stale", req: 3 }]);
});

test("core: a lock landing mid-batch sends nothing that batch opened", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const c = core(async (_k, box) => {
    await gate;
    return { opened: box };
  });
  await c.handle({ type: "keys", epoch: 1, secretKeys: [new Uint8Array(1)] });
  const running = c.handle({ type: "open", req: 1, epoch: 1, eventId: "e", jobs: [{ id: 0, seriesId: "s", box: "a" }] });
  await c.handle({ type: "lock" });
  release();
  await running;
  assert.deepEqual(c.replies, [{ type: "stale", req: 1 }]);
});

/** A fake Worker that runs the real core in-process, with a switch to fail on start. */
function fakePort(opts: { failOnStart?: boolean; hold?: boolean } = {}) {
  const posted: Array<{ msg: OpenerRequest; transfer?: Transferable[] }> = [];
  let terminated = 0;
  const held: Array<() => void> = [];
  const port: OpenerPort = {
    onmessage: null,
    onerror: null,
    postMessage(msg, transfer) {
      posted.push({ msg, transfer });
      const run = () => void handle(msg);
      if (opts.hold && msg.type === "open") held.push(run);
      else queueMicrotask(run);
    },
    terminate: () => void terminated++,
  };
  const handle = createOpenerCore({
    open: async (_k, box) => ({ opened: box }),
    context: ctx,
    post: (r) => port.onmessage?.({ data: r }),
    close: () => {},
  });
  if (opts.failOnStart) queueMicrotask(() => port.onerror?.(new Event("error")));
  return { port, posted, terminated: () => terminated, release: () => held.splice(0).forEach((f) => f()) };
}

test("page: keys are copied and transferred, and the page's own arrays are overwritten", async () => {
  const f = fakePort();
  const opener = new OrderOpener(() => f.port);
  const key = new Uint8Array([5, 6, 7]);
  opener.unlock(1, [key]);
  assert.deepEqual([...key], [0, 0, 0]);
  const sent = f.posted[0];
  assert.equal(sent.msg.type, "keys");
  const keys = (sent.msg as { secretKeys: Uint8Array[] }).secretKeys;
  assert.deepEqual(sent.transfer, [keys[0].buffer]);
  assert.ok(opener.keyedFor(1));
});

test("page: opens through the worker under the current epoch", async () => {
  const f = fakePort();
  const opener = new OrderOpener(() => f.port);
  opener.unlock(1, [new Uint8Array(1)]);
  const out = await opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }]);
  assert.deepEqual(out, { kind: "opened", results: [{ id: 0, data: { opened: "a" } }] });
});

test("page: lock terminates the worker and every waiting request reads as locked", async () => {
  const f = fakePort({ hold: true });
  const opener = new OrderOpener(() => f.port);
  opener.unlock(1, [new Uint8Array(1)]);
  const waiting = opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }]);
  opener.lock();
  assert.deepEqual(await waiting, { kind: "locked" });
  assert.equal(f.terminated(), 1);
  assert.ok(f.posted.some((p) => p.msg.type === "lock"), "told to overwrite its keys before termination");
  f.release();
  await flush();
  assert.ok(!opener.keyedFor(1));
  assert.deepEqual(await opener.open(1, "e", []), { kind: "locked" }, "nothing opens until a new unlock");
});

test("page: a reply from an older epoch is dropped", async () => {
  const f = fakePort({ hold: true });
  const opener = new OrderOpener(() => f.port);
  opener.unlock(1, [new Uint8Array(1)]);
  const waiting = opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }]);
  opener.unlock(2, [new Uint8Array(1)]);
  await flush();
  f.release();
  assert.deepEqual(await waiting, { kind: "locked" });
});

test("page: an 'opened' reply racing a re-key is dropped by the page itself", async () => {
  const posted: OpenerRequest[] = [];
  const port: OpenerPort = { onmessage: null, onerror: null, postMessage: (m) => void posted.push(m), terminate: () => {} };
  const opener = new OrderOpener(() => port);
  opener.unlock(1, [new Uint8Array(1)]);
  const waiting = opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }]);
  opener.unlock(2, [new Uint8Array(1)]);
  // The worker answered under epoch 1 before it read the new keys.
  port.onmessage!({ data: { type: "opened", req: 1, epoch: 1, results: [{ id: 0, data: { leaked: true } }] } });
  assert.deepEqual(await waiting, { kind: "locked" });
});

test("page: a worker that fails to start answers unavailable, never hangs", async () => {
  const f = fakePort({ failOnStart: true, hold: true });
  const opener = new OrderOpener(() => f.port);
  opener.unlock(1, [new Uint8Array(1)]);
  const waiting = opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }]);
  assert.deepEqual(await waiting, { kind: "unavailable" });
  assert.deepEqual(await opener.open(1, "e", []), { kind: "unavailable" });
});

test("page: a worker that stops answering is given up on, so the page opens the rest (Fable sign-off S5)", async () => {
  const f = fakePort({ hold: true });
  const opener = new OrderOpener(() => f.port, 20);
  opener.unlock(1, [new Uint8Array(1)]);
  assert.deepEqual(await opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }]), { kind: "unavailable" });
  assert.equal(f.terminated(), 1);
  assert.deepEqual(await opener.open(1, "e", []), { kind: "unavailable" }, "and stays given up on");
});

test("page: an answer in time clears its timer (no late give-up)", async () => {
  const f = fakePort();
  const opener = new OrderOpener(() => f.port, 50);
  opener.unlock(1, [new Uint8Array(1)]);
  assert.equal((await opener.open(1, "e", [{ id: 0, seriesId: "s", box: "a" }])).kind, "opened");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(f.terminated(), 0);
  assert.equal((await opener.open(1, "e", [{ id: 0, seriesId: "s", box: "b" }])).kind, "opened");
});

test("page: a worker that cannot even be constructed answers unavailable", async () => {
  const opener = new OrderOpener(() => {
    throw new Error("refused");
  });
  opener.unlock(1, [new Uint8Array(1)]);
  assert.deepEqual(await opener.open(1, "e", []), { kind: "unavailable" });
});

const DASH = readFileSync(new URL("../src/lib/creator/dashboard/Dashboard.svelte", import.meta.url), "utf-8");
const WORKER = readFileSync(new URL("../src/lib/creator/dashboard/order-opener.worker.ts", import.meta.url), "utf-8");

test("Dashboard: opens in the worker, falls back to the page, and a relock stops and terminates it", () => {
  const body = DASH.slice(DASH.indexOf("async function decryptOnce"), DASH.indexOf("// Unlocked - by the panel's tap"));
  assert.match(body, /if \(out\.kind === "unavailable"\) \{\s*\/\/[^\n]*\n\s*useWorker = false;\s*continue;/);
  assert.match(body, /if \(out\.kind === "locked" \|\| epoch !== openEpoch \|\| destroyed\) return;/);
  assert.match(
    body,
    /if \(epoch !== openEpoch \|\| destroyed \|\| auth\.seedAddress !== account\) return;\s*keyedAccount = account;\s*worker\.unlock\(epoch, keys\);/,
    "never keys a worker after a lock, after leaving, or for an account that changed mid-derivation (S4)",
  );
  assert.match(DASH, /openEpoch\+\+;\s*keyedAccount = null;\s*opener\?\.lock\(\);/);
  assert.match(DASH, /\$effect\(\(\) => \(\) => endOpening\(\)\);/, "leaving the page ends the worker and every run (M1)");
});

test("Dashboard: the worker's keys belong to one signed-in account (security review 2026-11-01)", () => {
  assert.match(DASH, /ordersLocked = false;\s*\/\/[^\n]*\n\s*const account = auth\.seedAddress;/, "captured beside the secrets");
  assert.match(DASH, /keyedAccount = account;\s*worker\.unlock\(epoch, keys\);/, "the owner is recorded at hand-over");
  assert.match(
    DASH,
    /const account = auth\.isConnected \? auth\.seedAddress : null;\s*if \(keyedAccount !== null && account !== keyedAccount\) endOpening\(\);/,
    "a sign-out or another account ends the worker, for every login kind",
  );
  const locked = DASH.slice(DASH.indexOf("    if (!secrets) {\n      // No keys"), DASH.indexOf("    ordersLocked = false;"));
  assert.match(locked, /endOpening\(\);/, "no keys on the device now: nothing opened earlier survives");
  assert.match(DASH, /new Worker\(new URL\("\.\/order-opener\.worker\.ts", import\.meta\.url\), \{ type: "module" \}\)/);
});

test("the worker only wires the core: no storage, no channels", () => {
  assert.doesNotMatch(WORKER, /indexedDB|caches\.|localStorage|BroadcastChannel|SharedArrayBuffer/);
  assert.match(WORKER, /createOpenerCore\(/);
});

test("the saved copy of the list stops at ROW_CACHE_MAX rows", () => {
  assert.match(DASH, /if \(data\.orders\.length <= ROW_CACHE_MAX\) \{\s*cacheSet\(cacheKey\.eventOrders\(eventId\), withoutSealedOrders\(data\)/);
  assert.match(DASH, /\} else \{\s*cacheDel\(cacheKey\.eventOrders\(eventId\)\);/);
});
