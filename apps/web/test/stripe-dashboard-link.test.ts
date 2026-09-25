/**
 * The Payouts screen points organisers to their own Stripe Dashboard (#645).
 *
 * Accounts are `full`, so refunds and disputes live in the organiser's own
 * Stripe Dashboard and nowhere in WoCo. This link is the only pointer to it, so
 * it must go to Stripe's real host, open without handing Stripe a reference to
 * our window, and stay usable when Stripe's embedded iframes fail to load.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STRIPE_DASHBOARD_URL } from "../src/lib/creator/payouts/connect-embed.js";

const PANEL = readFileSync(
  new URL("../src/lib/creator/payouts/StripeAccountPanel.svelte", import.meta.url),
  "utf8",
);
const MARKUP = PANEL.slice(PANEL.indexOf("</script>"), PANEL.indexOf("<style>"));

/** The rendered `<a …>` for the dashboard link, attributes only. */
function dashboardAnchor(): string {
  const m = MARKUP.match(/<a\b[^>]*href=\{STRIPE_DASHBOARD_URL\}[^>]*>/);
  assert.ok(m, "the panel renders an <a> whose href is STRIPE_DASHBOARD_URL");
  return m[0];
}

test("the link goes to Stripe's own dashboard host, over https", () => {
  const url = new URL(STRIPE_DASHBOARD_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "dashboard.stripe.com");
});

test("it opens in a new tab without giving Stripe a handle on this window", () => {
  const a = dashboardAnchor();
  assert.match(a, /target="_blank"/);
  assert.match(a, /rel="[^"]*\bnoopener\b[^"]*"/);
  assert.match(a, /rel="[^"]*\bnoreferrer\b[^"]*"/);
});

test("it sits outside the Stripe embed, so it works when the iframes do not load", () => {
  const link = MARKUP.search(/href=\{STRIPE_DASHBOARD_URL\}/);
  const embed = MARKUP.indexOf('<div class="embed"');
  assert.ok(link > 0 && embed > 0);
  // The embed block is hidden on every non-ready state; the link must not be in
  // it. It closes at its own indentation, after its two single-line children.
  const embedBlock = MARKUP.slice(embed).match(/^<div class="embed"[\s\S]*?\n {2}<\/div>/)?.[0];
  assert.ok(embedBlock?.includes("bind:this={managementHost}"), "found the whole embed block");
  assert.doesNotMatch(embedBlock, /STRIPE_DASHBOARD_URL/);
  // And it is not gated behind any {#if} status branch.
  const before = MARKUP.slice(0, link);
  const opened = (before.match(/\{#if\b/g) ?? []).length;
  const closed = (before.match(/\{\/if\}/g) ?? []).length;
  assert.equal(opened, closed, "the link renders in every state, not inside an {#if}");
});

test("the copy says refunds are made there, in the owner's register", () => {
  const block = MARKUP.slice(MARKUP.indexOf('<div class="dashboard">'), MARKUP.indexOf("</a>") + 4);
  assert.match(block, /Refunds/);
  assert.match(block, /Open your Stripe Dashboard/);
  assert.doesNotMatch(block, /—/, "spaced hyphen, never an em dash");
});
