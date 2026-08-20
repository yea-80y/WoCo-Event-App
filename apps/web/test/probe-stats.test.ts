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
  countGatewayMissStatus,
  gatewayMissStatuses,
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

test("a gateway miss is bucketed by the status that caused it", () => {
  // `gatewayMiss` alone bundles three causes that call for OPPOSITE fixes: a
  // whitelist 403, a genuine 404, and a bee 5xx under load. The 2026-08-20
  // browser re-run could not choose a fix without this split — and once split,
  // the answer was unambiguous (403:25 404:0 5xx:0).
  resetProbeCounts();
  countGatewayMissStatus(403);
  countGatewayMissStatus(403);
  countGatewayMissStatus(404);
  countGatewayMissStatus(500);
  countGatewayMissStatus(503);
  assert.deepEqual(gatewayMissStatuses(), { s403: 2, s404: 1, s5xx: 2, other: 0 });
});

test("a miss carrying no status is `other`, never guessed into a bucket", () => {
  // A client-side network exception has no HTTP status. Filing it under 403
  // would manufacture evidence for the very hypothesis the split exists to
  // test, which is worse than counting nothing.
  resetProbeCounts();
  countGatewayMissStatus(undefined);
  countGatewayMissStatus(302);
  assert.deepEqual(gatewayMissStatuses(), { s403: 0, s404: 0, s5xx: 0, other: 2 });
});

test("resetProbeCounts clears the status split too", () => {
  // It did not, at first. A counter that survives a reset reports the previous
  // action's misses as this one's — which is the same class of silent
  // miscounting this whole file exists to prevent.
  countGatewayMissStatus(403);
  resetProbeCounts();
  assert.deepEqual(gatewayMissStatuses(), { s403: 0, s404: 0, s5xx: 0, other: 0 });
});
