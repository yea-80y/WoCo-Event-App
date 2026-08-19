/**
 * The probe counter, which exists because reasoning about latency failed.
 *
 * Four rounds of "the tap no longer reads" were reported from stack traces and
 * code inspection. One was wrong — a `knownVersion` dropped silently by a
 * spread — and only a browser trace caught it. A probe count per action would
 * have caught it immediately, so the counter itself is worth pinning: an
 * instrument that miscounts is worse than none, because it ends arguments.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countProbe,
  probeCounts,
  resetProbeCounts,
  probeTotals,
  measured,
} from "../src/lib/swarm/probe-stats.js";

test("counts each outcome separately, because a miss is not a hit", () => {
  // The whole point: a miss is a bee network search for a chunk that does not
  // exist — seconds — while a hit is a cheap read. Two actions with the same
  // request count can differ by an order of magnitude.
  resetProbeCounts();
  countProbe("gatewayHit");
  countProbe("gatewayMiss");
  countProbe("gatewayMiss");
  countProbe("serverMiss");
  assert.deepEqual(probeCounts(), {
    gatewayHit: 1,
    gatewayMiss: 2,
    serverHit: 0,
    serverMiss: 1,
  });
});

test("totals separate misses from the overall count", () => {
  const t = probeTotals({ gatewayHit: 3, gatewayMiss: 2, serverHit: 1, serverMiss: 4 });
  assert.equal(t.probes, 10);
  assert.equal(t.misses, 6);
});

test("probeCounts returns a copy, so a caller cannot corrupt the running total", () => {
  resetProbeCounts();
  countProbe("gatewayHit");
  const snapshot = probeCounts();
  snapshot.gatewayHit = 999;
  assert.equal(probeCounts().gatewayHit, 1);
});

test("measured returns the action's own result untouched", async () => {
  // Instrumentation that alters what it measures is worse than none.
  const value = await measured("test", async () => ({ ok: true, n: 42 }));
  assert.deepEqual(value, { ok: true, n: 42 });
});

test("measured propagates a throw rather than swallowing it", async () => {
  await assert.rejects(
    () => measured("test", async () => { throw new Error("boom"); }),
    /boom/,
  );
});
