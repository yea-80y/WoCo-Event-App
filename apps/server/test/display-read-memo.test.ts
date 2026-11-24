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

const staleMemo = () =>
  createDisplayReadMemo<string[]>({ ttlMs: 300, emptyTtlMs: 90, staleMs: 1000, isEmpty: (d) => d.length === 0 });

test("staleMs: past ttlMs a populated entry answers at once while ONE read refreshes it behind", async () => {
  const m = staleMemo();
  let answer = ["old"];
  let release: (() => void) | null = null;
  const calls = { n: 0 };
  const load = async (): Promise<DisplayRead<string[]>> => {
    calls.n++;
    if (calls.n > 1) await new Promise<void>((r) => (release = r));
    return { status: "ok", data: answer };
  };
  await m.read("k", load);
  now += 300;
  answer = ["new"];
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["old"] }, "the stale entry answers at once");
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["old"] });
  assert.equal(calls.n, 2, "one refresh, however many callers");
  release!();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["new"] }, "the refreshed entry answers next");
  assert.equal(calls.n, 2);
});

test("staleMs: an entry past ttlMs + staleMs is read again and waited for", async () => {
  const m = staleMemo();
  let answer = ["old"];
  const { calls, load } = counting(() => ({ status: "ok", data: answer }));
  await m.read("k", load);
  now += 1300;
  answer = ["new"];
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["new"] });
  assert.equal(calls.n, 2);
});

test("staleMs: an empty entry is never answered stale", async () => {
  const m = staleMemo();
  let answer: string[] = [];
  const { calls, load } = counting(() => ({ status: "ok", data: answer }));
  await m.read("k", load);
  now += 90;
  answer = ["created"];
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["created"] });
  assert.equal(calls.n, 2);
});

test("staleMs: a refresh that fails keeps the stale entry, and an error is never memoized", async () => {
  const m = staleMemo();
  let fail = false;
  const { calls, load } = counting(() => (fail ? { status: "error" } : { status: "ok", data: ["old"] }));
  await m.read("k", load);
  now += 400;
  fail = true;
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["old"] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["old"] }, "still answered from the stale entry");
  assert.equal(calls.n, 3, "each read past ttlMs tries a refresh again");
});

test("without staleMs an expired entry is waited for, as before", async () => {
  const m = memo();
  const { calls, load } = counting(() => ({ status: "ok", data: ["a"] }));
  await m.read("k", load);
  now += 300;
  let settled = false;
  const p = m.read("k", load).then((r) => ((settled = true), r));
  assert.equal(calls.n, 2);
  await p;
  assert.ok(settled);
});

test("invalidatePrefix drops every key under the prefix and nothing else", async () => {
  const m = memo();
  const { calls, load } = counting(() => ({ status: "ok", data: ["a"] }));
  await m.read("ev1|", load);
  await m.read("ev1|0xabc", load);
  await m.read("ev10|", load);
  await m.read("ev2|", load);
  m.invalidatePrefix("ev1|");
  await m.read("ev1|", load);
  await m.read("ev1|0xabc", load);
  assert.equal(calls.n, 6, "both ev1 keys read again");
  await m.read("ev10|", load);
  await m.read("ev2|", load);
  assert.equal(calls.n, 6, "ev10 and ev2 untouched");
});

test("keep: false is answered but never memoized, and never replaces a stale entry", async () => {
  const m = staleMemo();
  let answer: DisplayRead<string[]> = { status: "ok", data: ["good"] };
  const { calls, load } = counting(() => answer);
  await m.read("k", load);
  now += 400;
  answer = { status: "ok", data: ["fallback"], keep: false };
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["good"] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await m.read("k", load), { status: "ok", data: ["good"] }, "the fallback did not replace it");
  const fresh = staleMemo();
  assert.deepEqual(await fresh.read("x", load), { status: "ok", data: ["fallback"], keep: false });
  await fresh.read("x", load);
  assert.equal(calls.n, 5, "nothing memoized under x either");
});

test("invalidateWhere drops the entries it picks, keeps the rest, and detaches every read in flight", async () => {
  const m = memo();
  const { calls, load } = counting(() => ({ status: "ok", data: ["a"] }));
  await m.read("drop", async () => ({ status: "ok", data: ["creator-1"] }));
  await m.read("keep", async () => ({ status: "ok", data: ["creator-2"] }));
  let release!: (v: DisplayRead<string[]>) => void;
  const inflight = m.read("pending", () => new Promise((r) => (release = r)));
  m.invalidateWhere((data) => data[0] === "creator-1");
  await m.read("drop", load);
  assert.equal(calls.n, 1, "the picked entry is read again");
  assert.deepEqual(await m.read("keep", load), { status: "ok", data: ["creator-2"] });
  assert.equal(calls.n, 1, "the other entry stays");
  await m.read("pending", load);
  assert.equal(calls.n, 2, "a read in flight was detached, not joined");
  release({ status: "ok", data: ["creator-1"] });
  await inflight;
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
