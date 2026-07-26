/**
 * Per-series claim queue — the regression suite for the double-spend class of
 * bug that a decentralised backend cannot prevent any other way.
 *
 * Swarm has no atomic compare-and-swap: two concurrent claim requests for the
 * same series can each READ the same unclaimed slot and each WRITE a ticket
 * into it, double-assigning one edition (lost money + a duplicate ticket).
 * `queueSeriesClaim` is the ONLY thing standing between that race and
 * production — it serialises every claim for a given series so each one reads
 * the latest feed state before the next begins.
 *
 * These are the properties that guarantee is made of. They are impossible to
 * verify by clicking through the app (races don't reproduce by hand), which is
 * exactly why they belong in an automated test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { queueSeriesClaim } from "../src/routes/claims.js";

/** Flush pending microtasks + timers so queued work actually starts. */
const tick = () => new Promise((r) => setTimeout(r, 0));

test("same series: a claim cannot start until the previous one finishes (the double-spend guarantee)", async () => {
  const seriesId = "test-series-serialise";
  let firstEntered = false;
  let secondEntered = false;
  let releaseFirst!: () => void;

  // First claim enters and parks — as if mid read-modify-write of the slot table.
  const p1 = queueSeriesClaim(seriesId, async () => {
    firstEntered = true;
    await new Promise<void>((r) => (releaseFirst = r));
  });
  // Second claim for the SAME series is submitted immediately behind it.
  const p2 = queueSeriesClaim(seriesId, async () => {
    secondEntered = true;
  });

  await tick();
  // The first is in-flight; the second MUST still be blocked. If it had started,
  // it would be reading the same slot state the first hasn't finished writing.
  assert.equal(firstEntered, true, "first claim should be running");
  assert.equal(secondEntered, false, "second claim must wait behind the first");

  releaseFirst();
  await Promise.all([p1, p2]);
  assert.equal(secondEntered, true, "second claim runs once the first completes");
});

test("same series: never more than one claim in flight at a time", async () => {
  const seriesId = "test-series-no-overlap";
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  const run = (n: number) =>
    queueSeriesClaim(seriesId, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(n);
      await tick(); // hold the slot open across an await, where overlap would show
      active--;
      return n;
    });

  const results = await Promise.all([run(1), run(2), run(3), run(4), run(5)]);

  assert.equal(maxActive, 1, "claims for one series must never overlap");
  assert.deepEqual(order, [1, 2, 3, 4, 5], "claims run in submission order");
  assert.deepEqual(results, [1, 2, 3, 4, 5], "each caller gets its own result");
});

test("different series run in parallel (one busy event must not block another)", async () => {
  let aEntered = false;
  let bEntered = false;
  let releaseA!: () => void;
  let releaseB!: () => void;

  const pA = queueSeriesClaim("test-series-A", async () => {
    aEntered = true;
    await new Promise<void>((r) => (releaseA = r));
  });
  const pB = queueSeriesClaim("test-series-B", async () => {
    bEntered = true;
    await new Promise<void>((r) => (releaseB = r));
  });

  await tick();
  // Both are parked simultaneously → the queue is per-series, not global.
  assert.equal(aEntered, true, "series A entered");
  assert.equal(bEntered, true, "series B entered while A is still in flight");

  releaseA();
  releaseB();
  await Promise.all([pA, pB]);
});

test("a failed claim does not poison the queue — later claims on the same series still run", async () => {
  const seriesId = "test-series-error-isolation";

  // A claim that throws (e.g. "No tickets available") must not break the chain
  // for the next buyer. This is what the error-swallowing tail in
  // queueSeriesClaim guards; without it, one failure would wedge the series.
  await assert.rejects(
    queueSeriesClaim(seriesId, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  let ranAfterFailure = false;
  const result = await queueSeriesClaim(seriesId, async () => {
    ranAfterFailure = true;
    return "ok";
  });

  assert.equal(ranAfterFailure, true, "queue recovers after a failed claim");
  assert.equal(result, "ok");
});
