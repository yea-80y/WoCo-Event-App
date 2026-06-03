/**
 * POD gate evaluator — the trust-light half of the holdings primitive.
 *
 * Covers count, first-N (slot range), time window, manifest mismatch
 * (fail-closed), and the default minCount.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePodGate } from "../../src/pod/gate.js";
import type { PodHolding, PodGateRule } from "../../src/pod/types.js";

const REF = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);

function holding(slots: number[], manifestRef = REF): PodHolding {
  return { manifestRef, count: slots.length, slots };
}

test("default minCount = 1: any holding passes, empty fails", () => {
  const rule: PodGateRule = { manifestRef: REF };
  assert.equal(evaluatePodGate(holding([3]), rule), true);
  assert.equal(evaluatePodGate(holding([]), rule), false);
});

test("minCount threshold", () => {
  const rule: PodGateRule = { manifestRef: REF, minCount: 3 };
  assert.equal(evaluatePodGate(holding([0, 1]), rule), false);
  assert.equal(evaluatePodGate(holding([0, 1, 2]), rule), true);
  assert.equal(evaluatePodGate(holding([0, 1, 2, 9]), rule), true);
});

test("first-N gate (maxSlotExclusive): only early slots count", () => {
  const rule: PodGateRule = { manifestRef: REF, maxSlotExclusive: 100 };
  assert.equal(evaluatePodGate(holding([99]), rule), true); // 99 < 100
  assert.equal(evaluatePodGate(holding([100]), rule), false); // 100 not < 100
  assert.equal(evaluatePodGate(holding([250, 7]), rule), true); // 7 qualifies
});

test("first-N combined with minCount", () => {
  const rule: PodGateRule = { manifestRef: REF, maxSlotExclusive: 10, minCount: 2 };
  assert.equal(evaluatePodGate(holding([1, 2, 50]), rule), true); // 1,2 qualify
  assert.equal(evaluatePodGate(holding([1, 50, 60]), rule), false); // only 1 qualifies
});

test("time window: passes only within [notBefore, notAfter]", () => {
  const rule: PodGateRule = { manifestRef: REF, notBefore: 1000, notAfter: 2000 };
  assert.equal(evaluatePodGate(holding([1]), rule, 500), false);
  assert.equal(evaluatePodGate(holding([1]), rule, 1500), true);
  assert.equal(evaluatePodGate(holding([1]), rule, 2500), false);
  // boundaries inclusive
  assert.equal(evaluatePodGate(holding([1]), rule, 1000), true);
  assert.equal(evaluatePodGate(holding([1]), rule, 2000), true);
});

test("fails closed on manifestRef mismatch (case-insensitive match)", () => {
  const rule: PodGateRule = { manifestRef: REF };
  assert.equal(evaluatePodGate(holding([1], OTHER), rule), false);
  // same ref, different case → still passes
  assert.equal(evaluatePodGate(holding([1], REF.toUpperCase()), rule), true);
});
