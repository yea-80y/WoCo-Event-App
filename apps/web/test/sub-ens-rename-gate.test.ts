/**
 * The rename refusal has to land BEFORE the mint (#484).
 *
 * Binding a profile name is gated by a 30-day cooldown the client cannot see
 * unless it asks. Without this check the user mints `newname.woco.eth` on-chain
 * — irreversible, and it spends their per-recipient mint allowance — and only
 * then reads "name_change_cooldown". The order is the whole feature.
 *
 * The other property is the failure direction: an unanswered status opens the
 * picker. The server refuses the bind for real, so a flaky GET costs a wasted
 * attempt; a fail-closed gate would lock a user out of their own name over a
 * dropped request.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenRename, type ProfileNameStatus } from "../src/lib/sub-ens/rename.js";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const DAY = 86_400_000;

const status = (over: Partial<ProfileNameStatus>): ProfileNameStatus => ({
  label: "nabil",
  allowed: true,
  nextChangeAllowedAt: null,
  freeCorrectionUsed: false,
  ...over,
});

test("an allowed status opens the picker", () => {
  assert.deepEqual(canOpenRename(status({}), NOW), { open: true });
});

test("a live cooldown refuses, and hands back when it ends", () => {
  const at = NOW + 12 * DAY;
  const gate = canOpenRename(status({ allowed: false, nextChangeAllowedAt: at }), NOW);
  assert.equal(gate.open, false);
  assert.equal(gate.open === false && gate.retryAt, at);
});

test("a status whose wait has since elapsed opens — the timestamp is the fact", () => {
  // `allowed` was computed when the response was built; a tab left open outlives it.
  const gate = canOpenRename(status({ allowed: false, nextChangeAllowedAt: NOW - 1 }), NOW);
  assert.deepEqual(gate, { open: true });
});

test("a refusal with no timestamp still refuses, with nothing to promise", () => {
  const gate = canOpenRename(status({ allowed: false, nextChangeAllowedAt: null }), NOW);
  assert.equal(gate.open, false);
  assert.equal(gate.open === false && gate.retryAt, null);
});

test("an unreadable status opens the picker — the server is the real gate", () => {
  assert.deepEqual(canOpenRename(null, NOW), { open: true });
  assert.deepEqual(canOpenRename(undefined, NOW), { open: true });
});

test("an account that never bound a name is not in any cooldown", () => {
  const first = status({ label: null, allowed: true });
  assert.deepEqual(canOpenRename(first, NOW), { open: true });
});
