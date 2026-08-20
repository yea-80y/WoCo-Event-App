/**
 * Issuance planning — the part of a run that is arithmetic, and therefore the
 * part that can be tested without a gateway.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planCertIssuance } from "../../src/pod-cert/issue-plan.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

test("holders the log already carries are skipped, not re-signed", () => {
  // What makes a crashed or double-clicked run safe to repeat.
  const plan = planCertIssuance({ requested: [A, B, C], existingHolders: [B] });
  assert.ok(plan.ok);
  assert.deepEqual(plan.toIssue, [A, C]);
  assert.deepEqual(plan.alreadyHeld, [B]);
  assert.equal(plan.totalAfter, 3);
});

test("a repeated run after a full success issues nothing", () => {
  const plan = planCertIssuance({ requested: [A, B], existingHolders: [A, B] });
  assert.ok(plan.ok);
  assert.deepEqual(plan.toIssue, []);
  assert.deepEqual(plan.alreadyHeld, [A, B]);
});

test("the same holder twice in one request is one certificate", () => {
  const plan = planCertIssuance({ requested: [A, A, B], existingHolders: [] });
  assert.ok(plan.ok);
  assert.deepEqual(plan.toIssue, [A, B]);
});

test("request order is preserved", () => {
  const plan = planCertIssuance({ requested: [C, A, B], existingHolders: [] });
  assert.ok(plan.ok);
  assert.deepEqual(plan.toIssue, [C, A, B]);
});

test("the cap counts DISTINCT HOLDERS, so re-issuance never consumes supply", () => {
  // Counting certificates instead would let a holder who rotated keys eat
  // supply that was never granted to anyone new.
  const atCap = planCertIssuance({ requested: [A, B], existingHolders: [A], cap: 2 });
  assert.ok(atCap.ok, "A is already held, so this adds exactly one");
  assert.equal(atCap.totalAfter, 2);

  const over = planCertIssuance({ requested: [B, C], existingHolders: [A], cap: 2 });
  assert.ok(!over.ok);
  assert.match(over.error, /3 holders against a declared supply of 2 — 1 too many/);
});

test("the cap is refused before anything is signed", () => {
  // Nothing at any door enforces supply: over-issuance is only ever caught by
  // auditing the issuer's own log afterwards. This is the one moment it can be
  // explained to the issuer instead of discovered by a stranger.
  const over = planCertIssuance({ requested: [A, B, C], existingHolders: [], cap: 1 });
  assert.ok(!over.ok);
  assert.match(over.error, /too many/);
});

test("a malformed holder key stops the run rather than being dropped", () => {
  const bad = planCertIssuance({ requested: [A, "0x" + B], existingHolders: [] });
  assert.ok(!bad.ok);
  assert.match(bad.error, /not an ed25519 holder key/);

  assert.ok(!planCertIssuance({ requested: [A, ""], existingHolders: [] }).ok);
  assert.ok(!planCertIssuance({ requested: [A, B.toUpperCase()], existingHolders: [] }).ok);
});

test("an empty run is refused, and a nonsense cap with it", () => {
  assert.ok(!planCertIssuance({ requested: [], existingHolders: [] }).ok);
  assert.ok(!planCertIssuance({ requested: [A], existingHolders: [], cap: 0 }).ok);
  assert.ok(!planCertIssuance({ requested: [A], existingHolders: [], cap: 1.5 }).ok);
});

test("no cap given means no cap enforced", () => {
  const plan = planCertIssuance({ requested: [A, B, C], existingHolders: [] });
  assert.ok(plan.ok);
  assert.equal(plan.totalAfter, 3);
});
