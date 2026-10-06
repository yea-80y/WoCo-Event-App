/**
 * Surplus clock — when an account's balance first held MORE than its ledger
 * claims, per account + payout currency (#781 part 2).
 *
 * A surplus is money that arrived outside any sale: a debt Stripe recovered by
 * debiting the organiser's bank, a dispute won after the sale was paid out, a
 * top-up, an organiser's own non-WoCo payment. It is theirs, so it is paid out,
 * but only once it has lasted SURPLUS_SETTLE_DAYS: a refund Stripe is holding
 * for insufficient funds claims the balance first, and a sale whose webhook has
 * not been recorded yet would otherwise read as surplus.
 *
 * `min` is the smallest surplus seen since the clock started, so a surplus that
 * shrank part-way through is only paid at the size it held for the whole wait.
 *
 * File-backed so a restart does not restart the wait. Losing the file only
 * delays a surplus by one more wait; nothing is paid that should not be.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const SURPLUS_FILE = join(DATA_DIR, "stripe-payout-surplus.json");

export interface SurplusClock {
  /** When the balance first held more than the ledger, this stretch. */
  since: string;
  /** Smallest surplus seen since, minor units. */
  min: number;
}

/** `${stripeAccountId}|${currency}` → clock */
let store: Record<string, SurplusClock> = {};
let loaded = false;

function keyFor(stripeAccountId: string, currency: string): string {
  return `${stripeAccountId}|${currency.toLowerCase()}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    store = JSON.parse(readFileSync(SURPLUS_FILE, "utf-8")) as Record<string, SurplusClock>;
  } catch {
    // No clocks yet.
  }
}

function persist(): void {
  writeJsonAtomic(SURPLUS_FILE, store, "payout-surplus", { pretty: true });
}

/**
 * Record this sweep's surplus (`rho` > 0) or its absence, and return the clock.
 * A surplus that disappears resets the clock: the wait is for a surplus that
 * lasts, not one that comes and goes.
 */
export function observeSurplus(stripeAccountId: string, currency: string, rho: number, now: Date): SurplusClock | null {
  ensureLoaded();
  const key = keyFor(stripeAccountId, currency);
  const clock = store[key];
  if (rho <= 0) {
    if (clock) {
      delete store[key];
      persist();
    }
    return null;
  }
  if (!clock) {
    store[key] = { since: now.toISOString(), min: rho };
    persist();
    return store[key]!;
  }
  if (rho < clock.min) {
    clock.min = rho;
    persist();
  }
  return clock;
}

/** The surplus was paid out: start again if any is left. */
export function clearSurplus(stripeAccountId: string, currency: string): void {
  ensureLoaded();
  const key = keyFor(stripeAccountId, currency);
  if (!store[key]) return;
  delete store[key];
  persist();
}

export function listSurplusClocks(): Array<{ stripeAccountId: string; currency: string } & SurplusClock> {
  ensureLoaded();
  return Object.entries(store).map(([key, c]) => {
    const [stripeAccountId, currency] = key.split("|") as [string, string];
    return { stripeAccountId, currency, ...c };
  });
}

/** Test seam — resets in-memory state so a fresh file is read. */
export function __resetForTests(): void {
  store = {};
  loaded = false;
}
