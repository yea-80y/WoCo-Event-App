/**
 * The audience sync's opener (#201, sync-opener.ts) against a fake worker pool.
 *
 * The rules: keys are asked for only when an opening starts and handed over only while
 * the run is still bound (same account, same seed address, still unlocked); the binding
 * is read directly after every step, and a step that ends unbound returns "locked" with
 * nothing it opened; the pool is locked when each opening ends, on every way out; a
 * lock is final; with no workers the page opens in steps and its keys are wiped after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OpenOutcome } from "../src/lib/creator/dashboard/order-opener.js";
import type { OpenJob as WorkerJob } from "../src/lib/creator/dashboard/order-opener-core.js";
import { PAGE_CHUNK, SYNC_POOL_MAX, SyncOpener, WORKER_BATCH, type SyncPool } from "../src/lib/creator/audience/sync-opener.js";

type FakeBox = { email?: string; bad?: true };
const job = (email: string | null, seriesId = "s1") =>
  ({ seriesId, box: (email === null ? { bad: true } : { email }) as unknown as never }) as const;

function world(opts: { workers?: boolean; width?: number } = {}) {
  const log: string[] = [];
  const st = {
    bound: true,
    unavailable: false,
    /** Runs inside each worker step, before it answers. */
    onStep: null as null | (() => void),
    keysThrow: false,
    derived: [] as Uint8Array[][],
    handed: [] as Uint8Array[][],
    pageKeysSeen: [] as Uint8Array[][],
    pools: 0,
  };
  const makePool = (jobs: number): SyncPool | null => {
    if (opts.workers === false) return null;
    st.pools++;
    log.push(`pool:${jobs}`);
    let keyed: number | null = null;
    return {
      width: opts.width ?? 1,
      keyedFor: (e) => keyed === e,
      unlock(e, keys) {
        log.push(`unlock:${e}`);
        st.handed.push(keys.map((k) => k.slice()));
        keyed = e;
        for (const k of keys) k.fill(0); // as OrderOpenerPool does
      },
      async open(e: number, eventId: string, jobs: WorkerJob[]): Promise<OpenOutcome> {
        log.push(`step:${eventId}:${jobs.length}`);
        st.onStep?.();
        await Promise.resolve();
        if (keyed !== e) return { kind: "locked" };
        if (st.unavailable) return { kind: "unavailable" };
        return {
          kind: "opened",
          results: jobs.map((j) => {
            const b = j.box as FakeBox;
            return b.bad ? { id: j.id } : { id: j.id, data: { claimerEmail: b.email } };
          }),
        };
      },
      lock() {
        log.push("lock");
        keyed = null;
      },
    };
  };
  const opener = new SyncOpener({
    makePool,
    async keys() {
      log.push("keys");
      if (st.keysThrow) throw new Error("derive failed");
      const k = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
      st.derived.push(k);
      return k;
    },
    bound: () => st.bound,
    async openOnPage(keys, box) {
      st.pageKeysSeen.push(keys);
      const b = box as unknown as FakeBox;
      if (b.bad) throw new Error("wrong key");
      return { claimerEmail: b.email };
    },
    pause: async () => void log.push("pause"),
  });
  return { log, st, opener };
}

const zeroed = (keys: Uint8Array[]) => keys.every((k) => k.every((b) => b === 0));

test("keys are asked for only when an opening starts, handed to the workers, and the pool locked when it ends", async () => {
  const w = world();
  assert.deepEqual(w.log, [], "constructing asks for nothing");
  const out = await w.opener.open("e1", [job("a@x.com"), job(null), job("c@x.com")]);
  assert.deepEqual(out, [{ claimerEmail: "a@x.com" }, null, { claimerEmail: "c@x.com" }]);
  assert.deepEqual(w.log, ["pool:3", "keys", "unlock:1", "step:e1:3", "lock"]);
  assert.ok(zeroed(w.st.derived[0]), "the page's copy is overwritten at the hand-over");
});

test("each event's opening gets its own pool and its own keys: none are held between events", async () => {
  const w = world();
  await w.opener.open("e1", [job("a@x.com")]);
  await w.opener.open("e2", [job("b@x.com")]);
  assert.deepEqual(w.log, ["pool:1", "keys", "unlock:1", "step:e1:1", "lock", "pool:1", "keys", "unlock:2", "step:e2:1", "lock"]);
});

test("unbound while the keys were derived: never handed over, wiped, locked - and every later opening too", async () => {
  const w = world();
  const real = w.opener["deps"].keys;
  w.opener["deps"].keys = async () => {
    const k = await real();
    w.st.bound = false; // the account relocked during the derivation
    return k;
  };
  assert.equal(await w.opener.open("e1", [job("a@x.com")]), "locked");
  assert.ok(!w.log.some((l) => l.startsWith("unlock")), "no hand-over");
  assert.ok(zeroed(w.st.derived[0]), "the derived keys are wiped");
  assert.ok(w.log.includes("lock"));
  w.st.bound = true;
  assert.equal(await w.opener.open("e2", [job("b@x.com")]), "locked", "a lock is final for the run");
  assert.equal(w.st.pools, 1, "nothing started after it");
});

test("unbound during a step: what it opened is dropped and the run is locked, read directly - not through a watcher", async () => {
  const w = world({ width: 1 });
  const jobs = Array.from({ length: WORKER_BATCH + 5 }, (_, i) => job(`p${i}@x.com`));
  w.st.onStep = () => void (w.st.bound = false);
  assert.equal(await w.opener.open("e1", jobs), "locked");
  assert.equal(w.log.filter((l) => l.startsWith("step")).length, 1, "no further step");
  assert.equal(w.log.at(-1), "lock");
});

test("the watcher's lock() mid-step drops the workers' keys at once, and the step answers locked", async () => {
  const w = world();
  w.st.onStep = () => w.opener.lock();
  assert.equal(await w.opener.open("e1", [job("a@x.com")]), "locked");
  const lockAt = w.log.indexOf("lock");
  assert.ok(lockAt > w.log.indexOf("step:e1:1"), "locked during the step, before it answered");
});

test("a pool that answers locked ends the run as locked", async () => {
  const w = world();
  w.st.onStep = () => {
    // A worker re-keyed or gone: the pool no longer holds this epoch.
    w.opener["pool"]?.lock();
  };
  assert.equal(await w.opener.open("e1", [job("a@x.com")]), "locked");
  assert.equal(await w.opener.open("e2", [job("b@x.com")]), "locked");
});

test("a key derivation that throws still locks the pool", async () => {
  const w = world();
  w.st.keysThrow = true;
  await assert.rejects(w.opener.open("e1", [job("a@x.com")]));
  assert.equal(w.log.at(-1), "lock");
});

test("steps are WORKER_BATCH per worker, every box answered in order; no answer = did not open", async () => {
  const w = world({ width: 2 });
  const jobs = Array.from({ length: 2 * WORKER_BATCH + 3 }, (_, i) => job(`p${i}@x.com`));
  const out = await w.opener.open("e1", jobs);
  assert.deepEqual(w.log.filter((l) => l.startsWith("step")), [`step:e1:${2 * WORKER_BATCH}`, "step:e1:3"]);
  assert.ok(out !== "locked");
  assert.equal(out[2 * WORKER_BATCH + 2]?.claimerEmail, `p${2 * WORKER_BATCH + 2}@x.com`);
});

test("no workers: opened on the page in steps with a pause, its keys wiped afterwards", async () => {
  for (const how of ["none", "unavailable"] as const) {
    const w = world(how === "none" ? { workers: false } : {});
    if (how === "unavailable") w.st.unavailable = true;
    const jobs = Array.from({ length: PAGE_CHUNK + 1 }, (_, i) => job(i === 3 ? null : `p${i}@x.com`));
    const out = await w.opener.open("e1", jobs);
    assert.ok(out !== "locked", how);
    assert.equal(out.filter((c) => c === null).length, 1, how);
    assert.equal(w.log.filter((l) => l === "pause").length, 2, `${how}: a pause after each page step`);
    assert.ok(zeroed(w.st.pageKeysSeen[0]), `${how}: page keys wiped when the opening ends`);
  }
});

test("unbound while opening on the page: no further step is opened, locked, keys wiped", async () => {
  const w = world({ workers: false });
  const jobs = Array.from({ length: PAGE_CHUNK * 3 }, (_, i) => job(`p${i}@x.com`));
  const page = w.opener["deps"].openOnPage;
  w.opener["deps"].openOnPage = async (...args) => {
    w.st.bound = false; // relocked during the first step
    return page(...args);
  };
  assert.equal(await w.opener.open("e1", jobs), "locked");
  assert.equal(w.st.pageKeysSeen.length, PAGE_CHUNK, "the step in progress finishes; no later one starts");
  assert.ok(zeroed(w.st.pageKeysSeen[0]));
});

test("wiring: the sync's own pool, at most SYNC_POOL_MAX workers, the dashboard's worker code", () => {
  assert.equal(SYNC_POOL_MAX, 2);
  const live = readFileSync(new URL("../src/lib/creator/audience/sync-live.ts", import.meta.url), "utf-8");
  assert.match(live, /new OrderOpenerPool\(\s*liveOrderOpenerWorker,\s*\(\) => Math\.min\(SYNC_POOL_MAX, poolWidth\(jobs, navigator\.hardwareConcurrency\)\)/);
  assert.match(live, /orderSealContext\(eventId, seriesId\)/, "page opening bound to the event and the slot's series");
});

test("it says how many orders are done after each step, workers or page", async () => {
  for (const workers of [true, false]) {
    const w = world({ workers, width: 1 });
    const jobs = Array.from({ length: WORKER_BATCH + 1 }, (_, i) => job(`p${i}@x.com`));
    const told: number[] = [];
    await w.opener.open("e1", jobs, (done) => void told.push(done));
    assert.equal(told.at(-1), jobs.length, String(workers));
    assert.ok(told.every((n, i) => i === 0 || n > told[i - 1]), "only ever forward");
  }
});
