/**
 * The background fetch of the organiser's sealed orders (#965, detail-queue.ts).
 *
 * The rules that matter most: only roots the NEWEST erasure answer covers are
 * fetched or kept (an answer landing mid-fetch wins), an old answer stops new
 * fetches until a fresh one arrives, the gateway's allowance is never run down,
 * and no root is dropped silently.
 *
 * MUTATION: fetch a root no answer covered, keep a box whose root a newer answer
 * dropped, keep a box that arrived on a stale answer, fetch past a stale answer,
 * never ask for a fresh answer, issue more than CONCURRENCY at once, ignore
 * Retry-After or a low budget, skip the self cap, make a 404 retry forever or a
 * recent 404 never retry, give up on a refusal, take a late (older) answer, or keep
 * fetching after stop(), and a case below goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONCURRENCY,
  COVERAGE_REFRESH_MS,
  COVERAGE_STALE_MS,
  DetailQueue,
  HEADROOM_MIN,
  MISSING_RECHECK_MS,
  SELF_CAP_PER_MINUTE,
  type Coverage,
  type FetchResult,
} from "../src/lib/creator/dashboard/detail-queue.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
const box = (tag: string) => ({ v: 2, enc: `enc-${tag}`, ct: `ct-${tag}` }) as never;

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => now,
    setTimer: (cb: () => void, ms: number) => {
      const h = ++id;
      timers.set(h, { at: now + ms, cb });
      return h;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].cb();
        await flush();
      }
      now = end;
      await flush();
    },
    timers: () => timers.size,
  };
}

/** A queue over a fake gateway: fetches wait until the test answers them, unless `auto` is set. */
function harness() {
  const c = clock();
  const calls: string[] = [];
  const open = new Map<string, Array<(r: FetchResult) => void>>();
  const h = {
    c,
    calls,
    wants: 0,
    auto: null as ((root: string) => FetchResult) | null,
    inFlight: () => [...open.values()].reduce((n, l) => n + l.length, 0),
    async answer(root: string, r: FetchResult) {
      const waiting = open.get(root);
      assert.ok(waiting?.length, `no fetch in flight for ${root}`);
      waiting.shift()!(r);
      await flush();
    },
    q: null as unknown as DetailQueue,
  };
  h.q = new DetailQueue({
    fetchBox: (root) => {
      calls.push(root);
      if (h.auto) return Promise.resolve(h.auto(root));
      return new Promise((res) => open.set(root, [...(open.get(root) ?? []), res]));
    },
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    random: () => 0,
    wantCoverage: () => void h.wants++,
    onChange: () => {},
  });
  return h;
}

const cov = (epoch: number, at: number, roots: string[], recent: string[] = []): Coverage => ({
  epoch,
  at,
  fetchable: new Set(roots),
  recent: new Set(recent),
});
const roots = (n: number, p = "r") => Array.from({ length: n }, (_, i) => `${p}${i}`);

test("only covered roots are fetched, at most CONCURRENCY at once", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(10)));
  await flush();
  assert.equal(h.inFlight(), CONCURRENCY);
  assert.deepEqual(h.calls, roots(CONCURRENCY));
  await h.answer("r0", { kind: "ok", box: box("0") });
  assert.equal(h.inFlight(), CONCURRENCY, "a finished fetch frees a place for the next");
  assert.deepEqual(h.q.box("r0"), box("0"));
  assert.equal(h.q.state("r0"), "ready");
  assert.equal(h.q.state("zz"), undefined, "a root no answer covered is not the queue's");
});

test("a box whose root a newer answer dropped (erased) is not kept, even if it arrives later", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a", "b"]));
  await flush();
  h.q.cover(cov(2, 0, ["b"]));
  await h.answer("a", { kind: "ok", box: box("a") });
  assert.equal(h.q.box("a"), undefined);
  assert.equal(h.q.state("a"), undefined);
});

test("a fetch from before a root was dropped and offered again is not kept for the new offer", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  h.q.cover(cov(2, 0, []));
  h.q.cover(cov(3, 0, ["a"]));
  await flush();
  assert.equal(h.inFlight(), 2, "the old fetch and the new one");
  await h.answer("a", { kind: "ok", box: box("old") });
  assert.equal(h.q.box("a"), undefined, "the first fetch belonged to an offer that was withdrawn");
  assert.equal(h.q.state("a"), "fetching");
  assert.deepEqual(h.q.progress(), { total: 1, ready: 0, waiting: 1, retrying: 0, missing: 0, unreadable: 0 });
  await h.answer("a", { kind: "ok", box: box("new") });
  assert.deepEqual(h.q.box("a"), box("new"));
});

test("a held box already fetched is forgotten when an answer stops offering its root", async () => {
  const h = harness();
  h.auto = (r) => ({ kind: "ok", box: box(r) });
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  assert.ok(h.q.box("a"));
  h.q.cover(cov(2, 0, []));
  assert.equal(h.q.box("a"), undefined);
  assert.equal(h.q.progress().total, 0);
});

test("an older answer arriving late is ignored", async () => {
  const h = harness();
  h.q.cover(cov(2, 0, ["b"]));
  h.q.cover(cov(1, 0, ["a", "b"]));
  await flush();
  assert.ok(!h.calls.includes("a"));
});

test("an old answer stops new fetches, asks for a fresh one, and a fresh one resumes", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(CONCURRENCY + 1)));
  await flush();
  await h.c.advance(COVERAGE_REFRESH_MS);
  assert.equal(h.wants, 1, "asked for a fresh answer while work remains");
  await h.c.advance(COVERAGE_STALE_MS - COVERAGE_REFRESH_MS);
  await h.answer("r0", { kind: "ok", box: box("0") });
  assert.equal(h.q.box("r0"), undefined, "arrived on a stale answer: not kept");
  assert.equal(h.q.state("r0"), "queued");
  assert.equal(h.calls.length, CONCURRENCY, "nothing new issued on a stale answer");
  assert.equal(h.q.waitingOn(), "erasure-check");
  h.q.cover(cov(2, h.c.now(), roots(CONCURRENCY + 1)));
  await flush();
  assert.deepEqual(h.calls.slice(CONCURRENCY), ["r0"], "resumed, the returned root first");
});

test("a stale queue keeps asking for an answer, in case the last read failed", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(1)));
  await flush();
  await h.c.advance(COVERAGE_STALE_MS + 3 * COVERAGE_REFRESH_MS);
  assert.ok(h.wants >= 3);
});

test("an idle queue asks for nothing", async () => {
  const h = harness();
  h.auto = (r) => ({ kind: "ok", box: box(r) });
  h.q.cover(cov(1, 0, roots(3)));
  await flush();
  await h.c.advance(10 * COVERAGE_REFRESH_MS);
  assert.equal(h.wants, 0);
  assert.equal(h.c.timers(), 0, "no timer left running");
});

test("a 429 with Retry-After pauses everything for exactly that long, and the root goes first", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(CONCURRENCY + 2)));
  await flush();
  await h.answer("r1", { kind: "limited", retryAfterMs: 7_000 });
  assert.equal(h.q.waitingOn(), "gateway");
  await h.answer("r0", { kind: "ok", box: box("0") });
  assert.equal(h.calls.length, CONCURRENCY, "nothing issued while paused");
  await h.c.advance(6_999);
  assert.equal(h.calls.length, CONCURRENCY);
  await h.c.advance(1);
  assert.equal(h.calls[CONCURRENCY], "r1");
});

test("a bare 429 backs off from 5 s, doubling", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  await h.answer("a", { kind: "limited" });
  await h.c.advance(4_999);
  assert.equal(h.calls.length, 1);
  await h.c.advance(1);
  assert.equal(h.calls.length, 2);
  await h.answer("a", { kind: "limited" });
  await h.c.advance(9_999);
  assert.equal(h.calls.length, 2, "second one waits 10 s");
  await h.c.advance(1);
  assert.equal(h.calls.length, 3);
});

test("a budget running low pauses until the reset, leaving headroom", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(CONCURRENCY + 3)));
  await flush();
  await h.answer("r0", { kind: "ok", box: box("0"), budget: { limit: 1000, remaining: 249, resetMs: 20_000 } });
  assert.equal(h.calls.length, CONCURRENCY, "250 is the floor for a 1,000 limit: stop below it");
  await h.c.advance(20_000);
  assert.equal(h.calls.length, CONCURRENCY + 1);
});

test("a small budget keeps the minimum headroom", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(CONCURRENCY + 1)));
  await flush();
  await h.answer("r0", { kind: "ok", box: box("0"), budget: { limit: 200, remaining: HEADROOM_MIN - 1, resetMs: 5_000 } });
  assert.equal(h.calls.length, CONCURRENCY);
});

test("with no readable budget it keeps to the self cap per minute", async () => {
  const h = harness();
  h.auto = (r) => ({ kind: "ok", box: box(r) });
  h.q.cover(cov(1, 0, roots(SELF_CAP_PER_MINUTE + 50)));
  for (let i = 0; i < 50; i++) await flush();
  assert.equal(h.calls.length, SELF_CAP_PER_MINUTE);
  await h.c.advance(60_000);
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(h.calls.length, SELF_CAP_PER_MINUTE + 50);
});

test("a readable budget replaces the self cap", async () => {
  const h = harness();
  h.auto = (r) => ({ kind: "ok", box: box(r), budget: { limit: 100_000, remaining: 99_000, resetMs: 60_000 } });
  h.q.cover(cov(1, 0, roots(SELF_CAP_PER_MINUTE + 50)));
  for (let i = 0; i < 60; i++) await flush();
  assert.equal(h.calls.length, SELF_CAP_PER_MINUTE + 50);
});

test("a 404 is final - nothing stored there any more", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  await h.answer("a", { kind: "missing" });
  assert.equal(h.q.state("a"), "missing");
  await h.c.advance(10 * MISSING_RECHECK_MS);
  assert.equal(h.calls.length, 1);
});

test("a 404 for a recent sale gets exactly one more look", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"], ["a"]));
  await flush();
  await h.answer("a", { kind: "missing" });
  assert.equal(h.q.state("a"), "retrying");
  h.q.cover(cov(2, MISSING_RECHECK_MS - 1, ["a"], ["a"]));
  await h.c.advance(MISSING_RECHECK_MS);
  assert.equal(h.calls.length, 2);
  await h.answer("a", { kind: "missing" });
  assert.equal(h.q.state("a"), "missing");
});

test("a refusal or outage is retried, backing off, never given up", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  await h.answer("a", { kind: "unavailable" });
  assert.equal(h.q.state("a"), "retrying");
  await h.c.advance(5_000);
  assert.equal(h.calls.length, 2);
  await h.answer("a", { kind: "unavailable" });
  await h.c.advance(9_999);
  assert.equal(h.calls.length, 2);
  await h.c.advance(1);
  assert.equal(h.calls.length, 3);
  h.q.cover(cov(2, h.c.now(), ["a"]));
  await h.answer("a", { kind: "ok", box: box("a") });
  assert.equal(h.q.state("a"), "ready");
});

test("a thrown fetch counts as unavailable, not as lost", async () => {
  const c = clock();
  const q = new DetailQueue({
    fetchBox: () => Promise.reject(new Error("boom")),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    random: () => 0,
    wantCoverage: () => {},
    onChange: () => {},
  });
  q.cover(cov(1, 0, ["a"]));
  await flush();
  assert.equal(q.state("a"), "retrying");
});

test("an unreadable box is final", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  await h.answer("a", { kind: "unreadable" });
  assert.equal(h.q.state("a"), "unreadable");
});

test("the page on screen is fetched first, including after a new answer", async () => {
  const h = harness();
  h.q.prioritise(["r9", "r8", "r0"]);
  h.q.cover(cov(1, 0, roots(10)));
  await flush();
  assert.deepEqual(h.calls, ["r9", "r8", "r0", "r1"].slice(0, CONCURRENCY));
});

test("a page change moves the queued roots it shows to the front", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(10)));
  await flush();
  h.q.prioritise(["r7", "r2"]);
  await h.answer("r0", { kind: "ok", box: box("0") });
  await h.answer("r1", { kind: "ok", box: box("1") });
  assert.deepEqual(h.calls.slice(CONCURRENCY), ["r7", "r4"], "r2 was already fetched; r7 jumps the queue");
});

test("progress adds up", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a", "b", "c", "d", "e", "f"]));
  await flush();
  await h.answer("a", { kind: "ok", box: box("a") });
  await h.answer("b", { kind: "missing" });
  await h.answer("c", { kind: "unreadable" });
  await h.answer("d", { kind: "unavailable" });
  const p = h.q.progress();
  assert.deepEqual(p, { total: 6, ready: 1, waiting: 2, retrying: 1, missing: 1, unreadable: 1 });
});

test("stop() ends everything: no fetch, no timer, no late commit", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(10)));
  await flush();
  h.q.stop();
  await h.answer("r0", { kind: "ok", box: box("0") });
  assert.equal(h.q.box("r0"), undefined);
  await h.c.advance(10 * COVERAGE_REFRESH_MS);
  assert.equal(h.calls.length, CONCURRENCY);
  assert.equal(h.c.timers(), 0);
});
