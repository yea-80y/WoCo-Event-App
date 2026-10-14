/**
 * A door pass that fails to set up keeps the phone on the provision screen with
 * a reason the door staff can act on. Before this, the scanner scrubbed the pass
 * from the address bar even on failure, told staff to reload, and the reload
 * reopened whatever event the phone held before - an expired test event, in the
 * case that found it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describePackFailure } from "../src/lib/scanner/pass-gate.js";

test("a revoked, expired, other-event or other-phone pass is dead: only a new pass helps", () => {
  for (const status of [401, 403, 409]) {
    const f = describePackFailure(status, { error: "Door pass expired" });
    assert.equal(f.kind, "dead", `status ${status}`);
    assert.equal(f.message, "Door pass expired");
  }
});

test("anything else can be retried with the same pass", () => {
  for (const status of [400, 404, 500, 503]) {
    assert.equal(describePackFailure(status, { error: "Failed to build check-in pack" }).kind, "error", `status ${status}`);
  }
});

test("a refusal with no readable reason still says what to do, and never to reload", () => {
  const f = describePackFailure(502, null);
  assert.equal(f.kind, "error");
  assert.match(f.message, /try again/);
  assert.doesNotMatch(f.message, /reload/i);
  assert.equal(describePackFailure(500, { error: 42 }).message, f.message.replace("502", "500"));
});
