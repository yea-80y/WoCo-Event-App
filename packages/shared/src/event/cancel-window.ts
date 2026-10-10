/**
 * How long after an event ends its organiser can still cancel it and refund
 * everyone (#644; owner decision 2026-09-26). Past it the event happened and
 * its takings may already be paid out, so the organiser refunds individual
 * buyers from Stripe instead. Ops can still cancel past it. Must not exceed
 * the server's POST_EVENT_RELEASE_DAYS (a server test pins it), so for dates
 * unchanged since the sale the window closes no later than the money is
 * released. A postponed event is measured from its new date, while its
 * takings keep the release date pinned when they were sold.
 */
export const ORGANISER_CANCEL_WINDOW_DAYS = 2;

const DAY_MS = 86_400_000;

/**
 * When the organiser's cancel window closes (ms since epoch), measured from the
 * end, else the start — the same anchor the payout release uses. Null when
 * neither date parses: nothing to measure from, so nobody is refused.
 */
export function organiserCancelClosesAt(event: { endDate?: string; startDate?: string }): number | null {
  for (const d of [event.endDate, event.startDate]) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (Number.isFinite(t)) return t + ORGANISER_CANCEL_WINDOW_DAYS * DAY_MS;
  }
  return null;
}
