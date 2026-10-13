/**
 * The name pickers' lock is the SERVER'S unlock verdict (lib/gate/check.ts), one
 * rule for the profile name, a site name and an event-page name alike. Owner's
 * live test 2026-10-09: a passkey member with a confirmed invite (unlocked, via
 * "referral") was sent from Home to claim a name and met "verify with Stripe",
 * because the pickers locked every passkey account on a Stripe read of their own.
 *
 * The rule is pinned as a function; the two pickers are pinned at the source
 * (components cannot be mounted here).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nameLockFrom, type NameLockInputs } from "../src/lib/attendee/gate/name-lock.js";

const passkey = (over: Partial<NameLockInputs> = {}): NameLockInputs => ({
  connected: true,
  organiserKind: true,
  gate: null,
  gateLoading: false,
  ...over,
});

test("the live bug: a passkey member unlocked by a confirmed invite gets the form, not the Stripe panel", () => {
  assert.equal(nameLockFrom(passkey({ gate: { gated: true, via: "referral" } })), "open");
});

test("every unlock the server reports opens the picker; Stripe is one of them, not the rule", () => {
  for (const via of ["ticket", "organiser", "stripe", "referral", "disabled"] as const) {
    assert.equal(nameLockFrom(passkey({ gate: { gated: true, via } })), "open", via);
  }
});

test("a passkey account the server calls locked sees the lock panel (where Stripe can be started)", () => {
  assert.equal(nameLockFrom(passkey({ gate: { gated: false } })), "locked");
});

test("signed out is its own state, whatever else is known", () => {
  assert.equal(nameLockFrom(passkey({ connected: false, gate: { gated: true, via: "stripe" } })), "signed-out");
  assert.equal(nameLockFrom(passkey({ connected: false, organiserKind: false })), "signed-out");
});

test("a non-passkey account is never shown the panel: the claim's refusal opens the unlock flow", () => {
  assert.equal(nameLockFrom(passkey({ organiserKind: false, gate: { gated: false } })), "open");
  assert.equal(nameLockFrom(passkey({ organiserKind: false, gate: null, gateLoading: true })), "open");
});

test("no verdict yet: checking while the read is in flight, the form once nothing is coming", () => {
  assert.equal(nameLockFrom(passkey({ gate: null, gateLoading: true })), "checking");
  assert.equal(nameLockFrom(passkey({ gate: null, gateLoading: false })), "open");
});

test("a cached verdict wins over an in-flight re-read: no flash of 'checking' on every open", () => {
  assert.equal(nameLockFrom(passkey({ gate: { gated: true, via: "referral" }, gateLoading: true })), "open");
  assert.equal(nameLockFrom(passkey({ gate: { gated: false }, gateLoading: true })), "locked");
});

// ── The pickers, at the source ────────────────────────────────────────────────

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const PICKERS: Array<[name: string, src: string]> = [
  ["SubENSPicker", read("../src/lib/creator/builder/SubENSPicker.svelte")],
  ["EventDomainPicker", read("../src/lib/creator/builder/EventDomainPicker.svelte")],
];

for (const [name, src] of PICKERS) {
  test(`${name} decides its lock from the server verdict through the shared rule`, () => {
    assert.match(src, /import \{ nameLockFrom \} from "\.\.\/\.\.\/attendee\/gate\/name-lock\.js";/);
    assert.match(src, /const lock = \$derived\(nameLockFrom\(\{\s*connected: auth\.isConnected,\s*organiserKind: canOrganise\(auth\.kind\),\s*gate: gate\.status,\s*gateLoading: !gateSettled,\s*\}\)\);/);
    assert.match(src, /\{#if lock !== "open"\}/, "the panel branches on the rule's answer");
    assert.match(src, /\{#if lock === "checking"\}/);
  });

  test(`${name} holds no Stripe read of its own, and its lock copy is the whole rule`, () => {
    assert.doesNotMatch(src, /getStripeAccountStatus/, "a Stripe read here would be a second copy of the rule");
    assert.doesNotMatch(src, /stripeStatus/, "the old Stripe-only lock state is gone");
    assert.doesNotMatch(src, /Verify your business via Stripe to unlock/);
    assert.match(src, /\{unlocksWhen\("(Your|This) name"\)\}/, "the copy is the one sentence every unlock surface uses");
  });

  test(`${name} re-reads the verdict, never assumes it, when Stripe reports complete`, () => {
    assert.match(src, /function onStripeConnected\(\) \{[\s\S]*?void gate\.refresh\(\);[\s\S]*?\}/);
    // A parent's live Stripe answer flipping to true is what synced the stored flag.
    assert.match(src, /void stripeConnected;\s*gateSettled = false;/);
    assert.match(src, /if \(!auth\.isConnected \|\| !auth\.hasSession\) \{ gateSettled = true; return; \}/, "a passive check never raises a session");
  });
}
