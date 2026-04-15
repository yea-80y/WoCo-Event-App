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
  };
  persist();
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

export function getOrganiserByStripeAccount(stripeAccountId: string): string | undefined {
  ensureLoaded();
  for (const [address, record] of Object.entries(store)) {
    if (record.stripeAccountId === stripeAccountId) return address;
  }
  return undefined;
}
