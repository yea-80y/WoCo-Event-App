/**
 * The shared first-write-retry queue (`lib/swarm/first-write-retry.ts`), on its
 * own with in-memory read/write fakes. The directory tests drive it against a
 * fake bee; this pins the queue's contract for every directory that adopts it:
 * one read-modify-write per key at a time and in order, same-id changes merged
 * while queued (tracked by generation, so a mutating merge strands nobody), no
 * merging at all without `idOf`, a failed read OR write retried after the
 * configured waits, a first-attempt answer that never waits through a retry, a
 * give-up that logs every queued change's replay payload and rejects, and the
 * per-queue counters `/api/health` serves.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createFirstWriteRetryQueue,
  firstWriteRetryHealth,
  FIRST_WRITE_RETRY_DELAYS_MS,
  __firstWriteRetryTestHooks,
  type FirstWriteRetryOptions,
} from "../src/lib/swarm/first-write-retry.js";

type Change = { id: string; [field: string]: unknown };

const sleeps: number[] = [];
let onSleep: (() => void | Promise<void>) | null = null;

before(() => {
  __firstWriteRetryTestHooks.setSleep(async (ms) => {
    sleeps.push(ms);
    await onSleep?.();
  });
});
after(() => __firstWriteRetryTestHooks.setSleep(null));
beforeEach(() => {
  sleeps.length = 0;
  onSleep = null;
});

const tick = () => new Promise((r) => setImmediate(r));
let queueNo = 0;

/** A store of change lists per key, with switches to fail the read or the write. */
function harness(over: Partial<FirstWriteRetryOptions<Change[], Change>> = {}) {
  const store = new Map<string, Change[]>();
  const io = { readGate: null as null | Promise<void>, failReads: 0, failWrites: 0, reads: 0, writes: [] as Array<{ key: string; base: Change[]; changes: Change[] }>, active: new Map<string, number>(), maxActive: new Map<string, number>(), gate: null as null | Promise<void> };
  const enter = (key: string) => {
    const n = (io.active.get(key) ?? 0) + 1;
    io.active.set(key, n);
    io.maxActive.set(key, Math.max(n, io.maxActive.get(key) ?? 0));
  };
  const leave = (key: string) => io.active.set(key, io.active.get(key)! - 1);
  const healthKey = `test${++queueNo}`;
  const queue = createFirstWriteRetryQueue<Change[], Change>({
    label: "[test] dir",
    healthKey,
    read: async (key) => {
      enter(key);
      io.reads++;
      await Promise.resolve();
      if (io.readGate) await io.readGate;
      if (io.failReads > 0) {
        io.failReads--;
        leave(key);
        throw new Error("read failed");
      }
      return [...(store.get(key) ?? [])];
    },
    write: async (key, base, changes) => {
      try {
        if (io.gate) await io.gate;
        if (io.failWrites > 0) {
          io.failWrites--;
          throw new Error("write failed");
        }
        io.writes.push({ key, base, changes: changes.map((c) => ({ ...c })) });
        const next = [...base];
        for (const c of changes) {
          if (c.remove) {
            const i = next.findIndex((x) => x.id === c.id);
            if (i >= 0) next.splice(i, 1);
            continue;
          }
          const i = next.findIndex((x) => x.id === c.id);
          if (i >= 0) next[i] = { ...next[i], ...c };
          else next.push(c);
        }
        store.set(key, next);
      } finally {
        leave(key);
      }
    },
    idOf: (c) => c.id,
    merge: (a, b) => ({ ...a, ...b }),
    ...over,
  } as FirstWriteRetryOptions<Change[], Change>);
  return { queue, store, io, health: () => firstWriteRetryHealth()[healthKey]! };
}

test("the default waits are 70 s and 140 s: each past bee's one-minute skip list", () => {
  assert.deepEqual(FIRST_WRITE_RETRY_DELAYS_MS, [70_000, 140_000]);
});

test("one key's changes land in arrival order; keys are independent", async () => {
  const { queue, store } = harness();
  await Promise.all([
    queue.enqueue("k1", { id: "a" }).written,
    queue.enqueue("k2", { id: "x" }).written,
    queue.enqueue("k1", { id: "b" }).written,
    queue.enqueue("k1", { id: "c" }).written,
  ]);
  assert.deepEqual(store.get("k1")!.map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(store.get("k2")!.map((c) => c.id), ["x"]);
});

test("a change arriving during a write is written next, on top of that write", async () => {
  const { queue, store, io } = harness();
  let open!: () => void;
  io.gate = new Promise<void>((r) => (open = r));
  const first = queue.enqueue("k", { id: "a", v: 1 });
  while (io.reads === 0) await tick();
  await tick(); // the first write is now waiting on the gate
  const second = queue.enqueue("k", { id: "a", w: 2 });
  io.gate = null;
  open();
  await Promise.all([first.written, second.written]);
  assert.equal(io.writes.length, 2);
  assert.equal(io.maxActive.get("k"), 1, "the second round's read waited for the first write");
  assert.deepEqual(io.writes[1]!.base, [{ id: "a", v: 1 }], "the second round reads what the first wrote");
  assert.deepEqual(store.get("k"), [{ id: "a", v: 1, w: 2 }]);
});

test("a merge that MUTATES the earlier change during its write strands nobody: it is written again next round", { timeout: 20_000 }, async () => {
  // Merge by mutation: `earlier` is the very object the in-flight write holds.
  const { queue, store, io } = harness({ merge: (a, b) => Object.assign(a, b) });
  let open!: () => void;
  io.gate = new Promise<void>((r) => (open = r));
  const first = queue.enqueue("k", { id: "a", v: 1 });
  while (io.reads === 0) await tick();
  await tick();
  const second = queue.enqueue("k", { id: "a", w: 2 });
  io.gate = null;
  open();
  // With identity tracking, the mutated object still `===` the batch's, so it
  // was deleted as written and `second` waited for ever.
  const settled = await Promise.race([second.written.then(() => "written"), new Promise((r) => setTimeout(() => r("stranded"), 500))]);
  assert.equal(settled, "written");
  await first.written;
  assert.deepEqual(store.get("k"), [{ id: "a", v: 1, w: 2 }]);
});

test("same id queued while retrying: merged, written once", async () => {
  const { queue, store, io } = harness();
  io.failReads = 1;
  let later: Promise<void> | undefined;
  onSleep = () => {
    later = queue.enqueue("k", { id: "a", deploy: true }).written;
  };
  await queue.enqueue("k", { id: "a", publish: true }).written;
  await later;
  assert.deepEqual(sleeps, [70_000]);
  assert.equal(io.writes.length, 1);
  assert.deepEqual(store.get("k"), [{ id: "a", publish: true, deploy: true }]);
});

test("without idOf nothing merges: an add then a remove of one id ends removed, a remove then a re-add ends present, in one write each", async () => {
  const noMerge = { idOf: undefined, merge: undefined };
  {
    const { queue, store, io } = harness(noMerge);
    store.set("k", [{ id: "keep" }]);
    io.failReads = 1;
    let removed: Promise<void> | undefined;
    onSleep = () => {
      removed = queue.enqueue("k", { id: "a", remove: true }).written;
    };
    await queue.enqueue("k", { id: "a" }).written;
    await removed;
    assert.equal(io.writes.length, 1);
    assert.deepEqual(io.writes[0]!.changes, [{ id: "a" }, { id: "a", remove: true }], "both, in arrival order");
    assert.deepEqual(store.get("k"), [{ id: "keep" }]);
  }
  {
    const { queue, store, io } = harness(noMerge);
    store.set("k", [{ id: "a", v: 1 }]);
    io.failReads = 1;
    let readded: Promise<void> | undefined;
    onSleep = () => {
      readded = queue.enqueue("k", { id: "a", v: 2 }).written;
    };
    await queue.enqueue("k", { id: "a", remove: true }).written;
    await readded;
    assert.deepEqual(store.get("k"), [{ id: "a", v: 2 }]);
  }
});

test("a failed WRITE is retried like a failed read", async () => {
  const { queue, store, io } = harness();
  io.failWrites = 1;
  await queue.enqueue("k", { id: "a" }).written;
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(store.get("k"), [{ id: "a" }]);
});

// ---------------------------------------------------------------------------
// firstAttempt: one attempt, never a retry wait
// ---------------------------------------------------------------------------

test("firstAttempt: 'written' when the first attempt writes", { timeout: 20_000 }, async () => {
  const { queue } = harness();
  assert.equal(await queue.enqueue("k", { id: "a" }).firstAttempt, "written");
});

test("firstAttempt: 'retrying' as soon as the first attempt fails - BEFORE the wait - and the retry still writes", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const { queue, store, io } = harness();
  io.failReads = 1;
  let release!: () => void;
  const minutePassed = new Promise<void>((r) => (release = r));
  onSleep = () => minutePassed;
  const q = queue.enqueue("k", { id: "a" });
  assert.equal(await q.firstAttempt, "retrying");
  assert.equal(store.get("k"), undefined, "answered while the retry is still waiting");
  release();
  await q.written;
  assert.deepEqual(store.get("k"), [{ id: "a" }]);
});

test("firstAttempt: a change arriving during a retry wait is told 'retrying' at once, and rides that retry", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const { queue, store, io } = harness();
  io.failReads = 1;
  let release!: () => void;
  const minutePassed = new Promise<void>((r) => (release = r));
  let joined: ReturnType<typeof queue.enqueue> | undefined;
  onSleep = async () => {
    joined = queue.enqueue("k", { id: "b" });
    assert.equal(await joined.firstAttempt, "retrying", "never made to wait for the minute");
    await minutePassed;
  };
  const first = queue.enqueue("k", { id: "a" });
  while (!joined) await tick();
  release();
  await Promise.all([first.written, joined.written]);
  assert.equal(io.writes.length, 1);
  assert.deepEqual(store.get("k")!.map((c) => c.id), ["a", "b"]);
});

test("firstAttempt: a change arriving during a write that then FAILS is told 'retrying' too - its next chance is after the wait", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const { queue, io } = harness();
  io.failWrites = 1;
  let open!: () => void;
  io.gate = new Promise<void>((r) => (open = r));
  const first = queue.enqueue("k", { id: "a" });
  while (io.reads === 0) await tick();
  await tick();
  const during = queue.enqueue("k", { id: "b" });
  io.gate = null;
  open();
  assert.equal(await first.firstAttempt, "retrying");
  assert.equal(await during.firstAttempt, "retrying");
  await Promise.all([first.written, during.written]);
});

test("firstAttempt rejects only for a change dropped before it was told 'retrying'", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { queue, io } = harness({ retryDelaysMs: [] });
  io.failReads = 1;
  const q = queue.enqueue("k", { id: "a" });
  await assert.rejects(q.firstAttempt, /read failed/);
  await assert.rejects(q.written, /read failed/);
});

test("a change enqueued DURING the last attempt, which then fails, is dropped with it: both its promises reject", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { queue, io } = harness({ retryDelaysMs: [5, 10] });
  io.failReads = 3;
  let open!: () => void;
  onSleep = () => {
    if (sleeps.length === 2) io.readGate = new Promise<void>((r) => (open = r)); // the third read waits
  };
  const first = queue.enqueue("k", { id: "a" });
  assert.equal(await first.firstAttempt, "retrying");
  while (io.reads < 3) await tick();
  const late = queue.enqueue("k", { id: "b" }); // never told "retrying": no retry is left to carry it
  io.readGate = null;
  open();
  await assert.rejects(late.firstAttempt, /read failed/);
  await assert.rejects(late.written, /read failed/);
  await assert.rejects(first.written, /read failed/);
});

test("a replay payload that will not serialise still lets every retry and the give-up through", { timeout: 20_000 }, async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const warns = t.mock.method(console, "warn", () => {});
  const { queue, io, health } = harness({ retryDelaysMs: [5], replayPayload: () => ({ big: 1n }) });
  io.failReads = 2;
  const q = queue.enqueue("k", { id: "a" });
  assert.equal(await q.firstAttempt, "retrying");
  await assert.rejects(q.written, /read failed/);
  assert.equal(warns.mock.calls.length, 1);
  assert.equal(errors.mock.calls.length, 1);
  assert.ok(String(errors.mock.calls[0]!.arguments[0]).includes("[object Object]"), "falls back to String(change)");
  assert.equal(health().dropped, 1);
});

test("a caller that ignores both promises never causes an unhandled rejection on give-up", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { queue, io, health } = harness({ retryDelaysMs: [1] });
    io.failReads = 2;
    queue.enqueue("k", { id: "a" }); // fire-and-forget, nothing attached
    for (let i = 0; i < 1000 && health().dropped === 0; i++) await tick();
    assert.equal(health().dropped, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// Give-up, logging, health
// ---------------------------------------------------------------------------

test("every retry warning carries the queued changes' replay payloads", async (t) => {
  const warns = t.mock.method(console, "warn", () => {});
  const { queue, io } = harness({ replayPayload: (key, c) => ({ owner: key, item: c }) });
  io.failReads = 2;
  await queue.enqueue("k", { id: "a" }).written;
  const lines = warns.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(l.includes(JSON.stringify({ owner: "k", item: { id: "a" } })), l);
});

test("every attempt fails: no write, every queued change logged with its replay payload, all reject; the next change starts afresh", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { queue, store, io } = harness({ retryDelaysMs: [5, 10], replayPayload: (key, c) => ({ owner: key, item: c }) });
  io.failReads = 3;
  let b: Promise<void> | undefined;
  onSleep = () => {
    b ??= queue.enqueue("k", { id: "b" }).written;
  };
  const a = queue.enqueue("k", { id: "a" }).written;
  await assert.rejects(a, /read failed/);
  await assert.rejects(b!, /read failed/);
  assert.deepEqual(sleeps, [5, 10]);
  assert.equal(io.reads, 3);
  assert.equal(io.writes.length, 0, "a failed read is never taken as an empty base");
  const lines = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes(JSON.stringify({ owner: "k", item: { id: "a" } })), lines[0]);
  assert.ok(lines[1]!.includes(JSON.stringify({ owner: "k", item: { id: "b" } })), lines[1]);

  await queue.enqueue("k", { id: "c" }).written;
  assert.deepEqual(store.get("k"), [{ id: "c" }], "nothing given up on comes back");
});

test("health counters: pending and retrying while a key waits, back to 0 when written; dropped stays and turns ok false", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { queue, io, health } = harness({ retryDelaysMs: [5] });
  assert.deepEqual(health(), { ok: true, pending: 0, retrying: 0, dropped: 0 });

  io.failReads = 1;
  let seen: ReturnType<typeof health> | undefined;
  onSleep = () => {
    queue.enqueue("k", { id: "a", more: 1 }); // merged: still one pending change
    queue.enqueue("k", { id: "b" });
    seen = health();
  };
  await queue.enqueue("k", { id: "a" }).written;
  assert.deepEqual(seen, { ok: true, pending: 2, retrying: 1, dropped: 0 });
  await tick();
  assert.deepEqual(health(), { ok: true, pending: 0, retrying: 0, dropped: 0 });

  onSleep = null;
  io.failReads = 2;
  await assert.rejects(queue.enqueue("k2", { id: "x" }).written);
  assert.deepEqual(health(), { ok: false, pending: 0, retrying: 0, dropped: 1 });
  await queue.enqueue("k2", { id: "y" }).written;
  assert.equal(health().dropped, 1, "red until restart: a dropped change is lost until replayed by hand");
  assert.equal(health().ok, false);
});

test("a health key names one queue", () => {
  const { health } = harness();
  assert.ok(health());
  assert.throws(() =>
    createFirstWriteRetryQueue({ label: "x", healthKey: `test${queueNo}`, read: async () => 0, write: async () => {} }),
  );
});

test("/api/health serves every queue's counters as directoryWrites (red on a drop, via /api/health/alarms)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  const report = src.slice(src.indexOf("function healthReport()"), src.indexOf('app.get("/api/health"'));
  assert.match(report, /\n\s*directoryWrites: firstWriteRetryHealth\(\),/);
  for (const [file, key] of [
    ["../src/lib/site/service.ts", "siteDirectory"],
    ["../src/lib/event/service.ts", "eventIndex"],
    ["../src/lib/object/directory.ts", "objectDirectory"],
  ] as const) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf-8"), new RegExp(`healthKey: "${key}"`), file);
  }
});
