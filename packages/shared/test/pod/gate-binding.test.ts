/**
 * verifyPodGateBinding — the write-boundary anchor for CHAIN gates (PR 1,
 * #444 audit).
 *
 * This pure comparator is the ONLY place a wrong-badge substitution on a chain
 * gate is ever caught: `validatePodGate` (server gate-check.ts) delegates to
 * it with the on-chain `events[onChainEventId].manifestRef`, and enforcement
 * (`getOnChainHolding`) deliberately does not re-check the binding — checking
 * once is sound only because the gate is then stored in a platform-signed
 * feed. Until this file, the comparator had NO direct test: gate.test.ts
 * covers the holdings evaluator's manifestRef match, which moves together
 * with nothing here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { verifyPodGateBinding } from "../../src/pod/gate.js";

const REF = "0x" + "ab".repeat(32);
const OTHER = "0x" + "cd".repeat(32);
const EVENT_ID = "0x" + "11".repeat(32);

const gate = (over: Record<string, unknown> = {}) => ({
  manifestRef: REF,
  onChainEventId: EVENT_ID,
  chainId: 421614,
  ...over,
});

test("ANCHOR: on-chain manifestRef mismatch is refused", () => {
  const r = verifyPodGateBinding(gate(), OTHER);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /does not match the on-chain event commitment/);
});

test("ANCHOR: an unregistered event (null on-chain ref) is refused, not waved through", () => {
  const r = verifyPodGateBinding(gate(), null);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /unregistered/);
});

test("a matching commitment passes, case-insensitively", () => {
  assert.equal(verifyPodGateBinding(gate(), REF).ok, true);
  assert.equal(verifyPodGateBinding(gate(), REF.toUpperCase()).ok, true);
  assert.equal(verifyPodGateBinding(gate({ manifestRef: REF.toUpperCase() }), REF).ok, true);
});

test("missing coordinates are refused before any comparison", () => {
  assert.equal(verifyPodGateBinding(gate({ onChainEventId: undefined }), REF).ok, false);
  assert.equal(verifyPodGateBinding(gate({ chainId: undefined }), REF).ok, false);
  assert.equal(
    verifyPodGateBinding({ manifestRef: "" } as never, REF).ok,
    false,
  );
});

test("a non-positive or fractional minCount is refused", () => {
  assert.equal(verifyPodGateBinding(gate({ minCount: 0 }), REF).ok, false);
  assert.equal(verifyPodGateBinding(gate({ minCount: -1 }), REF).ok, false);
  assert.equal(verifyPodGateBinding(gate({ minCount: 1.5 }), REF).ok, false);
  assert.equal(verifyPodGateBinding(gate({ minCount: 2 }), REF).ok, true);
});
