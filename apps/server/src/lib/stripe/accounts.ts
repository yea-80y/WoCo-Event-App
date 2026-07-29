/**
 * Stripe Connected Account store — maps organiser ETH addresses to Stripe account IDs.
 *
 * File-backed JSON store (same pattern as tx-registry.ts and revoked-sessions.json).
 * Survives server restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".data");
const ACCOUNTS_FILE = join(DATA_DIR, "stripe-accounts.json");

interface StripeAccountRecord {
  /** Stripe Connected Account ID (acct_...) */
  stripeAccountId: string;
  /** Whether onboarding is complete (charges_enabled + payouts_enabled) */
  onboardingComplete: boolean;
  /** When the account was created */
  createdAt: string;
  /** Last updated (e.g. after webhook) */
  updatedAt: string;
  /**
   * Stripe's `default_currency` for this account, lowercase (e.g. "gbp").
   *
   * Cached because it decides what the organiser may PRICE in. A charge in a
   * currency the account has no bank account for is auto-converted by Stripe
   * into this one, with Stripe's conversion fee taken out of the organiser's
   * proceeds — silently, on every sale, and asymmetrically on refunds. Pricing
   * is restricted to this currency rather than surfacing the fee (#84).
   *
   * Optional: accounts created before this field existed, and accounts whose
   * onboarding has not reached the point where Stripe assigns one, have none.
   * An absent value must NEVER be treated as "reject everything" — see
   * `currencyAllowedFor`.
   */
  defaultCurrency?: string;
}

/** organiserAddress (lowercase) → StripeAccountRecord */
let store: Record<string, StripeAccountRecord> = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(ACCOUNTS_FILE, "utf-8");
    store = JSON.parse(raw);
    console.log(`[stripe-accounts] Loaded ${Object.keys(store).length} accounts from disk`);
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function persist(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("[stripe-accounts] Failed to persist:", err);
  }
}

export function getStripeAccount(organiserAddress: string): StripeAccountRecord | undefined {
  ensureLoaded();
  return store[organiserAddress.toLowerCase()];
}

export function setStripeAccount(
  organiserAddress: string,
  stripeAccountId: string,
  onboardingComplete: boolean,
  defaultCurrency?: string,
): void {
  ensureLoaded();
  const key = organiserAddress.toLowerCase();
  const now = new Date().toISOString();
  const existing = store[key];
  store[key] = {
    stripeAccountId,
    onboardingComplete,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // Never clear a known currency with an absent one: callers that don't have
    // it (account creation, before Stripe assigns one) must not wipe a value a
    // later refresh already learned.
    ...((defaultCurrency ?? existing?.defaultCurrency)
      ? { defaultCurrency: (defaultCurrency ?? existing?.defaultCurrency)!.toLowerCase() }
      : {}),
  };
  persist();
}

/** Record the account's default currency without touching onboarding state. */
export function setDefaultCurrency(stripeAccountId: string, defaultCurrency: string): void {
  ensureLoaded();
  const lower = defaultCurrency.toLowerCase();
  for (const [key, record] of Object.entries(store)) {
    if (record.stripeAccountId !== stripeAccountId) continue;
    if (record.defaultCurrency === lower) return;
    store[key] = { ...record, defaultCurrency: lower, updatedAt: new Date().toISOString() };
    persist();
    return;
  }
}

export function updateOnboardingStatus(
  stripeAccountId: string,
  onboardingComplete: boolean,
): void {
  ensureLoaded();
  for (const [key, record] of Object.entries(store)) {
    if (record.stripeAccountId === stripeAccountId) {
      store[key] = {
        ...record,
        onboardingComplete,
        updatedAt: new Date().toISOString(),
      };
      persist();
      return;
    }
  }
}

/**
 * Every mapping in the store. Ops-only (payout-schedule-audit.ts) — request paths
 * look accounts up by key. Exists so the audit reads the store through the same
 * path resolution the server uses, rather than guessing .data's location itself.
 */
export function listStripeAccounts(): Array<{
  organiserAddress: string;
  record: StripeAccountRecord;
}> {
  ensureLoaded();
  return Object.entries(store).map(([organiserAddress, record]) => ({ organiserAddress, record }));
}

export function getOrganiserByStripeAccount(stripeAccountId: string): string | undefined {
  ensureLoaded();
  for (const [address, record] of Object.entries(store)) {
    if (record.stripeAccountId === stripeAccountId) return address;
  }
  return undefined;
}

export function deleteStripeAccount(organiserAddress: string): boolean {
  ensureLoaded();
  const key = organiserAddress.toLowerCase();
  if (!store[key]) return false;
  delete store[key];
  persist();
  return true;
}
