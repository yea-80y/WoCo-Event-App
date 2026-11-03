/**
 * The audience sync's browser read of one event (#201, sync-orders.ts), on the REAL
 * BrowserOrders and DetailQueue over a fake chain, server answer, gateway and clock.
 *
 * The rules: the server's full read only for a ledger the browser cannot read (never
 * after a failed read); a busy foreground reader goes first; the read ends when
 * nothing is queued or fetching, with a grace for retries and a hard cap; a 404 or a
 * non-order is `lost` (final), a retry left over is not; nothing is handed on under an
 * erasure answer older than COVERAGE_STALE_MS; the queue is stopped and the verifier
 * disposed on every way out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrdersSeriesLedger, OrdersStatus } from "@woco/shared";
import { BrowserOrders, type BrowserOrdersDeps, type SlotRead } from "../src/lib/creator/dashboard/browser-orders.js";
import { COVERAGE_STALE_MS, DetailQueue, type FetchResult } from "../src/lib/creator/dashboard/detail-queue.js";
import { DRAIN_CAP_MS, DRAIN_GRACE_MS, readEventOrders, type SyncOrdersDeps } from "../src/lib/creator/audience/sync-orders.js";
import type { SyncOrder } from "../src/lib/creator/audience/audience-sync.js";

const LEDGER: OrdersSeriesLedger = { chainId: 42161, contract: "0x" + "c".repeat(40), version: "ledger", onChainEventId: "0x" + "e".repeat(64) };
const root = (c: string) => c.repeat(64);
const slot = (c: string): SlotRead => ({ owner: "0x1", orderRef: "0x" + root(c) });
const box = (tag: string) => ({ v: 2, enc: `enc-${tag}`, ct: `ct-${tag}` }) as never;
const flush = () => new Promise<void>((r) => setImmediate(r));

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
        for (let i = 0; i < 5; i++) await flush();
      }
      now = end;
      for (let i = 0; i < 5; i++) await flush();
    },
  };
}

type Answer = FetchResult | "hang";

function harness(slots: SlotRead[]) {
  const c = clock();
  const log: string[] = [];
  const st = {
    slots,
    erased: [] as string[],
    failStatus: false,
    failNext: false,
    canRead: true,
    busy: false,
    /** What the gateway says for a root; default: its box. */
    answer: (r: string): Answer => ({ kind: "ok", box: box(r.slice(0, 1)) }),
  };
  const readerDeps: BrowserOrdersDeps = {
    async status(roots, opts) {
      log.push(`status:${roots.length}:${opts?.establish}`);
      if (st.failStatus) throw new Error("status down");
      const answer: OrdersStatus = {
        eventId: "e1",
        eventTitle: "Gig",
        series: [{ seriesId: "s1", seriesName: "GA", ledger: LEDGER, paidAt: {}, refund: {} }],
        erased: [...st.erased],
        held: [],
      };
      return answer;
    },
    async nextSlots(ledgers) {
      log.push("next");
      if (st.failNext) throw new Error("rpc down");
      return ledgers.map(() => st.slots.length);
    },
    async slots(_l, from, to) {
      return st.slots.slice(from, to);
    },
  };
  const counts = { queues: 0, stopped: 0, disposed: 0, fetched: [] as string[] };
  let queue: DetailQueue | null = null;
  const deps: SyncOrdersDeps = {
    reader: new BrowserOrders(readerDeps, () => st.canRead, c.now),
    makeQueue(hooks) {
      counts.queues++;
      const q = new DetailQueue({
        maxBatch: () => 100,
        fetchBatch: (roots) => {
          counts.fetched.push(...roots);
          const answers = roots.map((r) => [r, st.answer(r)] as const);
          if (answers.some(([, a]) => a === "hang")) return new Promise(() => {});
          return Promise.resolve({ kind: "items", items: new Map(answers as Array<readonly [string, FetchResult]>) });
        },
        now: c.now,
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
        random: () => 0,
        wantCoverage: hooks.wantCoverage,
        onChange: hooks.onChange,
      });
      const stop = q.stop.bind(q);
      q.stop = () => {
        counts.stopped++;
        stop();
      };
      queue = q;
      return q;
    },
    async serverRead() {
      log.push("server");
      return [];
    },
    foregroundBusy: () => st.busy,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    dispose: () => void counts.disposed++,
  };
  /**
   * Starts the read and lets it reach its first wait at time 0 (the clock must not move
   * before it has); `out()` is its result so far (undefined while running).
   */
  const start = async () => {
    let out: { rows?: SyncOrder[]; err?: unknown } | undefined;
    readEventOrders(deps).then(
      (rows) => (out = { rows }),
      (err) => (out = { err }),
    );
    for (let i = 0; i < 5; i++) await flush();
    return () => out;
  };
  return { c, log, st, deps, counts, start, queue: () => queue };
}

test("every row comes back with its box; the queue is stopped and the verifier disposed once", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b"), slot("a")]);
  const out = await h.start();
  await h.c.advance(10);
  const res = out();
  assert.ok(res?.rows, String(res?.err));
  assert.equal(res.rows.length, 3);
  assert.ok(res.rows.every((o) => o.encryptedOrder && !o.lost));
  assert.equal(res.rows[0].encryptedOrder, res.rows[2].encryptedOrder, "a sale's slots share one box object");
  assert.deepEqual(h.counts.fetched.sort(), [root("a"), root("b")], "each root fetched once");
  assert.equal(h.counts.stopped, 1);
  assert.equal(h.counts.disposed, 1);
  assert.ok(h.log.every((l) => !l.startsWith("status:") || l.endsWith(":false")), "every answer asked without starting a sign-in");
  assert.ok(!h.log.includes("server"));
});

test("a ledger the browser cannot read is read by the server, and nothing else is", { timeout: 5000 }, async () => {
  const h = harness([slot("a")]);
  h.st.canRead = false;
  const out = await h.start();
  await h.c.advance(10);
  assert.ok(out()?.rows);
  assert.ok(h.log.includes("server"));
  assert.equal(h.counts.queues, 0, "no queue, no gateway read");
  assert.equal(h.counts.disposed, 1);
});

test("a read that fails - the chain or the answer - fails the event and never falls back to the server", { timeout: 5000 }, async () => {
  for (const fail of ["failNext", "failStatus"] as const) {
    const h = harness([slot("a")]);
    h.st[fail] = true;
    const out = await h.start();
    await h.c.advance(10);
    assert.ok(out()?.err, fail);
    assert.ok(!h.log.includes("server"), fail);
    assert.equal(h.counts.disposed, 1, fail);
  }
});

test("a busy foreground reader goes first: no chain read until it is done, and the cap still applies", { timeout: 5000 }, async () => {
  const h = harness([slot("a")]);
  h.st.busy = true;
  const out = await h.start();
  await h.c.advance(30_000);
  assert.equal(out(), undefined);
  assert.ok(!h.log.includes("next"), "no chain read while the dashboard reads");
  h.st.busy = false;
  await h.c.advance(1_000);
  assert.ok(out()?.rows);

  const stuck = harness([slot("a")]);
  stuck.st.busy = true;
  const out2 = await stuck.start();
  await stuck.c.advance(DRAIN_CAP_MS);
  assert.ok(out2()?.err, "held past the cap: the event fails this run");
  assert.ok(!stuck.log.includes("next"));
  assert.equal(stuck.counts.disposed, 1);
});

test("the read ends only when nothing is queued or being fetched", { timeout: 5000 }, async () => {
  const h = harness([slot("a")]);
  h.st.answer = () => "hang";
  const out = await h.start();
  await h.c.advance(DRAIN_GRACE_MS + 60_000);
  assert.equal(out(), undefined, "a fetch in flight is not given up on by the grace");
});

test("roots still retrying get the grace, then come back without a box and NOT lost: read again next run", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b")]);
  h.st.answer = (r) => (r === root("b") ? { kind: "unavailable" } : { kind: "ok", box: box("a") });
  const out = await h.start();
  await h.c.advance(DRAIN_GRACE_MS - 1_000);
  assert.equal(out(), undefined, "still within the grace");
  await h.c.advance(5_000);
  const rows = out()?.rows;
  assert.ok(rows, out() ? String(out()!.err) : "still running");
  const b = rows.find((o) => o.edition === 2)!;
  assert.equal(b.encryptedOrder, undefined);
  assert.equal(b.lost, undefined);
  assert.equal(h.counts.stopped, 1);
});

test("a 404 or a non-order is lost, under its root, on every slot of that sale", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b"), slot("a"), slot("d")]);
  h.st.answer = (r) => (r === root("a") ? { kind: "missing" } : r === root("b") ? { kind: "unreadable" } : { kind: "ok", box: box("d") });
  const out = await h.start();
  await h.c.advance(10);
  const rows = out()?.rows;
  assert.ok(rows);
  assert.deepEqual(
    rows.map((o) => o.lost ?? null),
    [root("a"), root("b"), root("a"), null],
  );
  assert.ok(rows[3].encryptedOrder);
});

test("the cap ends a read that never drains: what did not arrive comes back without a box, not lost", { timeout: 5000 }, async () => {
  const h = harness([slot("a")]);
  h.st.answer = () => "hang";
  const out = await h.start();
  await h.c.advance(DRAIN_CAP_MS);
  const res = out();
  assert.ok(res, "ended at the cap");
  // The answer is minutes old by then: refreshed first (it succeeds here).
  assert.ok(res.rows, String(res.err));
  assert.equal(res.rows[0].encryptedOrder, undefined);
  assert.equal(res.rows[0].lost, undefined);
  assert.equal(h.counts.stopped, 1);
});

test("an answer older than COVERAGE_STALE_MS is replaced before anything is handed on; a root it erases loses its box", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b")]);
  // a arrives at once; b keeps failing, so the read runs on; the server's answer fails meanwhile.
  h.st.answer = (r) => (r === root("b") ? { kind: "unavailable" } : { kind: "ok", box: box("a") });
  const out = await h.start();
  await h.c.advance(10);
  assert.ok(h.queue()!.box(root("a")), "a's box arrived under the first answer");
  h.st.failStatus = true;
  await h.c.advance(COVERAGE_STALE_MS + 1_000);
  // Erased since, and the server answers again by the end.
  h.st.erased = [root("a")];
  h.st.failStatus = false;
  const before = h.log.filter((l) => l.startsWith("status:")).length;
  await h.c.advance(DRAIN_CAP_MS);
  const rows = out()?.rows;
  assert.ok(rows);
  assert.ok(h.log.filter((l) => l.startsWith("status:")).length > before, "a fresh answer was read");
  const a = rows.find((o) => o.edition === 1)!;
  assert.equal(a.erased, true);
  assert.equal(a.encryptedOrder, undefined, "the box that arrived under the old answer is not handed on");
});

test("no fresh answer at the end: the event fails this run, nothing handed on", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b")]);
  h.st.answer = (r) => (r === root("b") ? { kind: "unavailable" } : { kind: "ok", box: box("a") });
  const out = await h.start();
  await h.c.advance(10);
  h.st.failStatus = true;
  await h.c.advance(DRAIN_CAP_MS);
  assert.ok(out()?.err);
  assert.equal(h.counts.stopped, 1);
  assert.equal(h.counts.disposed, 1);
});

test("it says how many of the event's orders have arrived, ending at all of them", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b"), slot("c")]);
  const told: string[] = [];
  h.deps.onProgress = (done, total) => void told.push(`${done}/${total}`);
  const out = await h.start();
  await h.c.advance(10);
  assert.ok(out()?.rows);
  assert.equal(told.at(-1), "3/3");

  // One order still retrying while the read looks again every second: told once, not per look.
  const slow = harness([slot("a"), slot("b")]);
  slow.st.answer = (r) => (r === root("b") ? { kind: "unavailable" } : { kind: "ok", box: box("a") });
  const seen: string[] = [];
  slow.deps.onProgress = (done, total) => void seen.push(`${done}/${total}`);
  await slow.start();
  await slow.c.advance(5_000);
  assert.deepEqual(seen, ["0/2", "1/2"], "told only when it changes");
  h.deps.onProgress = () => {
    throw new Error("listener broke");
  };
  const again = harness([slot("a")]);
  again.deps.onProgress = h.deps.onProgress;
  const out2 = await again.start();
  await again.c.advance(10);
  assert.ok(out2()?.rows, "a listener that throws never stops the read");
});

test("a sold slot with no order reference is lost (final), one per slot, not read again", { timeout: 5000 }, async () => {
  const none: SlotRead = { owner: "0x1", orderRef: "0x" + "0".repeat(64) };
  const h = harness([slot("a"), none, none]);
  const out = await h.start();
  await h.c.advance(10);
  const rows = out()?.rows;
  assert.ok(rows);
  assert.deepEqual(
    rows.map((o) => o.lost ?? null),
    [null, "slot:s1:2", "slot:s1:3"],
  );
});

test("an old answer the server will not replace ends the read early: the event fails, not at the cap", { timeout: 5000 }, async () => {
  const h = harness([slot("a"), slot("b")]);
  // Both wait behind a long gateway pause, and the server stops answering.
  h.st.answer = () => ({ kind: "limited", retryAfterMs: 5 * 60_000 });
  const out = await h.start();
  await h.c.advance(10);
  h.st.failStatus = true;
  await h.c.advance(5 * 60_000 + 3 * 60_000);
  const res = out();
  assert.ok(res?.err, "failed well before the 10-minute cap");
  assert.ok(h.c.now() < DRAIN_CAP_MS);
  assert.equal(h.counts.disposed, 1);

  // Control: one refusal (the queue's first ask, at 60 s), then answers again - the read goes on and finishes.
  const ok = harness([slot("a")]);
  let calls = 0;
  ok.st.answer = () => (++calls === 1 ? { kind: "limited", retryAfterMs: 5 * 60_000 } : { kind: "ok", box: box("a") });
  const out2 = await ok.start();
  await ok.c.advance(10);
  ok.st.failStatus = true;
  await ok.c.advance(61_000);
  assert.equal(ok.log.filter((l) => l.startsWith("status:")).length, 3, "exactly one refused ask so far");
  ok.st.failStatus = false;
  await ok.c.advance(5 * 60_000);
  assert.ok(out2()?.rows?.[0].encryptedOrder, "one refusal is not a stall");

  // Refusals that are not in a row (refused at 60 s, answered at 120 s, refused at 180 s) are
  // not a stall: the read is still going at 230 s. (A fetch in flight keeps the queue asking every minute.)
  const gaps = harness([slot("a")]);
  gaps.st.answer = () => "hang";
  const out3 = await gaps.start();
  for (const [until, fail] of [[61_000, true], [121_000, false], [181_000, true], [230_000, false]] as const) {
    gaps.st.failStatus = fail;
    await gaps.c.advance(until - gaps.c.now());
  }
  assert.equal(gaps.log.filter((l) => l.startsWith("status:")).length, 5, "asked at 0 (twice), 60, 120 and 180 s");
  assert.equal(out3(), undefined, "the count of refusals starts again after an answer");
});
