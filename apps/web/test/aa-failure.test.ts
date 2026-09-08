/**
 * Classifying an account-abstraction failure (#487, #491).
 *
 * The recovery screens replace the bundler's own words with "temporarily
 * unavailable" when — and only when — the failure came from the 4337 layer.
 * Misclassify it and a user whose wallet simply rejected a prompt is told the
 * platform is down and to come back later, over an error only they could fix.
 *
 * These cases came over with `isAccountAbstractionFailure` when #501 deleted the
 * gasless mint rail it used to share a module with; the classifier is unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccountAbstractionFailure } from "../src/lib/auth/aa-failure.js";

test("an EntryPoint AA code is an account-abstraction failure", () => {
  assert.equal(isAccountAbstractionFailure(new Error("AA21 didn't pay prefund")), true);
  assert.equal(isAccountAbstractionFailure(new Error("UserOperation reverted")), true);
  assert.equal(isAccountAbstractionFailure(new Error("paymaster rejected")), true);
});

test("a hex blob that happens to contain 'aa' is NOT one", () => {
  // The #487 nit: "AA" lowercased and substring-matched hits any tx hash or
  // address with those two characters in it.
  assert.equal(isAccountAbstractionFailure(new Error("execution reverted: 0x8aa3...aa91")), false);
});

test("the code is anchored: two digits, uppercase, on a word boundary", () => {
  assert.equal(isAccountAbstractionFailure(new Error("AAA")), false);
  assert.equal(isAccountAbstractionFailure(new Error("aa33")), false);
  assert.equal(isAccountAbstractionFailure(new Error("label already taken")), false);
});

test("a non-Error value is classified, never thrown over", () => {
  assert.equal(isAccountAbstractionFailure("AA33 reverted"), true);
  assert.equal(isAccountAbstractionFailure(undefined), false);
  assert.equal(isAccountAbstractionFailure(null), false);
});
