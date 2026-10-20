/**
 * Organising needs a passkey account (#746 step 5, Fable consult 8 Q5): the
 * workspace opens only for one, deep links included, and "Start hosting" offers
 * no other way in. The server half (a wallet account cannot start Stripe
 * onboarding) is apps/server/test/organiser-passkey-gate.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canOrganise,
  isOrganiserSignIn,
  ORGANISER_NEW_PASSKEY_NOTE,
  PASSKEY_ONLY_RECOVERY_NOTE,
} from "../src/lib/auth/organiser-account.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("only a passkey account organises", () => {
  assert.equal(canOrganise("passkey"), true);
  for (const kind of ["web3auth", "web3", "coinbase", "zupass", "none", null, undefined]) {
    assert.equal(canOrganise(kind), false, String(kind));
  }
  assert.equal(PASSKEY_ONLY_RECOVERY_NOTE, "If every passkey is lost, the account can't be recovered.");
});

test("the note for a new organiser account: positive, no em dash, never against email", () => {
  assert.equal(
    ORGANISER_NEW_PASSKEY_NOTE,
    "There's no password to reset - your passkey is how you get in. Once you're set up, add a backup passkey or a second device so a lost phone never locks you out.",
  );
  assert.ok(!ORGANISER_NEW_PASSKEY_NOTE.includes("—"));
  assert.ok(!/quantum|email|insecure/i.test(ORGANISER_NEW_PASSKEY_NOTE));
  // UpgradeToPasskey's confirm step still says the plain fact before an account gives up its email.
  assert.ok(read("../src/lib/creator/gate/UpgradeToPasskey.svelte").includes("{PASSKEY_ONLY_RECOVERY_NOTE}"));
});

test("the workspace checks before ANY organiser route, so a deep link lands on the explanation", () => {
  const app = read("../src/CreatorApp.svelte");
  const markup = app.slice(app.indexOf("<CreatorShell>"));
  const gate = markup.indexOf('{#if auth.ready && auth.isConnected && !canOrganise(auth.kind) && router.route !== "profile"}');
  assert.ok(gate > 0, "the gate exists");
  for (const route of ["creator-home", "create", "dashboard", "audience", "payouts", "stripe-return"]) {
    const at = markup.indexOf(`router.route === "${route}"`);
    assert.ok(at > gate, `${route} sits behind the gate`);
  }
});

test("an organiser sign-in is decided by where it was asked from", () => {
  // Start hosting, and the organiser portal's own Sign in.
  assert.equal(isOrganiserSignIn("invite", "neutral"), true);
  assert.equal(isOrganiserSignIn("creator", "attendee"), true);
  // Any organiser screen's bare Sign in button.
  assert.equal(isOrganiserSignIn(undefined, "creator"), true);
  // Attendees keep email, including an explicit attendee/ticket ask on an organiser screen.
  for (const surface of ["attendee", "neutral", undefined]) assert.equal(isOrganiserSignIn(undefined, surface), false);
  assert.equal(isOrganiserSignIn("attendee", "creator"), false);
  assert.equal(isOrganiserSignIn("ticket", "creator"), false);
});

test("an organiser sign-in offers a passkey only, and says how the account is kept only while one is created", () => {
  const modal = read("../src/lib/components/auth/LoginModal.svelte");
  assert.match(modal, /const organiserSignIn = \$derived\(isOrganiserSignIn\(loginRequest\.context, router\.surface\)\)/);
  const only = modal.indexOf("{#if !organiserSignIn}", modal.indexOf("<PasskeyLogin"));
  assert.ok(only > 0 && only < modal.indexOf("<Web3AuthLogin", only) && only < modal.indexOf('class="wallet-door"'));
  assert.match(modal, /<PasskeyLogin\s+organiser=\{organiserSignIn\}/);
  const passkey = read("../src/lib/components/auth/PasskeyLogin.svelte");
  // Not on the sign-in screen: every returning organiser saw it, and "link a
  // second device once you're in" is refused until the account is unlocked.
  assert.ok(!passkey.includes("PASSKEY_ONLY_RECOVERY_NOTE") && !passkey.includes("recovery-note"));
  // In the scene of an organiser's CREATE only - the mode comes from the button that started it.
  assert.ok(passkey.includes("onstart?.(mode);"));
  assert.ok(modal.includes('onstart={(mode) => start("passkey", mode === "create")}'));
  assert.match(modal, /function start\(method: Method, create = false\) \{\s*authing = method;\s*creatingPasskey = create;/);
  const scene = modal.slice(modal.indexOf("{#if authing && sceneShown}"), modal.indexOf("{#if !offCanonicalHost}"));
  assert.match(scene, /\{#if authing === "passkey" && creatingPasskey && organiserSignIn\}\s*<!--[^>]*-->\s*<p class="scene-note">\{ORGANISER_NEW_PASSKEY_NOTE\}<\/p>/);
  assert.equal(modal.split("ORGANISER_NEW_PASSKEY_NOTE").length - 1, 2, "imported once, shown once");
  // A browser with no passkeys gets a way out, never an empty sheet.
  assert.match(passkey, /\{:else if checked && organiser\}[\s\S]*?can't use passkeys, and organising needs one/);
});

test("the organiser portal's Profile tab asks for an organiser sign-in", () => {
  const shell = read("../src/lib/layouts/CreatorShell.svelte");
  assert.match(shell, /loginRequest\.request\(\{ context: "creator" \}\)/);
});
