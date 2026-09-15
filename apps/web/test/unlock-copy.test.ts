/**
 * The one sentence every screen uses for the unlock rule (#575). Pinned to the
 * owner's rule of 2026-09-14 — a ticket, your own Stripe verification, or a
 * confirmed invite — so a rewrite that drops a branch is caught here, not by a
 * member who was told the wrong thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { UNLOCK_RULE, unlocksWhen } from "../src/lib/attendee/gate/unlock-copy.js";

test("the rule names all three ways in", () => {
  assert.equal(
    UNLOCK_RULE,
    "once a ticket is in your account, or once you or someone you invited verifies with Stripe",
  );
});

test("singular and plural subjects both read as sentences", () => {
  assert.equal(unlocksWhen("Your name"), `Your name unlocks ${UNLOCK_RULE}.`);
  assert.equal(unlocksWhen("Your name, photo and bio", true), `Your name, photo and bio unlock ${UNLOCK_RULE}.`);
});
