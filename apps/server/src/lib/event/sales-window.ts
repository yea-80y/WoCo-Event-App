/**
 * Event sales-window gate (#241).
 *
 * The paid rails must refuse to CHARGE no later than the contract refuses to
 * MINT. WoCoEventV2 reverts `SalesClosed` on every claim path once
 * `block.timestamp >= eventEndTs` (contracts/src/WoCoEventV2.sol claimFor /
 * batchClaimFor), and the webhook's answer to a failed mint is
 * charge-then-auto-refund — exactly the outcome create-checkout's other gates
 * exist to avoid. The only pre-charge gate on event dates used to be the
 * client's "This event has ended" banner, which a stale tab, deep link, or
 * direct API call walks straight past.
 */

/**
 * Extra selling time after the event's end date. MUST stay 0 while the
 * contract closes mints sharp at `eventEndTs`: any positive value here opens a
 * window where the server takes payment for a mint the contract will refuse
 * (charge → SalesClosed revert → auto-refund). Door sales that need to run
 * past the end must get their grace added on-chain first, at registration
 * (routes/events.ts, where `eventEndTs` is derived from `endDate`), and only
 * then mirrored here.
 */
export const SALES_END_GRACE_MS = 0;

export type SalesWindowVerdict =
  | { open: true }
  | { open: false; reason: "ended" | "undated" };

/**
 * Decide whether tickets for an event may still be sold at `now`.
 *
 * Date semantics mirror the client's `isPastEvent`
 * (apps/web/src/lib/utils/events.ts): `endDate` when present and non-empty,
 * `startDate` otherwise — every state where the client hides the buy button,
 * the server refuses the charge. One deliberate divergence: a date that does
 * not parse is `open: false` here, where the client treats it as upcoming.
 * The create/update paths validate dates, so an unparseable date only reaches
 * this gate via a hand-crafted feed — and the money path refuses what it
 * cannot verify rather than defaulting to allow.
 */
export function checkSalesWindow(
  event: { startDate?: string; endDate?: string },
  now: number = Date.now(),
): SalesWindowVerdict {
  const raw =
    event.endDate && event.endDate.length > 0 ? event.endDate : event.startDate;
  const ts = raw ? new Date(raw).getTime() : NaN;
  if (Number.isNaN(ts)) return { open: false, reason: "undated" };
  if (now >= ts + SALES_END_GRACE_MS) return { open: false, reason: "ended" };
  return { open: true };
}

/** Buyer-facing refusal copy, shared by create-checkout and reserve so the
 *  two rails cannot drift apart. */
export function salesClosedMessage(reason: "ended" | "undated"): string {
  return reason === "ended"
    ? "This event has ended — tickets are no longer on sale."
    : "Tickets for this event are not currently on sale. Please contact the organiser.";
}
