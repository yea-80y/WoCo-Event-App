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
  LIMITED_MIN_MS,
  MISSING_RECHECK_MS,
  RETRY_COALESCE_MS,
  BATCH_CONCURRENCY,
  BATCH_SELF_CAP_PER_MINUTE,
  SELF_CAP_PER_MINUTE,
  type BatchResult,
  type Coverage,
  type FetchResult,
  type DetailQueueDeps,
  HOLD_RECHECK_MS,
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
function harness(over: Partial<Pick<DetailQueueDeps, "headroomShare" | "holdWhile">> = {}) {
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
  // One root per request, as from a gateway without bundles: the live single read's mapping.
  const asBatch = (root: string, r: FetchResult): BatchResult =>
    r.kind === "limited"
      ? { kind: "limited", ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}), budget: r.budget }
      : { kind: "items", items: new Map([[root, r]]), budget: r.budget };
  h.q = new DetailQueue({
    maxBatch: () => 1,
    fetchBatch: (batch) => {
      assert.equal(batch.length, 1, "one root per request when maxBatch is 1");
      const root = batch[0];
      calls.push(root);
      if (h.auto) return Promise.resolve(asBatch(root, h.auto(root)));
      return new Promise((res) => open.set(root, [...(open.get(root) ?? []), (r: FetchResult) => res(asBatch(root, r))]));
    },
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    random: () => 0,
    wantCoverage: () => void h.wants++,
    onChange: () => {},
    ...over,
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

test("a 429 saying 'retry now' still pauses at least a second (Fable sign-off S1)", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, ["a"]));
  await flush();
  await h.answer("a", { kind: "limited", retryAfterMs: 0 });
  await h.c.advance(LIMITED_MIN_MS - 1);
  assert.equal(h.calls.length, 1, "no tight loop against a refusing gateway");
  await h.c.advance(1);
  assert.equal(h.calls.length, 2);
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

test("a small dedicated allowance (the bundle limiter's 120) keeps a quarter, not a fixed 100 (Fable sign-off S1)", async () => {
  const h = harness();
  h.q.cover(cov(1, 0, roots(CONCURRENCY + 2)));
  await flush();
  await h.answer("r0", { kind: "ok", box: box("0"), budget: { limit: 120, remaining: 30, resetMs: 5_000 } });
  assert.equal(h.calls.length, CONCURRENCY + 1, "30 of 120 left: still going (a fixed 100 would have stopped at the 21st)");
  await h.answer("r1", { kind: "ok", box: box("1"), budget: { limit: 120, remaining: 29, resetMs: 5_000 } });
  assert.equal(h.calls.length, CONCURRENCY + 1, "below a quarter: paused until the reset");
  await h.c.advance(5_000);
  assert.equal(h.calls.length, CONCURRENCY + 2);
});

test("a background queue (the audience sync's) keeps half the allowance spare; the default keeps a quarter", async () => {
  const budget = { limit: 300, remaining: 149, resetMs: 5_000 };
  const bg = harness({ headroomShare: 0.5 });
  bg.q.cover(cov(1, 0, roots(CONCURRENCY + 2)));
  await flush();
  await bg.answer("r0", { kind: "ok", box: box("0"), budget });
  assert.equal(bg.calls.length, CONCURRENCY, "149 of 300 left: below half, paused until the reset");
  await bg.c.advance(5_000);
  assert.equal(bg.calls.length, CONCURRENCY + 1);

  const fg = harness();
  fg.q.cover(cov(1, 0, roots(CONCURRENCY + 2)));
  await flush();
  await fg.answer("r0", { kind: "ok", box: box("0"), budget });
  assert.equal(fg.calls.length, CONCURRENCY + 1, "the dashboard's queue keeps going at the same budget");
});

test("held while a foreground read is busy: nothing fetched, no answer asked for; resumed only on a fresh answer", async () => {
  let busy = true;
  const h = harness({ holdWhile: () => busy });
  h.q.cover(cov(1, 0, roots(3)));
  await flush();
  assert.equal(h.calls.length, 0, "held from the first fetch");
  await h.c.advance(COVERAGE_STALE_MS + 30_000);
  assert.equal(h.calls.length, 0);
  assert.equal(h.wants, 0, "no erasure answer asked for while held");
  busy = false;
  await h.c.advance(HOLD_RECHECK_MS);
  assert.equal(h.calls.length, 0, "the answer went old during the hold: nothing fetched on it");
  assert.equal(h.wants, 1, "a fresh one is asked for instead");
  h.q.cover(cov(2, h.c.now(), roots(3)));
  await flush();
  assert.equal(h.calls.length, 3);
});

test("a hold that ends while the answer is still fresh resumes at once", async () => {
  let busy = true;
  const h = harness({ holdWhile: () => busy });
  h.q.cover(cov(1, 0, roots(2)));
  await h.c.advance(10_000);
  assert.equal(h.calls.length, 0);
  busy = false;
  await h.c.advance(HOLD_RECHECK_MS);
  assert.equal(h.calls.length, 2);
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
  await h.c.advance(MISSING_RECHECK_MS + RETRY_COALESCE_MS);
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
  // Each retry falls due after its backoff, then waits RETRY_COALESCE_MS to share a bundle.
  await h.c.advance(5_000 + RETRY_COALESCE_MS);
  assert.equal(h.calls.length, 2);
  await h.answer("a", { kind: "unavailable" });
  await h.c.advance(10_000 + RETRY_COALESCE_MS - 1);
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
    maxBatch: () => 1,
    fetchBatch: () => Promise.reject(new Error("boom")),
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

// ── bundles (our gateway's POST /bytes-bundle) ─────────────────────────────

/** A queue over a gateway with bundles: each request waits until the test replies to it by index. */
function bundleHarness(size: number = 100, random: () => number = () => 0) {
  const c = clock();
  const sent: string[][] = [];
  const replies: Array<(r: BatchResult) => void> = [];
  let max = size;
  let auto: ((roots: string[]) => BatchResult) | null = null;
  const q = new DetailQueue({
    maxBatch: () => max,
    fetchBatch: (roots) => {
      assert.ok(roots.length <= (Number.isFinite(max) ? max : 1), "never more than maxBatch (1 when it is not a number)");
      sent.push([...roots]);
      if (auto) return Promise.resolve(auto(roots));
      return new Promise((res) => replies.push(res));
    },
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    random,
    wantCoverage: () => {},
    onChange: () => {},
  });
  return {
    c,
    q,
    sent,
    setMax: (n: number) => void (max = n),
    setAuto: (f: (roots: string[]) => BatchResult) => void (auto = f),
    async reply(i: number, r: BatchResult) {
      replies[i](r);
      await flush();
    },
  };
}
const itemsOf = (entries: Array<[string, FetchResult]>): BatchResult => ({ kind: "items", items: new Map(entries) });
const allOk = (roots: string[]) => itemsOf(roots.map((r) => [r, { kind: "ok", box: box(r) }]));

test("a bundle carries up to maxBatch roots, page on screen first, and counts as one request", async () => {
  const h = bundleHarness();
  h.q.prioritise(["r249", "r3"]);
  h.q.cover(cov(1, 0, roots(250)));
  await flush();
  assert.equal(h.sent.length, BATCH_CONCURRENCY, "two bundles in flight, not two hundred requests");
  assert.deepEqual(h.sent[0].slice(0, 4), ["r249", "r3", "r0", "r1"]);
  assert.equal(h.sent[0].length, 100);
  assert.equal(h.sent[1].length, 100);
  await h.reply(0, allOk(h.sent[0]));
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].length, 50, "never waits to fill a bundle");
  assert.equal(h.q.progress().ready, 100);
});

test("each root of a bundle settles by the usual rules; a root the answer left out is retried", async () => {
  const h = bundleHarness();
  h.q.cover(cov(1, 0, ["a", "b", "c", "d", "e"]));
  await flush();
  await h.reply(0, itemsOf([
    ["a", { kind: "ok", box: box("a") }],
    ["b", { kind: "missing" }],
    ["c", { kind: "unavailable" }],
    ["d", { kind: "unreadable" }],
  ]));
  assert.deepEqual(["a", "b", "c", "d", "e"].map((r) => h.q.state(r)), ["ready", "missing", "retrying", "unreadable", "retrying"]);
});

test("a 429 for a bundle pauses everything and sends its roots back first, in order", async () => {
  const h = bundleHarness(3);
  h.q.cover(cov(1, 0, roots(8)));
  await flush();
  await h.reply(0, { kind: "limited", retryAfterMs: 7_000 });
  await h.c.advance(6_999);
  assert.equal(h.sent.length, 2);
  await h.reply(1, allOk(h.sent[1]));
  assert.equal(h.sent.length, 2, "still paused");
  await h.c.advance(1);
  assert.deepEqual(h.sent[2], ["r0", "r1", "r2"]);
});

test("a bundle that fails as a whole retries together, as one bundle", async () => {
  const h = bundleHarness();
  h.q.cover(cov(1, 0, roots(5)));
  await flush();
  await h.reply(0, { kind: "unavailable" });
  assert.ok(roots(5).every((r) => h.q.state(r) === "retrying"));
  await h.c.advance(4_999);
  assert.equal(h.sent.length, 1);
  await h.c.advance(1);
  assert.deepEqual(h.sent[1], roots(5));
});

test("unsupported: nothing is lost, the roots go back first, then one per request", async () => {
  const h = bundleHarness();
  h.q.cover(cov(1, 0, roots(3)));
  await flush();
  h.setMax(1); // the fetcher says so itself once it has seen the 404
  await h.reply(0, { kind: "unsupported" });
  assert.deepEqual(h.sent.slice(1), [["r0"], ["r1"], ["r2"]]);
  assert.ok(roots(3).every((r) => h.q.state(r) === "fetching"));
});

test("an erasure answer landing mid-bundle: the dropped root's box is not kept", async () => {
  const h = bundleHarness();
  h.q.cover(cov(1, 0, ["a", "b"]));
  await flush();
  h.q.cover(cov(2, 0, ["b"]));
  await h.reply(0, allOk(["a", "b"]));
  assert.equal(h.q.box("a"), undefined);
  assert.equal(h.q.state("a"), undefined);
  assert.ok(h.q.box("b"));
  assert.deepEqual(h.q.progress(), { total: 1, ready: 1, waiting: 0, retrying: 0, missing: 0, unreadable: 0 });
});

test("a bundle arriving on a stale answer keeps nothing, and goes again once a fresh one comes", async () => {
  const h = bundleHarness();
  h.q.cover(cov(1, 0, ["a", "b"]));
  await flush();
  await h.c.advance(COVERAGE_STALE_MS);
  await h.reply(0, allOk(["a", "b"]));
  assert.equal(h.q.box("a"), undefined);
  assert.equal(h.q.state("a"), "queued");
  h.q.cover(cov(2, h.c.now(), ["a", "b"]));
  await flush();
  assert.deepEqual(h.sent[1], ["a", "b"]);
});

test("retries due together share one bundle", async () => {
  const h = bundleHarness();
  h.q.cover(cov(1, 0, ["a", "b", "c"]));
  await flush();
  await h.reply(0, itemsOf([["a", { kind: "unavailable" }], ["b", { kind: "unavailable" }], ["c", { kind: "ok", box: box("c") }]]));
  await h.c.advance(5_000 + RETRY_COALESCE_MS);
  assert.deepEqual(h.sent[1], ["a", "b"], "one bundle, not one request each");
});

test("a bundle's retries share one jitter, so they fall due together and go as one bundle", async () => {
  const draws = [0.9, 0.1, 0.5, 0.3];
  const h = bundleHarness(100, () => draws.shift() ?? 0);
  h.q.cover(cov(1, 0, ["a", "b", "c"]));
  await flush();
  await h.reply(0, itemsOf([["a", { kind: "unavailable" }], ["b", { kind: "unavailable" }], ["c", { kind: "unavailable" }]]));
  // One draw (0.9) for the bundle: 5 s x (1 - 0.225) = 3,875 ms for all three.
  await h.c.advance(3_875 + RETRY_COALESCE_MS);
  assert.deepEqual(h.sent[1], ["a", "b", "c"]);
});

test("a batch size that is not a number still sends one root at a time, never spins", async () => {
  const h = bundleHarness(Number.NaN);
  h.q.cover(cov(1, 0, ["a", "b"]));
  await flush();
  assert.deepEqual(h.sent, [["a"], ["b"]]);
});

test("with no readable budget, the self cap counts bundles", async () => {
  const h = bundleHarness(10);
  h.setAuto((r) => allOk(r));
  h.q.cover(cov(1, 0, roots(10 * (BATCH_SELF_CAP_PER_MINUTE + 5))));
  for (let i = 0; i < 60; i++) await flush();
  assert.equal(h.sent.length, BATCH_SELF_CAP_PER_MINUTE);
  await h.c.advance(60_000);
  for (let i = 0; i < 20; i++) await flush();
  assert.equal(h.sent.length, BATCH_SELF_CAP_PER_MINUTE + 5);
});
