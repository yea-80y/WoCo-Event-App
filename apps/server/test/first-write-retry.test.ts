/**
 * The shared first-write-retry queue (`lib/swarm/first-write-retry.ts`), on its
 * own with in-memory read/write fakes. The site directory test drives it against
 * a fake bee; this pins the queue's contract for every directory that adopts it:
 * one read-modify-write per key at a time and in order, same-id changes merged
 * while queued, a failed read OR write retried after the configured waits, and a
 * give-up that logs every queued change's replay payload and rejects.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createFirstWriteRetryQueue,
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

/** A store of change lists per key, with switches to fail the read or the write. */
function harness(over: Partial<FirstWriteRetryOptions<Change[], Change>> = {}) {
  const store = new Map<string, Change[]>();
  const io = { failReads: 0, failWrites: 0, reads: 0, writes: [] as Array<{ key: string; base: Change[]; changes: Change[] }>, active: new Map<string, number>(), maxActive: new Map<string, number>(), gate: null as null | Promise<void> };
  const enter = (key: string) => {
    const n = (io.active.get(key) ?? 0) + 1;
    io.active.set(key, n);
    io.maxActive.set(key, Math.max(n, io.maxActive.get(key) ?? 0));
  };
  const leave = (key: string) => io.active.set(key, io.active.get(key)! - 1);
  const queue = createFirstWriteRetryQueue<Change[], Change>({
    label: "[test] dir",
    read: async (key) => {
      enter(key);
      io.reads++;
      await Promise.resolve();
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
        io.writes.push({ key, base, changes });
        const next = [...base];
        for (const c of changes) {
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
  });
  return { queue, store, io };
}

test("the default waits are 70 s and 140 s: each past bee's one-minute skip list", () => {
  assert.deepEqual(FIRST_WRITE_RETRY_DELAYS_MS, [70_000, 140_000]);
});

test("one key's changes land in arrival order; keys are independent", async () => {
  const { queue, store, io } = harness();
  await Promise.all([
    queue.enqueue("k1", { id: "a" }),
    queue.enqueue("k2", { id: "x" }),
    queue.enqueue("k1", { id: "b" }),
    queue.enqueue("k1", { id: "c" }),
  ]);
  assert.deepEqual(store.get("k1")!.map((c) => c.id), ["a", "b", "c"]);
  assert.deepEqual(store.get("k2")!.map((c) => c.id), ["x"]);
});

test("a change arriving during a write is written next, on top of that write", async () => {
  const { queue, store, io } = harness();
  let open!: () => void;
  io.gate = new Promise<void>((r) => (open = r));
  const first = queue.enqueue("k", { id: "a", v: 1 });
  while (io.reads === 0) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r)); // the first write is now waiting on the gate
  const second = queue.enqueue("k", { id: "a", w: 2 });
  io.gate = null;
  open();
  await Promise.all([first, second]);
  assert.equal(io.writes.length, 2);
  assert.equal(io.maxActive.get("k"), 1, "the second round's read waited for the first write");
  assert.deepEqual(io.writes[1]!.base, [{ id: "a", v: 1 }], "the second round reads what the first wrote");
  assert.deepEqual(store.get("k"), [{ id: "a", v: 1, w: 2 }]);
});

test("same id queued while retrying: merged, written once", async () => {
  const { queue, store, io } = harness();
  io.failReads = 1;
  let later: Promise<void> | undefined;
  onSleep = () => {
    later = queue.enqueue("k", { id: "a", deploy: true });
  };
  await queue.enqueue("k", { id: "a", publish: true });
  await later;
  assert.deepEqual(sleeps, [70_000]);
  assert.equal(io.writes.length, 1);
  assert.deepEqual(store.get("k"), [{ id: "a", publish: true, deploy: true }]);
});

test("a failed WRITE is retried like a failed read", async () => {
  const { queue, store, io } = harness();
  io.failWrites = 1;
  await queue.enqueue("k", { id: "a" });
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(store.get("k"), [{ id: "a" }]);
});

test("every attempt fails: no write, every queued change logged with its replay payload, all reject; the next change starts afresh", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const { queue, store, io } = harness({ retryDelaysMs: [5, 10], replayPayload: (key, c) => ({ owner: key, item: c }) });
  io.failReads = 3;
  let b: Promise<void> | undefined;
  onSleep = () => {
    b ??= queue.enqueue("k", { id: "b" });
  };
  const a = queue.enqueue("k", { id: "a" });
  await assert.rejects(a, /read failed/);
  await assert.rejects(b!, /read failed/);
  assert.deepEqual(sleeps, [5, 10]);
  assert.equal(io.reads, 3);
  assert.equal(io.writes.length, 0, "a failed read is never taken as an empty base");
  const lines = errors.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes(JSON.stringify({ owner: "k", item: { id: "a" } })), lines[0]);
  assert.ok(lines[1]!.includes(JSON.stringify({ owner: "k", item: { id: "b" } })), lines[1]);

  await queue.enqueue("k", { id: "c" });
  assert.deepEqual(store.get("k"), [{ id: "c" }], "nothing given up on comes back");
});
