/**
 * Stripe set-up is for organisers, and organising needs a passkey (#746). The server
 * cannot tell a passkey smart account from an email one (`routes/stripe.ts`
 * requireSmartAccountOrganiser), so the app is the check - in the two components every
 * Stripe entry goes through, not at each screen. Found 2026-10-08: Profile's Wallet tab
 * and its name picker sent an email account into Stripe onboarding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canOrganise } from "../src/lib/auth/organiser-account.js";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const ORGANISER = 'const organiser = $derived(!auth.isConnected || canOrganise(auth.kind));';

test("only a passkey account organises", () => {
  assert.equal(canOrganise("passkey"), true);
  for (const kind of ["web3auth", "web3", "coinbase", null]) assert.equal(canOrganise(kind), false);
});

test("both Stripe components refuse any other account, in the markup and on the button", () => {
  for (const file of ["StripeConnect", "StripeConnectModal"]) {
    const src = read(`../src/lib/creator/dashboard/${file}.svelte`);
    assert.ok(src.includes(ORGANISER), `${file}: organiser check`);
    assert.match(src, /async function handleConnect\(\) \{\n\s*if \(!organiser\) return;/, `${file}: handleConnect`);
    const cont = file === "StripeConnect" ? "handleContinueOnboarding" : "handleContinue";
    assert.match(src, new RegExp(`async function ${cont}\\(\\) \\{\\n\\s*if \\(!organiser\\) return;`), `${file}: ${cont}`);
    assert.ok(src.includes("{#if !organiser}"), `${file}: markup`);
  }
  const modal = read("../src/lib/creator/dashboard/StripeConnectModal.svelte");
  assert.ok(modal.indexOf("{#if !organiser}") < modal.indexOf("{:else if loading}"), "refused before any status shows");
  const panel = read("../src/lib/creator/dashboard/StripeConnect.svelte");
  assert.ok(panel.indexOf("{#if !organiser}") < panel.indexOf('<div class="stripe-panel"'));
});

test("Profile's Wallet tab offers card payments to organisers only", () => {
  const tab = read("../src/lib/components/profile/WalletTab.svelte");
  const branch = tab.slice(tab.indexOf("{#if auth.isConnected && !canOrganise(auth.kind)}"), tab.indexOf("{:else if auth.isConnected}"));
  assert.ok(branch.length > 0);
  assert.doesNotMatch(branch, /Card Payments|payouts/);
});

test("the name picker locks behind Stripe for organisers only", () => {
  const picker = read("../src/lib/creator/builder/SubENSPicker.svelte");
  assert.ok(picker.includes("const stripeLocks = $derived(!auth.isConnected || canOrganise(auth.kind));"));
  assert.ok(picker.includes("{#if stripeLocks && stripeStatus !== true}"));
  assert.doesNotMatch(picker, /Connect wallet/);
});
