/**
 * A paymaster refusal must not reach a user as bundler text (#489).
 *
 * Recovery setup and recovery itself are the only two flows left that need the
 * ACCOUNT's own signature, so they are the only two that go through ZeroDev —
 * and ZeroDev's sponsorship has a hard monthly cap. When it is hit, every
 * userOp is refused with an AA-shaped message. The three recovery screens used
 * to render `e.message` raw, so the user of a locked-out account read
 * "UserOperation reverted … AA33" at the worst possible moment.
 *
 * The other half is just as important: a real user error must NOT be swallowed
 * into a generic sentence. Those messages ("pick a different wallet…") are the
 * only thing telling the user what to do differently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRecoveryError } from "../src/lib/auth/recovery-errors.js";

const SETUP = "Recovery setup is temporarily unavailable — your account is fine, try again later";
const RECOVER = "Recovery is temporarily unavailable — try again later";

test("an AA failure becomes a sentence, and the sentence depends on the flow", () => {
  const aa = new Error("UserOperation reverted during simulation with reason: AA33 reverted");
  assert.equal(describeRecoveryError(aa, "setup"), SETUP);
  assert.equal(describeRecoveryError(aa, "recover"), RECOVER);
  // Setup has nothing on-chain to worry about and says so; recovery cannot
  // truthfully say "your account is fine" to someone locked out of it.
  assert.notEqual(SETUP, RECOVER);
});

test("the other account-abstraction shapes map too, not just the AA codes", () => {
  for (const msg of [
    "paymaster deposit too low",
    "sponsorUserOperation failed: 402",
    "bundler rejected the request",
  ]) {
    assert.equal(describeRecoveryError(new Error(msg), "setup"), SETUP, msg);
  }
});

test("a real user error passes through untouched", () => {
  const own = new Error("Pick a different wallet — your backup can't be a key that already controls this account.");
  assert.equal(describeRecoveryError(own, "setup"), own.message);
  assert.equal(describeRecoveryError(own, "recover"), own.message);
});

test("a message that merely contains hex is not mistaken for an AA failure", () => {
  // The #487 defect: a bare two-letter "aa" needle matched any tx hash or
  // address. A user error carrying one must still reach the user.
  const hexy = new Error("execution reverted: 0x8aa3c0ffee");
  assert.equal(describeRecoveryError(hexy, "recover"), hexy.message);
});

test("a non-Error throw falls back to the caller's own wording", () => {
  assert.equal(describeRecoveryError("boom", "setup", "Couldn't connect — please try again"), "Couldn't connect — please try again");
  // …and to a generic sentence when the caller gives none.
  assert.equal(describeRecoveryError({ nope: true }, "recover"), "Something went wrong — please try again");
});
