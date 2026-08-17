/**
 * Per-series sale-window gate (#295).
 *
 * `SeriesSummary.saleStart`/`saleEnd` were documented "(server-enforced)" while
 * nothing read them on any money path — an imported tier with a lapsed
 * `saleEnd` stayed purchasable while the event's own JSON-LD told search
 * engines (`offers.validFrom`/`validThrough`) that it wasn't, and a future
 * `saleStart` held nothing back. This module makes the doc true. It is the
 * series-level sibling of the event-level gate in `sales-window.ts` (#241) and
 * runs in the same two places: create-checkout and reserve.
 *
 * Date semantics mirror the client's `saleStatus` (EventPage.svelte and the
 * main app's `sale-window.ts`): an absent or empty field is no constraint.
 * One deliberate divergence, same as #241's: a PRESENT date that does not
 * parse refuses here, where the client treats it as no constraint. The
 * create/import paths produce well-formed values, so an unparseable one only
 * reaches this gate via a hand-crafted feed — and the money path refuses what
 * it cannot verify rather than defaulting to allow.
 */

export type SeriesSaleVerdict =
  | { open: true }
  | { open: false; reason: "not-yet" | "closed" | "unparseable" };

/** Decide whether THIS series may be sold at `now` (the event-level end gate
 *  in sales-window.ts still applies separately). */
export function checkSeriesSaleWindow(
  series: { saleStart?: string; saleEnd?: string },
  now: number = Date.now(),
): SeriesSaleVerdict {
  if (series.saleStart && series.saleStart.length > 0) {
    const ts = new Date(series.saleStart).getTime();
    if (Number.isNaN(ts)) return { open: false, reason: "unparseable" };
    if (now < ts) return { open: false, reason: "not-yet" };
  }
  if (series.saleEnd && series.saleEnd.length > 0) {
    const ts = new Date(series.saleEnd).getTime();
    if (Number.isNaN(ts)) return { open: false, reason: "unparseable" };
    if (now >= ts) return { open: false, reason: "closed" };
  }
  return { open: true };
}

/** Buyer-facing refusal copy, shared by create-checkout and reserve so the two
 *  rails cannot drift apart (same contract as `salesClosedMessage`). */
export function seriesSaleMessage(reason: "not-yet" | "closed" | "unparseable"): string {
  if (reason === "not-yet") return "This ticket isn't on sale yet.";
  if (reason === "closed") return "Sales for this ticket have closed.";
  return "Tickets for this event are not currently on sale. Please contact the organiser.";
}
