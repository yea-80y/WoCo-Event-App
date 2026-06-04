// ---------------------------------------------------------------------------
// Loyalty — pure derivations (Step 4, item C).
//
// Points and milestone progress are DERIVED from the order feed, never stored
// (a point is a decrementing balance, a POD is immutable — §4.1). These pure
// functions run identically client-side (live "points / progress" UI) and
// server-side (the authoritative milestone trigger), so there's one source of
// truth and the logic is ready for the client-side-feed-signer migration.
// ---------------------------------------------------------------------------

import type { Order } from "./types.js";
import type { SpendThresholdReward } from "./types.js";
import { moneyToMinor } from "./pricing.js";

/** Sum of a buyer's PAID spend in minor units. `buyerRef` match is
 *  case-insensitive (wallet addresses / email hashes are stored lowercased,
 *  but compare defensively). Pass the full shop order list. */
export function paidSpendMinor(orders: Order[], buyerRef: string): number {
  const ref = buyerRef.toLowerCase();
  let total = 0;
  for (const o of orders) {
    if (o.status !== "paid") continue;
    if ((o.buyerRef ?? "").toLowerCase() !== ref) continue;
    total += moneyToMinor(o.total);
  }
  return total;
}

/** Display points for a spend (minor units) at a given earn rate (points per 1
 *  currency unit). Floor — points are whole. Returns 0 when no rate is set. */
export function loyaltyPointsFromMinor(spendMinor: number, earnRate?: number): number {
  if (!earnRate || earnRate <= 0) return 0;
  return Math.floor((spendMinor / 100) * earnRate);
}

/**
 * Which thresholds a buyer just crossed moving from `priorMinor` → `currentMinor`
 * cumulative spend: those with `priorMinor < threshold <= currentMinor`. Returns
 * them ascending by threshold. Pure — the caller mints the badge for each (and
 * still dedups against on-chain holdings, the trustless source of truth).
 */
export function crossedThresholds(
  priorMinor: number,
  currentMinor: number,
  thresholds: SpendThresholdReward[],
): SpendThresholdReward[] {
  return thresholds
    .map((t) => ({ t, minor: moneyToMinor(t.threshold) }))
    .filter(({ minor }) => minor > priorMinor && minor <= currentMinor)
    .sort((a, b) => a.minor - b.minor)
    .map(({ t }) => t);
}
