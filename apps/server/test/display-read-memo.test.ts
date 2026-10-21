/**
 * The shared display-read memo (`lib/swarm/display-read-memo.ts`): populated
 * results reused for `ttlMs`, a definite "nothing there" for `emptyTtlMs`, an
 * unreadable answer never; concurrent callers share one read; invalidate drops
 * the memo and detaches a read in flight.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createDisplayReadMemo, __displayReadMemoTestHooks, type DisplayRead } from "../src/lib/swarm/display-read-memo.js";

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  __displayReadMemoTestHooks.setClock(() => now);
});
after(() => __displayReadMemoTestHooks.setClock(null));

const memo = (maxKeys?: number) =>
  createDisplayReadMemo<string[]>({ ttlMs: 300, emptyTtlMs: 90, isEmpty: (d) => d.length === 0, maxKeys });

function counting(answer: () => DisplayRead<string[]> | Promise<DisplayRead<string[]>>) {
  const calls = { n: 0 };
  return { calls, load: async () => (calls.n++, answer()) };
}

test("populated: reused for ttlMs, then read again", async () => {
  const m = memo();
  const { calls, load } = counting(() => ({ status: "ok", data: ["a"] }));
  await m.read("k", load);
  now += 299;
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["a"] });
  assert.equal(calls.n, 1);
  now += 1;
  await m.read("k", load);
  assert.equal(calls.n, 2);
});

test("empty: reused for emptyTtlMs only", async () => {
  const m = memo();
  const { calls, load } = counting(() => ({ status: "ok", data: [] }));
  await m.read("k", load);
  now += 89;
  await m.read("k", load);
  assert.equal(calls.n, 1);
  now += 1;
  await m.read("k", load);
  assert.equal(calls.n, 2);
});

test("an error, or a load that throws, is never memoized", async () => {
  const m = memo();
  const failing = counting(() => ({ status: "error" }));
  assert.deepEqual(await m.read("k", failing.load), { status: "error" });
  await m.read("k", failing.load);
  assert.equal(failing.calls.n, 2);
  assert.deepEqual(await m.read("k2", () => Promise.reject(new Error("boom"))), { status: "error" });
});

test("a load that throws SYNCHRONOUSLY is an error answer, not a rejection, and is not memoized", async () => {
  const m = memo();
  let n = 0;
  const throwing = (): Promise<DisplayRead<string[]>> => {
    n++;
    throw new Error("thrown before any promise");
  };
  assert.deepEqual(await m.read("k", throwing), { status: "error" });
  assert.deepEqual(await m.read("k", throwing), { status: "error" });
  assert.equal(n, 2);
});

test("concurrent callers share one read", async () => {
  const m = memo();
  const { calls, load } = counting(() => ({ status: "ok", data: ["a"] }));
  await Promise.all([m.read("k", load), m.read("k", load), m.read("k", load)]);
  assert.equal(calls.n, 1);
});

test("invalidate drops the memo, and a read in flight answers its caller but is neither joined nor memoized", async () => {
  const m = memo();
  let release!: (v: DisplayRead<string[]>) => void;
  const stale = m.read("k", () => new Promise((r) => (release = r)));
  m.invalidate("k");
  const fresh = counting(() => ({ status: "ok", data: ["new"] }));
  const after = m.read("k", fresh.load);
  assert.equal(fresh.calls.n, 1, "a caller after invalidate does not join the old read");
  release({ status: "ok", data: [] });
  assert.deepEqual(await stale, { status: "ok", data: [] });
  assert.deepEqual(await after, { status: "ok", data: ["new"] });
  assert.deepEqual(await m.read("k", fresh.load), { status: "ok", data: ["new"] });
  assert.equal(fresh.calls.n, 1);
});

test("at most maxKeys are held; the oldest goes first", async () => {
  const m = memo(2);
  const { calls, load } = counting(() => ({ status: "ok", data: ["a"] }));
  await m.read("a", load);
  await m.read("b", load);
  await m.read("c", load);
  assert.equal(calls.n, 3);
  await m.read("b", load);
  await m.read("c", load);
  assert.equal(calls.n, 3);
  await m.read("a", load);
  assert.equal(calls.n, 4);
});
