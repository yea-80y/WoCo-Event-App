/**
 * Acceptance for the guardian reverse-index tombstones (#165).
 *
 * Two properties, both of which a plausible-looking edit breaks silently:
 *  1. AUTHZ — the guardian index is a public, poisonable convenience hint, so the
 *     ONLY thing stopping "clear" from being a way to break other people's account
 *     auto-find is that an entry must already point at the caller's own Kernel.
 *  2. ORDERING — the server's own status-doc guardian is the current auto-find
 *     pointer and the only one it can name without the client. An earlier cut
 *     appended it last and then sliced to the cap, so a full client list evicted
 *     precisely the guardian that mattered most.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RecoveryGuardianIndex } from "@woco/shared";
import {
  MAX_CLEAR_GUARDIANS,
  mayTombstone,
  selectTombstoneTargets,
} from "../src/lib/recovery/tombstone.js";

const KERNEL = "0x" + "ab".repeat(20);
const OTHER = "0x" + "cd".repeat(20);
const guardian = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const index = (over: Partial<RecoveryGuardianIndex> = {}): RecoveryGuardianIndex => ({
  kernelAddress: KERNEL,
  ...over,
});

// ── AUTHZ ──────────────────────────────────────────────────────────────────

test("an entry pointing at the caller's own Kernel may be tombstoned", () => {
  assert.equal(mayTombstone(index(), KERNEL), true);
});

test("an entry pointing at SOMEONE ELSE'S Kernel may not", () => {
  assert.equal(mayTombstone(index({ kernelAddress: OTHER }), KERNEL), false);
});

test("address case never decides authorisation", () => {
  assert.equal(mayTombstone(index({ kernelAddress: KERNEL.toUpperCase() }), KERNEL), true);
  assert.equal(mayTombstone(index(), KERNEL.toUpperCase()), true);
});

test("a missing or already-revoked entry is a no-op, not a write", () => {
  assert.equal(mayTombstone(null, KERNEL), false);
  assert.equal(mayTombstone(undefined, KERNEL), false);
  assert.equal(mayTombstone(index({ revoked: true }), KERNEL), false);
});

// ── ORDERING + BOUNDS ──────────────────────────────────────────────────────

test("the status-doc guardian is first, so a full client list cannot evict it", () => {
  const requested = Array.from({ length: MAX_CLEAR_GUARDIANS }, (_, i) => guardian(i + 1));
  const statusGuardian = guardian(0xbeef);
  const targets = selectTombstoneTargets({ requested, statusGuardian });

  assert.equal(targets[0], statusGuardian.toLowerCase());
  assert.ok(targets.includes(statusGuardian.toLowerCase()), "the current auto-find pointer must survive");
  assert.equal(targets.length, MAX_CLEAR_GUARDIANS + 1, "the client's full quota still fits alongside it");
});

test("targets are de-duplicated and lowercased", () => {
  const g = guardian(7);
  const targets = selectTombstoneTargets({
    requested: [g.toUpperCase(), g, g.toLowerCase()],
    statusGuardian: g,
  });
  assert.deepEqual(targets, [g.toLowerCase()]);
});

test("no status guardian is fine — the client list stands alone", () => {
  const targets = selectTombstoneTargets({ requested: [guardian(1), guardian(2)] });
  assert.deepEqual(targets, [guardian(1), guardian(2)]);
});

test("the result is bounded even if the caller ignores the request cap", () => {
  const requested = Array.from({ length: 500 }, (_, i) => guardian(i + 1));
  const targets = selectTombstoneTargets({ requested, statusGuardian: guardian(0xbeef) });
  assert.equal(targets.length, MAX_CLEAR_GUARDIANS + 1);
});
