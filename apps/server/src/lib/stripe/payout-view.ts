/**
 * Ledger → the organiser-facing payouts response.
 *
 * Split out of the route so the money arithmetic is testable without an HTTP
 * server or a Stripe key. Two things here are load-bearing:
 *
 *   - `netIsFinal` is what stops the UI presenting a held amount as a promise.
 *     A refund can land at any moment before release and change the net, so
 *     only an entry that has LEFT "held" with a resolved net is final.
 *   - Held totals are keyed by the currency the funds actually sit in
 *     (settlement currency once Stripe has converted a charge), because that is
 *     the balance the release sweep pays out of. Keying by presentment currency
 *     would show an organiser a pot that does not exist.
 *
 * Mechanism and constraints: docs/PAYOUTS.md.
 */

import type { PayoutEntryView, PayoutsResponse } from "@woco/shared";
import type { PayoutLedgerEntry } from "./payout-ledger.js";

/** The currency an entry's money sits in — settlement wins once known. */
export function viewCurrency(e: PayoutLedgerEntry): string {
  return e.settlementCurrency ?? e.currency;
}

/** Resolved net where we have it, gross until the sweep reads the balance transaction. */
export function viewAmount(e: PayoutLedgerEntry): number {
  return e.netAmount ?? e.grossAmount;
}

export function toPayoutEntryView(e: PayoutLedgerEntry): PayoutEntryView {
  return {
    sessionId: e.sessionId,
    kind: e.kind,
    eventId: e.eventId,
    shopId: e.shopId,
    currency: e.currency,
    settlementCurrency: e.settlementCurrency ?? null,
    grossAmount: e.grossAmount,
    netAmount: e.netAmount ?? null,
    netIsFinal: e.status !== "held" && typeof e.netAmount === "number",
    recordedAt: e.recordedAt,
    releaseAfter: e.releaseAfter,
    status: e.status,
    releasedAt: e.releasedAt ?? null,
    payoutId: e.payoutId ?? null,
    forcedByCeiling: !!e.forcedByCeiling,
    voidReason: e.voidReason ?? null,
  };
}

export function buildPayoutsResponse(entries: PayoutLedgerEntry[]): PayoutsResponse {
  const held = entries.filter((e) => e.status === "held");

  const heldByCurrency: Record<string, number> = {};
  for (const e of held) {
    const cur = viewCurrency(e);
    heldByCurrency[cur] = (heldByCurrency[cur] ?? 0) + viewAmount(e);
  }

  return {
    schedule: "manual",
    heldByCurrency,
    // ISO-8601 UTC strings sort lexicographically, so the earliest release is
    // the first element — no Date parsing needed to find it.
    nextReleaseAt: held.map((e) => e.releaseAfter).sort()[0] ?? null,
    entries: entries.map(toPayoutEntryView),
  };
}
