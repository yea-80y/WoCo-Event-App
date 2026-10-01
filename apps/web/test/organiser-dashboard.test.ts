/**
 * The organiser dashboard opens on the next-step card, and its doors go where
 * they say. Two of them did not: "Finish Stripe onboarding" opened the events
 * list, and "Claim one" under names opened the website builder.
 *
 * SOURCE SCAN: Svelte components, which Node cannot mount.
 *
 * MUTATION: point a card action somewhere else, or bring back the checklist,
 * the welcome popup or the changelog, and a case below goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf-8");
const HOME = read("lib/creator/home/CreatorHome.svelte");

test("the next-step card is the first thing under the greeting", () => {
  const card = HOME.indexOf("<NextStepCard");
  const panels = HOME.indexOf('<div class="work-grid">');
  assert.notEqual(card, -1, "the dashboard no longer renders NextStepCard");
  assert.ok(card < panels, "the card must come before the panels");
});

test("the setup checklist, welcome popup and changelog are gone", () => {
  assert.equal(existsSync(`${SRC}/lib/creator/home/GettingStartedCard.svelte`), false);
  assert.equal(existsSync(`${SRC}/lib/creator/home/WelcomeModal.svelte`), false);
  assert.doesNotMatch(HOME, /changelog|Recent updates/i);
});

test("Stripe actions go to Stripe, never to the events list", () => {
  assert.match(HOME, /onstripe=\{\(\) => \{ stripeModalOpen = true; \}\}/);
  assert.match(HOME, /onstripedetails=\{\(\) => navigate\("\/creator\/payouts"\)\}/);
  assert.match(HOME, /<StripeConnectModal\b/);
});

test("claiming a name opens the profile, where the name is claimed", () => {
  assert.match(HOME, /onname=\{openProfile\}/);
  assert.match(HOME, /navigate\(`\/creator\/profile\/\$\{auth\.parent\.toLowerCase\(\)\}`\)/);
  assert.doesNotMatch(HOME, /navigate\("\/creator\/sites"\)\}>\s*<Plus[^>]*\/> Claim one/);
});

test("the name unlock is asked only after Stripe's live answer lands", () => {
  const stripeCall = HOME.indexOf("getStripeAccountStatus().then(");
  const unlock = HOME.indexOf("gate.refresh()");
  assert.ok(stripeCall !== -1 && unlock > stripeCall, "gate.refresh must run inside the Stripe status callback");
  const callbackEnd = HOME.indexOf("}).catch(", stripeCall);
  assert.ok(unlock < callbackEnd, "gate.refresh must run inside the Stripe status callback");
});
