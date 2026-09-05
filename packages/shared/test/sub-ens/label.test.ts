/**
 * The one `.woco.eth` label validator, mirroring WoCoRegistrar._validLabel.
 *
 * It lives in shared because the client's prefilter used to be LOOSER than the
 * server's ("1–63 of [a-z0-9-]"), so a two-character typo reached
 * `/api/sub-ens/check`, came back `{ available: false }` with no owner, and the
 * resolver — right to refuse reading absence into a partial answer — told the
 * user "name is registered but its owner could not be read" about a label the
 * registrar could never have minted.
 *
 * What is pinned is the full rule set, so the two ends cannot drift again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { validateLabel } from "../../src/sub-ens/label.js";

test("a label the registrar would mint passes", () => {
  for (const label of ["abc", "a-b", "punkpub", "a1b", "a" + "1".repeat(62)]) {
    assert.equal(validateLabel(label), null, `${label} was refused`);
  }
});

test("the length bounds are 3 and 63 inclusive", () => {
  assert.equal(validateLabel("ab"), "label must be 3–63 characters");
  assert.equal(validateLabel("a".repeat(64)), "label must be 3–63 characters");
  assert.equal(validateLabel("a".repeat(63)), null);
});

test("a label must start and end alphanumeric", () => {
  assert.equal(validateLabel("-abc"), "label must start with a letter or digit");
  assert.equal(validateLabel("abc-"), "label must end with a letter or digit");
});

test("consecutive hyphens are refused", () => {
  assert.equal(validateLabel("a--b"), "label cannot contain consecutive hyphens");
});

test("the charset is a–z, 0–9 and hyphen — nothing else, and no uppercase", () => {
  assert.equal(validateLabel("a_b"), "label may only contain a–z, 0–9, and hyphens");
  assert.equal(validateLabel("Abc"), "label must start with a letter or digit");
  assert.equal(validateLabel("aBc"), "label may only contain a–z, 0–9, and hyphens");
  // Short AND uppercase: length is checked first, but it is still refused.
  assert.notEqual(validateLabel("A1"), null);
});
