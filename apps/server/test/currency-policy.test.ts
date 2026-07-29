/**
 * Pricing-currency restriction (#84).
 *
 * Stripe converts a charge whose currency the connected account has no bank
 * account for into the account's default currency, and bills the organiser its
 * FX fee — silently, per sale, and again on the spread when a refund converts
 * back. The decision (2026-07-29) was to make that impossible rather than merely
 * disclosed: an organiser may only price in their own payout currency.
 *
 * The direction of the FAIL-OPEN is the load-bearing property here. Stripe
 * assigns default_currency during onboarding, so an unknown value is the normal
 * state for a brand-new organiser — treating it as "reject" would stop real
 * organisers creating any paid event at all, on the strength of a value we
 * simply have not fetched yet.
 *
 * The accounts store writes .data/ relative to process.cwd(), so this suite
 * chdirs into a temp dir BEFORE importing it.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORG = "0xAbCd000000000000000000000000000000000001";
const ACCT = "acct_currency_1";
const SUPPORTED = ["USD", "GBP", "EUR"] as const;

let accounts: typeof import("../src/lib/stripe/accounts.js");
let policy: typeof import("../src/lib/stripe/currency-policy.js");
let accountsFile: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-currency-test-"));
  process.chdir(dir);
  accountsFile = join(dir, ".data", "stripe-accounts.json");
  accounts = await import("../src/lib/stripe/accounts.js");
  policy = await import("../src/lib/stripe/currency-policy.js");
});

beforeEach(() => {
  rmSync(accountsFile, { force: true });
  accounts.deleteStripeAccount(ORG);
});

// ── Fail-open ─────────────────────────────────────────────────────────────

test("an organiser with no Stripe record at all may price in anything", () => {
  for (const ccy of SUPPORTED) {
    assert.equal(policy.currencyAllowedFor(ORG, ccy).allowed, true);
  }
});

test("an account whose default currency Stripe has not assigned yet is unrestricted", () => {
  accounts.setStripeAccount(ORG, ACCT, false);
  assert.equal(policy.currencyAllowedFor(ORG, "USD").allowed, true);
  assert.deepEqual(policy.allowedCurrencies(ORG, SUPPORTED), [...SUPPORTED]);
});

// ── The restriction ───────────────────────────────────────────────────────

test("the payout currency is allowed, whatever the casing", () => {
  accounts.setStripeAccount(ORG, ACCT, true, "gbp");
  assert.equal(policy.currencyAllowedFor(ORG, "GBP").allowed, true);
  assert.equal(policy.currencyAllowedFor(ORG, "gbp").allowed, true);
  assert.equal(policy.currencyAllowedFor(ORG.toLowerCase(), "GBP").allowed, true);
});

test("any other currency is refused, with copy that names the reason", () => {
  accounts.setStripeAccount(ORG, ACCT, true, "gbp");
  const verdict = policy.currencyAllowedFor(ORG, "USD");

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.defaultCurrency, "gbp");
  assert.match(verdict.reason ?? "", /GBP/);
  assert.match(verdict.reason ?? "", /conversion fee/i);
});

test("the picker offers exactly the payout currency once it is known", () => {
  accounts.setStripeAccount(ORG, ACCT, true, "EUR");
  assert.deepEqual(policy.allowedCurrencies(ORG, SUPPORTED), ["EUR"]);
});

/**
 * An organiser banking in a currency WoCo does not sell in must not get an
 * EMPTY picker — that would lock them out of pricing entirely. They keep the
 * full list and eat the FX fee, which is exactly the status quo before #84.
 */
test("a payout currency outside our supported set does not empty the picker", () => {
  accounts.setStripeAccount(ORG, ACCT, true, "aud");
  assert.deepEqual(policy.allowedCurrencies(ORG, SUPPORTED), [...SUPPORTED]);
  assert.equal(policy.currencyAllowedFor(ORG, "GBP").allowed, false, "still not the payout currency");
});

// ── Cache maintenance ─────────────────────────────────────────────────────

test("a later status refresh without a currency does not wipe a known one", () => {
  accounts.setStripeAccount(ORG, ACCT, true, "gbp");
  accounts.setStripeAccount(ORG, ACCT, true);
  assert.equal(accounts.getStripeAccount(ORG)?.defaultCurrency, "gbp");
  assert.equal(policy.currencyAllowedFor(ORG, "USD").allowed, false);
});

test("setDefaultCurrency updates by Stripe account id and normalises case", () => {
  accounts.setStripeAccount(ORG, ACCT, true, "gbp");
  accounts.setDefaultCurrency(ACCT, "EUR");
  assert.equal(accounts.getStripeAccount(ORG)?.defaultCurrency, "eur");
  assert.equal(policy.currencyAllowedFor(ORG, "EUR").allowed, true);
  assert.equal(policy.currencyAllowedFor(ORG, "GBP").allowed, false);
});

test("setDefaultCurrency for an unknown account is a no-op, not a throw", () => {
  accounts.setDefaultCurrency("acct_does_not_exist", "usd");
  assert.equal(accounts.getStripeAccount(ORG), undefined);
});

/** The organiser changing their payout bank must move the restriction with it. */
test("a currency change survives a reload from disk", async () => {
  accounts.setStripeAccount(ORG, ACCT, true, "gbp");
  accounts.setDefaultCurrency(ACCT, "usd");

  const raw = JSON.parse(
    (await import("node:fs")).readFileSync(accountsFile, "utf-8"),
  ) as Record<string, { defaultCurrency?: string }>;
  assert.equal(raw[ORG.toLowerCase()]?.defaultCurrency, "usd");
});
