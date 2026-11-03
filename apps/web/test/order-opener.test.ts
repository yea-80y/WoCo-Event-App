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
import {
  OrderOpener,
  OrderOpenerPool,
  POOL_MAX,
  poolWidth,
  type OpenerPort,
} from "../src/lib/creator/dashboard/order-opener.js";

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
      // As a real worker port does: the message is COPIED, and a copy that cannot be
      // made throws here, at the caller. A fake that passed it by reference let a
      // reactive proxy through every test while every real dashboard failed (2026-11-02).
      const copy = structuredClone(msg);
      posted.push({ msg, transfer });
      const run = () => void handle(copy);
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

test("page: a job the browser cannot copy to the worker opens on the page - never a silent stop", async () => {
  const f = fakePort();
  const opener = new OrderOpener(() => f.port);
  opener.unlock(1, [new Uint8Array(1)]);
  // What a Svelte $state row hands over: a proxy, which structured clone refuses.
  const reactiveBox = new Proxy({ v: 2, enc: "e", ct: "c" }, {});
  const quiet = console.error;
  console.error = () => {};
  try {
    const out = await opener.open(1, "e", [{ id: 0, seriesId: "s", box: reactiveBox }]);
    assert.deepEqual(out, { kind: "unavailable" }, "resolves, so the page opens them itself");
  } finally {
    console.error = quiet;
  }
  assert.equal(f.terminated(), 1);
  assert.deepEqual(await opener.open(1, "e", [{ id: 0, seriesId: "s", box: { v: 2 } }]), { kind: "unavailable" });
});

test("Dashboard: boxes go to the worker as plain snapshots, and a failed run is never swallowed", () => {
  assert.match(DASH, /box: \$state\.snapshot\(order\.encryptedOrder\)/, "the rows are reactive proxies (2026-11-02)");
  // The queue reports every throw (RunQueue, tested in dashboard-live-orders.test.ts) - to the console here.
  assert.match(DASH, /new RunQueue\(\(err\) => console\.error\("\[dashboard\] opening orders failed:", err\)\)/);
  assert.doesNotMatch(DASH, /new RunQueue\(\(\) => \{\}\)/);
});

test("the saved copy of the list stops at ROW_CACHE_MAX rows", () => {
  assert.match(DASH, /if \(data\.orders\.length <= ROW_CACHE_MAX\) \{\s*cacheSet\(cacheKey\.eventOrders\(eventId\), withoutSealedOrders\(data\)/);
  assert.match(DASH, /\} else \{\s*cacheDel\(cacheKey\.eventOrders\(eventId\)\);/);
});

// ── the pool: several workers for a long list (#1061 fix 2) ─────────────────
//
// MUTATION: hand every worker the same key arrays, keep a step with a locked share,
// drop a gone worker's share, spawn past POOL_MAX, or start more than one worker for
// a small list, and a case below goes red.

/** Every worker the pool starts, in order. */
function spawner(make: () => ReturnType<typeof fakePort> = () => fakePort()) {
  const made: Array<ReturnType<typeof fakePort>> = [];
  return {
    made,
    spawn: () => {
      const f = make();
      made.push(f);
      return f.port;
    },
  };
}
const jobs = (n: number) => Array.from({ length: n }, (_, id) => ({ id, seriesId: "s", box: `b${id}` }));
const opensOf = (f: ReturnType<typeof fakePort>) =>
  f.posted.filter((p) => p.msg.type === "open").map((p) => (p.msg as { jobs: unknown[] }).jobs.length);

test("poolWidth: one worker per 1,000 orders, one core left for the page, never past POOL_MAX", () => {
  assert.equal(POOL_MAX, 4);
  assert.equal(poolWidth(0, 8), 1);
  assert.equal(poolWidth(500, 8), 1, "a small event never starts a second worker");
  assert.equal(poolWidth(1_200, 8), 2);
  assert.equal(poolWidth(24_000, 8), 4);
  assert.equal(poolWidth(24_000, 4), 3);
  assert.equal(poolWidth(24_000, 2), 1);
  assert.equal(poolWidth(24_000, 1), 1);
  assert.equal(poolWidth(24_000, undefined), 1, "unknown cores: one");
});

test("pool: nothing opens before an unlock", async () => {
  const s = spawner();
  const pool = new OrderOpenerPool(s.spawn, () => 3);
  assert.equal(pool.keyedFor(1), false);
  assert.equal(pool.width, 0);
  assert.deepEqual(await pool.open(1, "e", jobs(2)), { kind: "locked" });
  assert.equal(s.made.length, 0, "no worker starts before keys");
});

test("pool: each worker gets its OWN transferred copy of the keys; the caller's arrays are overwritten", () => {
  const s = spawner();
  const pool = new OrderOpenerPool(s.spawn, () => 3);
  const key = new Uint8Array([5, 6, 7]);
  pool.unlock(1, [key]);
  assert.deepEqual([...key], [0, 0, 0]);
  assert.equal(s.made.length, 3);
  const sent = s.made.map((f) => {
    const p = f.posted.find((x) => x.msg.type === "keys")!;
    const k = (p.msg as { secretKeys: Uint8Array[] }).secretKeys[0];
    assert.deepEqual(p.transfer, [k.buffer], "transferred, not copied");
    return k;
  });
  for (const k of sent) assert.deepEqual([...k], [5, 6, 7], "every worker got the key, not a wiped one");
  assert.equal(new Set(sent.map((k) => k.buffer)).size, 3, "three separate buffers");
  assert.ok(pool.keyedFor(1));
  assert.equal(pool.width, 3);
});

test("pool: never more than POOL_MAX workers, and a small list gets exactly one", () => {
  const big = spawner();
  new OrderOpenerPool(big.spawn, () => 50).unlock(1, [new Uint8Array(1)]);
  assert.equal(big.made.length, POOL_MAX);
  const small = spawner();
  new OrderOpenerPool(small.spawn, () => 1).unlock(1, [new Uint8Array(1)]);
  assert.equal(small.made.length, 1);
});

test("pool: a step is split across the workers and answered as one", async () => {
  const s = spawner();
  const pool = new OrderOpenerPool(s.spawn, () => 3);
  pool.unlock(1, [new Uint8Array(1)]);
  const out = await pool.open(1, "e", jobs(7));
  assert.equal(out.kind, "opened");
  const ids = (out as { results: Array<{ id: number; data?: unknown }> }).results.map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(s.made.map(opensOf), [[3], [3], [1]]);
});

test("pool: a lock mid-step makes the whole step locked, and every worker is told and terminated", async () => {
  const s = spawner(() => fakePort({ hold: true }));
  const pool = new OrderOpenerPool(s.spawn, () => 2);
  pool.unlock(1, [new Uint8Array(1)]);
  const waiting = pool.open(1, "e", jobs(4));
  pool.lock();
  assert.deepEqual(await waiting, { kind: "locked" });
  for (const f of s.made) {
    assert.equal(f.terminated(), 1);
    assert.ok(f.posted.some((p) => p.msg.type === "lock"));
  }
  for (const f of s.made) f.release();
  await flush();
  assert.equal(pool.keyedFor(1), false);
  assert.deepEqual(await pool.open(1, "e", jobs(1)), { kind: "locked" });
});

test("pool: one share answered under an old epoch makes the whole step locked", async () => {
  const ports: OpenerPort[] = [];
  const pool = new OrderOpenerPool(() => {
    const port: OpenerPort = { onmessage: null, onerror: null, postMessage: () => {}, terminate: () => {} };
    ports.push(port);
    return port;
  }, () => 2);
  pool.unlock(1, [new Uint8Array(1)]);
  const waiting = pool.open(1, "e", jobs(2));
  pool.unlock(2, [new Uint8Array(1)]);
  // Both answered under epoch 1 before reading the new keys.
  ports[0].onmessage!({ data: { type: "opened", req: 1, epoch: 1, results: [{ id: 0, data: { old: true } }] } });
  ports[1].onmessage!({ data: { type: "opened", req: 1, epoch: 1, results: [{ id: 1, data: { old: true } }] } });
  assert.deepEqual(await waiting, { kind: "locked" });
});

/** A worker that cannot take an "open" message (as a proxy that will not copy made one). */
function refusingPort() {
  const f = fakePort();
  const post = f.port.postMessage.bind(f.port);
  f.port.postMessage = (msg, transfer) => {
    if (msg.type === "open") throw new DOMException("could not be cloned", "DataCloneError");
    post(msg, transfer);
  };
  return f;
}

test("pool: a worker that gives out mid-step hands its share to the others; nothing is lost", async () => {
  let n = 0;
  const s = spawner(() => (n++ === 1 ? refusingPort() : fakePort()));
  const pool = new OrderOpenerPool(s.spawn, () => 3);
  pool.unlock(1, [new Uint8Array(1)]);
  const quiet = console.error;
  console.error = () => {};
  try {
    const out = await pool.open(1, "e", jobs(9));
    assert.equal(out.kind, "opened");
    const ids = (out as { results: Array<{ id: number }> }).results.map((r) => r.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8], "the gone worker's share was opened by the rest");
  } finally {
    console.error = quiet;
  }
  assert.equal(s.made[1].terminated(), 1);
  assert.equal(pool.width, 2, "two left");
});

test("pool: with every worker gone the step is unavailable, and so is every later one", async () => {
  const s = spawner(() => refusingPort());
  const pool = new OrderOpenerPool(s.spawn, () => 2);
  pool.unlock(1, [new Uint8Array(1)]);
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await pool.open(1, "e", jobs(4)), { kind: "unavailable" });
    assert.deepEqual(await pool.open(1, "e", jobs(1)), { kind: "unavailable" }, "the page opens the rest itself");
  } finally {
    console.error = quiet;
  }
  pool.unlock(2, [new Uint8Array([1])]);
  assert.deepEqual(await pool.open(2, "e", jobs(1)), { kind: "unavailable" }, "a gone worker never comes back");
});

test("Dashboard: opens through the pool, sized from the list on screen at each unlock", () => {
  assert.match(
    DASH,
    /new OrderOpenerPool\(\s*\(\) =>\s*new Worker\(new URL\("\.\/order-opener\.worker\.ts", import\.meta\.url\), \{ type: "module" \}\) as unknown as OpenerPort,\s*\/\/[^\n]*\n\s*\(\) => poolWidth\(ordersResponse\?\.orders\.length \?\? 0, navigator\.hardwareConcurrency\),/,
  );
  assert.doesNotMatch(DASH, /new OrderOpener\(/, "no single-worker path left beside the pool");
});
