/**
 * An open scanner reloads into a newer version by itself (2026-10-14: the owner's
 * phone had the new version installed and active while the open tab ran the old
 * code until reloaded by hand). It reloads only when the door is quiet: never
 * during a claim, a scan or a pass setup, and never while a verdict card is up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canApplyUpdate, UPDATE_QUIET_MS, type UpdateMoment } from "../src/lib/scanner/update-policy.js";

function moment(over: Partial<UpdateMoment> = {}): UpdateMoment {
  return { phase: "ready", claimInFlight: false, busy: false, sinceLastScanMs: UPDATE_QUIET_MS, ...over };
}

test("a quiet scanner reloads into the new version", () => {
  assert.equal(canApplyUpdate(moment()), true);
  assert.equal(canApplyUpdate(moment({ phase: "unprovisioned" })), true);
  assert.equal(canApplyUpdate(moment({ phase: "loading" })), true);
});

test("never during a claim, a scan, or a pass setup", () => {
  assert.equal(canApplyUpdate(moment({ claimInFlight: true })), false, "staff are waiting for the answer");
  assert.equal(canApplyUpdate(moment({ busy: true })), false, "a scan or new-ticket lookup is running");
  assert.equal(canApplyUpdate(moment({ phase: "provisioning" })), false, "the pack download would be cut off");
});

test("never while the last verdict card can still be on screen", () => {
  assert.equal(canApplyUpdate(moment({ sinceLastScanMs: UPDATE_QUIET_MS - 1 })), false);
  assert.ok(UPDATE_QUIET_MS > 5_000, "longer than the longest verdict card (COULDN'T CONFIRM, 5 s)");
});
