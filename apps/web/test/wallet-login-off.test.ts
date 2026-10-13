/**
 * Wallet login is off for launch (#186): a wallet account's identity seed is one
 * fixed signature any site can ask for. The client half of the flag, pinned at the
 * source (a Svelte runes store and components this suite cannot run); the server
 * half is apps/server/test/wallet-login-gate.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FEATURES } from "@woco/shared";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const STORE = read("../src/lib/auth/auth-store.svelte.ts");

test("the flag is off for launch", () => {
  assert.equal(FEATURES.walletLoginAllowed as boolean, false);
});

test("loginWeb3 refuses before it connects anything", () => {
  const start = STORE.indexOf("async function loginWeb3(): Promise<boolean> {");
  const body = STORE.slice(start, STORE.indexOf("\n}\n", start));
  const refuse = body.indexOf("if (!FEATURES.walletLoginAllowed) {");
  assert.ok(refuse > 0 && refuse < body.indexOf("connectWallet()"));
});

test("a stored wallet session is cleared, not restored", () => {
  const branch = STORE.slice(STORE.indexOf('if (kind === "web3") {'));
  assert.match(branch.slice(0, 400), /if \(!FEATURES\.walletLoginAllowed\) \{[^}]*await clearAllAuth\(\);\s*return;/);
});

test("no screen offers a wallet: sign-in, the event page, or a backup", () => {
  const modal = read("../src/lib/components/auth/LoginModal.svelte");
  assert.match(modal, /\{#if FEATURES\.walletLoginAllowed\}\s*<div class="wallet-door">/);
  assert.match(modal, /\{#if FEATURES\.walletLoginAllowed\}\s*<WalletLogin /);
  const site = read("../src/SiteApp.svelte");
  assert.match(site, /const signInHere = FEATURES\.walletLoginAllowed;/);
  assert.match(site, /\{#if signInHere\}\s*<SiteLoginModal \/>/);
  assert.match(site, /if \(hash === "\/dashboard" && signInHere\) return "dashboard";/);
  const protect = read("../src/lib/components/recovery/AccountRecoverySetup.svelte");
  assert.match(protect, /\.\.\.\(FEATURES\.walletLoginAllowed\s*\? \[\{ id: "wallet" as const/);
});
