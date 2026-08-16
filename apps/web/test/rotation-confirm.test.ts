/**
 * Post-rotation confirm judgement (#236).
 *
 * The property pinned here is the ceremony's absent-vs-unknown discipline at
 * its highest-stakes site: after a SUCCESSFUL rotation receipt, only an
 * ANSWERED read may produce "the recovery didn't take effect" (the message
 * telling a user to keep a sign-in that may be dead), and an errored read must
 * stay retryable and end, at worst, in "couldn't confirm". Pinning also
 * changes what a non-answer means — block state is immutable, so a pinned
 * answer is final, while an unpinned non-match must keep the loop alive
 * (propagation can still turn it into a match).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeRotationRead, rotationReadIsFinal } from "../src/lib/auth/rotation-confirm.js";

const NEW_OWNER = "0xAaAaAAAAaaaAAaAAaaaaAAaaaaAaaaAaAaaAaAaA";
const OLD_OWNER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("the new owner, whatever the casing, confirms", () => {
  assert.equal(judgeRotationRead(NEW_OWNER.toLowerCase(), NEW_OWNER), "confirmed");
  assert.equal(judgeRotationRead(NEW_OWNER.toLowerCase(), NEW_OWNER.toUpperCase().replace("0X", "0x")), "confirmed");
});

test("an answered foreign owner is the ONLY road to 'didn't take effect'", () => {
  assert.equal(judgeRotationRead(OLD_OWNER.toLowerCase(), NEW_OWNER), "not-effective");
});

test("null is an ANSWER (no owner) — definitive, not silence", () => {
  assert.equal(judgeRotationRead(null, NEW_OWNER), "not-effective");
});

test("an errored read is unconfirmed — never grounds for 'nothing changed'", () => {
  assert.equal(judgeRotationRead("error", NEW_OWNER), "unconfirmed");
});

test("pinned: any answer is final; only errors are worth another attempt", () => {
  assert.equal(rotationReadIsFinal("confirmed", true), true);
  assert.equal(rotationReadIsFinal("not-effective", true), true);
  assert.equal(rotationReadIsFinal("unconfirmed", true), false);
});

test("unpinned: only a confirmed match stops the loop", () => {
  assert.equal(rotationReadIsFinal("confirmed", false), true);
  // At "latest" a non-match can still become a match once the rotation
  // propagates — stopping early would re-open the very lie #236 closes.
  assert.equal(rotationReadIsFinal("not-effective", false), false);
  assert.equal(rotationReadIsFinal("unconfirmed", false), false);
});
