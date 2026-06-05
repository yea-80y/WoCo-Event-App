/**
 * POD gate evaluator — the trust-light half of the holdings primitive.
 *
 * Covers count, first-N (slot range), time window, manifest mismatch
 * (fail-closed), and the default minCount.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePodGate,
  evaluatePodGateGroup,
  computeGatePhase,
} from "../../src/pod/gate.js";
import type { PodHolding, PodGateRule, PodGate, PodGateGroup } from "../../src/pod/types.js";

const REF = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);

function holding(slots: number[], manifestRef = REF): PodHolding {
  return { manifestRef, count: slots.length, slots };
}

/** Minimal PodGate over a manifestRef (read-coordinates are irrelevant to the
 *  pure evaluator — it only inspects manifestRef/minCount/window fields). */
function gate(manifestRef = REF, extra: Partial<PodGate> = {}): PodGate {
  return { manifestRef, onChainEventId: "0x" + "11".repeat(32), chainId: 421614, ...extra };
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

// ---------------------------------------------------------------------------
// Group evaluator: any/all + window phases
// ---------------------------------------------------------------------------

test("group any/all over multiple gates", () => {
  const any: PodGateGroup = { mode: "any", gates: [gate(REF), gate(OTHER)] };
  const all: PodGateGroup = { mode: "all", gates: [gate(REF), gate(OTHER)] };
  // holds only REF
  assert.equal(evaluatePodGateGroup([holding([1], REF)], any), true);
  assert.equal(evaluatePodGateGroup([holding([1], REF)], all), false);
  // holds both
  const both = [holding([1], REF), holding([2], OTHER)];
  assert.equal(evaluatePodGateGroup(both, any), true);
  assert.equal(evaluatePodGateGroup(both, all), true);
  // holds neither
  assert.equal(evaluatePodGateGroup([], any), false);
});

test("empty group fails closed", () => {
  assert.equal(evaluatePodGateGroup([holding([1])], { mode: "any", gates: [] }), false);
});

test("window 'time': closed outside, holders-only inside", () => {
  const g: PodGateGroup = {
    mode: "any",
    gates: [gate(REF)],
    window: { kind: "time", notBefore: 1000, notAfter: 2000 },
  };
  // before window → closed (even a holder fails)
  assert.equal(evaluatePodGateGroup([holding([1])], g, { now: 500 }), false);
  // after window → closed
  assert.equal(evaluatePodGateGroup([holding([1])], g, { now: 2500 }), false);
  // inside window → holders-only: holder passes, non-holder fails
  assert.equal(evaluatePodGateGroup([holding([1])], g, { now: 1500 }), true);
  assert.equal(evaluatePodGateGroup([], g, { now: 1500 }), false);
  assert.equal(computeGatePhase(g.window, { now: 500 }), "closed");
  assert.equal(computeGatePhase(g.window, { now: 1500 }), "holders-only");
});

test("window 'firstN': holder-only early access, then open to all", () => {
  const g: PodGateGroup = { mode: "any", gates: [gate(REF)], window: { kind: "firstN", n: 100 } };
  // early phase (tierClaimed < n): holder passes, non-holder fails
  assert.equal(evaluatePodGateGroup([holding([1])], g, { tierClaimed: 50 }), true);
  assert.equal(evaluatePodGateGroup([], g, { tierClaimed: 50 }), false);
  // open phase (tierClaimed >= n): EVERYONE passes, holdings irrelevant
  assert.equal(evaluatePodGateGroup([], g, { tierClaimed: 100 }), true);
  assert.equal(evaluatePodGateGroup([], g, { tierClaimed: 250 }), true);
  // phase labels
  assert.equal(computeGatePhase(g.window, { tierClaimed: 99 }), "holders-only");
  assert.equal(computeGatePhase(g.window, { tierClaimed: 100 }), "open");
});

test("window 'firstN' fail-safe to holders-only when count unknown", () => {
  const g: PodGateGroup = { mode: "any", gates: [gate(REF)], window: { kind: "firstN", n: 100 } };
  assert.equal(computeGatePhase(g.window, {}), "holders-only");
  assert.equal(evaluatePodGateGroup([], g, {}), false); // non-holder cannot slip through
});

test("window 'reserved' is deferred: fail-safe holders-only (unenforced)", () => {
  const g: PodGateGroup = { mode: "any", gates: [gate(REF)], window: { kind: "reserved", reserved: 20 } };
  assert.equal(computeGatePhase(g.window, { tierClaimed: 5 }), "holders-only");
  assert.equal(evaluatePodGateGroup([holding([1])], g, { tierClaimed: 5 }), true);
  assert.equal(evaluatePodGateGroup([], g, { tierClaimed: 5 }), false);
});

test("default window (undefined) is always holders-only", () => {
  assert.equal(computeGatePhase(undefined), "holders-only");
  const g: PodGateGroup = { mode: "any", gates: [gate(REF)] };
  assert.equal(evaluatePodGateGroup([holding([1])], g), true);
  assert.equal(evaluatePodGateGroup([], g), false);
});
