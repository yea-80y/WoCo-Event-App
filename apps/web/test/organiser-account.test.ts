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
import { canOrganise, PASSKEY_ONLY_RECOVERY_NOTE } from "../src/lib/auth/organiser-account.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("only a passkey account organises", () => {
  assert.equal(canOrganise("passkey"), true);
  for (const kind of ["web3auth", "web3", "coinbase", "zupass", "none", null, undefined]) {
    assert.equal(canOrganise(kind), false, String(kind));
  }
  assert.equal(PASSKEY_ONLY_RECOVERY_NOTE, "If every passkey is lost, the account can't be recovered.");
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

test("'Start hosting' signs up with a passkey only, and says what losing every passkey means", () => {
  const modal = read("../src/lib/components/auth/LoginModal.svelte");
  const only = modal.indexOf('{#if loginRequest.context !== "invite"}');
  assert.ok(only > 0 && only < modal.indexOf("<Web3AuthLogin") && only < modal.indexOf('class="wallet-door"'));
  const passkey = read("../src/lib/components/auth/PasskeyLogin.svelte");
  assert.match(passkey, /\{#if loginRequest\.context === "invite"\}\s*<!--[^>]*-->\s*<p class="recovery-note">\{PASSKEY_ONLY_RECOVERY_NOTE\}/);
});
