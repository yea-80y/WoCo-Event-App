/**
 * The recovery owner-collision guard.
 *
 * Every test names the property it pins, and asserts the REASON as well as the
 * verdict where the reason is the point — a test that only checks "blocked" would
 * pass for the wrong rule and survive a mutant that blocks everything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideOwnerCollision,
  type OwnerCollisionEvidence,
} from "../src/lib/auth/recovery-owner-collision.js";

const EOA = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const TARGET = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const OTHER = "0xCCCCccccCCCCccccCCCCccccCCCCccccCCCCcccc";

/** A credential with no prior life, on a readable chain: the allow case. */
function clean(over: Partial<OwnerCollisionEvidence> = {}): OwnerCollisionEvidence {
  return {
    newOwnerEoa: EOA,
    targetKernel: TARGET,
    existingBinding: undefined,
    podSeedPresent: false,
    cachedKernel: null,
    counterfactualOwner: null,
    ...over,
  };
}

test("a credential with no prior life is allowed", () => {
  const v = decideOwnerCollision(clean());
  assert.equal(v.status, "allow");
});

test("re-recovering the SAME account onto the SAME credential is allowed — the repair path", () => {
  // The slots this would overwrite already belong to this account, so there is no
  // collision. It must stay open: it is how a user recovers from a ceremony that
  // died partway. Deliberately combined with evidence that would otherwise block,
  // to prove the repair rule is checked FIRST rather than merely reachable.
  const v = decideOwnerCollision(
    clean({ existingBinding: TARGET, podSeedPresent: true, counterfactualOwner: EOA }),
  );
  assert.equal(v.status, "allow");
  assert.match(v.reason, /repair/);
});

test("a credential already bound to a DIFFERENT recovered account is blocked", () => {
  const v = decideOwnerCollision(clean({ existingBinding: OTHER }));
  assert.equal(v.status, "block");
  assert.match(v.reason, /different recovered account/);
});

test("a credential whose own Kernel is deployed and owned by it is blocked", () => {
  const v = decideOwnerCollision(clean({ counterfactualOwner: EOA }));
  assert.equal(v.status, "block");
  assert.match(v.reason, /counterfactual/);
});

test("a Kernel owned by SOMEONE ELSE does not block — it is not this credential's account", () => {
  // The counterfactual is a pure function of the EOA, so a different owner means
  // the account was recovered away from it. That is not a collision for this
  // credential, and blocking on it would refuse a legitimate recovery.
  const v = decideOwnerCollision(clean({ counterfactualOwner: OTHER }));
  assert.equal(v.status, "allow");
});

test("a POD seed already stored under the credential is blocked", () => {
  const v = decideOwnerCollision(clean({ podSeedPresent: true }));
  assert.equal(v.status, "block");
  assert.match(v.reason, /POD seed/);
});

test("a FAILED local seed read blocks, and is not read as an empty slot", () => {
  // The distinction this whole guard exists for: `null` means the read failed.
  // Treating it as "absent" would destroy a seed that cannot be re-derived.
  const v = decideOwnerCollision(clean({ podSeedPresent: null }));
  assert.equal(v.status, "block");
  assert.match(v.reason, /could not read local/);
});

test("a cached Kernel for a different account blocks", () => {
  const v = decideOwnerCollision(clean({ cachedKernel: OTHER }));
  assert.equal(v.status, "block");
  assert.match(v.reason, /cached a different account/);
});

test("an unreadable chain with clean local state blocks — absence is unproven both ways", () => {
  const v = decideOwnerCollision(clean({ counterfactualOwner: "error" }));
  assert.equal(v.status, "block");
  assert.match(v.reason, /unreadable/);
});

test("'couldn't confirm' and 'already taken' are DIFFERENT messages", () => {
  // A user told "already taken" reasonably gives up on that credential; one told
  // "couldn't confirm" should retry. Collapsing them would make the recoverable
  // case indistinguishable from the terminal one — the mistake #226 and #228 are
  // both about.
  const taken = decideOwnerCollision(clean({ counterfactualOwner: EOA }));
  const unsure = decideOwnerCollision(clean({ counterfactualOwner: "error" }));
  assert.equal(taken.status, "block");
  assert.equal(unsure.status, "block");
  assert.notEqual(taken.userMessage, unsure.userMessage);
  assert.match(unsure.userMessage, /couldn't confirm/i);
});

test("address comparisons are case-insensitive", () => {
  // Checksummed vs lowercased spellings of one address must not read as two
  // different accounts — that would silently turn the repair path into a block.
  const v = decideOwnerCollision(clean({ existingBinding: TARGET.toLowerCase() }));
  assert.equal(v.status, "allow");
  assert.match(v.reason, /repair/);
});

test("a missing address blocks rather than defaulting to allow", () => {
  const v = decideOwnerCollision(clean({ newOwnerEoa: "" }));
  assert.equal(v.status, "block");
});
