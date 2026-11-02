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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canMintProfileName, canOpenRename, type ProfileNameStatus } from "../src/lib/sub-ens/rename.js";

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

// ---------------------------------------------------------------------------
// The claim form, too (2026-11-02)
// ---------------------------------------------------------------------------
//
// Only "Change" asked before minting; the claim form (no verified name, or one
// from a retired registry) minted first and met the cooldown at bind.

const COOLING = status({ label: "nabil", allowed: false, nextChangeAllowedAt: NOW + 12 * DAY });

test("minting a DIFFERENT name during a cooldown is refused, with the date", () => {
  const gate = canMintProfileName(COOLING, "newname", NOW);
  assert.equal(gate.open, false);
  assert.equal(gate.open === false && gate.retryAt, NOW + 12 * DAY);
});

test("minting the CURRENT profile name again is never a change, whatever the case", () => {
  // The server's bindProfileName lets the same label through ungated.
  assert.deepEqual(canMintProfileName(COOLING, "nabil", NOW), { open: true });
  assert.deepEqual(canMintProfileName(COOLING, " Nabil ", NOW), { open: true });
});

test("the claim-form gate keeps the same fail-open and elapsed-wait rules", () => {
  assert.deepEqual(canMintProfileName(null, "newname", NOW), { open: true });
  assert.deepEqual(canMintProfileName(status({ label: null, allowed: true }), "newname", NOW), { open: true });
  assert.deepEqual(canMintProfileName(status({ allowed: false, nextChangeAllowedAt: NOW - 1 }), "newname", NOW), {
    open: true,
  });
});

// SOURCE SCAN: the property is an ORDER inside the picker's mint path and a
// wiring on the profile page - neither observable without rendering Svelte.
// MUTATION: drop `onbeforemint={guardRename}`, or move the onbeforemint call
// below `claimSubEnsLabel`, and this goes red.

const src = (rel: string): string => {
  const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
  assert.ok(text.length > 10_000, `${rel} read as ${text.length} bytes — wrong file?`);
  return text;
};

test("the picker asks onbeforemint after sign-in and before the mint, and stops on false", () => {
  const picker = src("../src/lib/creator/builder/SubENSPicker.svelte");
  const start = picker.indexOf("async function doClaim(");
  assert.ok(start >= 0, "doClaim moved");
  const body = picker.slice(start, picker.indexOf("\n  }\n", start));
  const session = body.indexOf("auth.ensureSession()");
  const gate = body.indexOf("if (!(await onbeforemint(");
  const mint = body.indexOf("claimSubEnsLabel(");
  assert.ok(session >= 0 && gate > session, "after sign-in: a passkey sheet must open from the tap");
  assert.ok(mint > gate, "before the mint: the mint is irreversible");
});

test("the profile page gates the claim form's mint on its rename guard", () => {
  const page = src("../src/lib/components/profile/ProfilePage.svelte");
  const tag = page.match(/<SubENSPicker\b[\s\S]*?\/>/);
  assert.ok(tag, "profile picker moved");
  assert.match(tag[0], /onbeforemint=\{guardRename\}/);
  assert.match(page, /label === undefined \? canOpenRename\(status\) : canMintProfileName\(status, label\)/);
});
