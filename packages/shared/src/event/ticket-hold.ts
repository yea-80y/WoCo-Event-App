/**
 * A held ticket (#983): what fulfilment seals to the organiser's order key for each
 * ticket it emails, so a ticket whose email bounces can be sent again - the same
 * ticket, not a new one. The QR's contents exist nowhere else: the key that signed
 * it is discarded at mint.
 *
 * Sealed under `ticketHoldSealContext(eventId, seriesId, edition, sessionId)`; the
 * server holds the box, never the plaintext, and only the organiser's client can open it.
 */
/** A Stripe Checkout Session id: one sale, and the name of its held-ticket file. */
export const CHECKOUT_SESSION_RE = /^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/;

export interface TicketHoldPlaintext {
  v: 1;
  /** The sale it was emailed for - also in the AAD. */
  sessionId: string;
  seriesId: string;
  edition: number;
  /** The ticket's QR contents, exactly as emailed. */
  qrContent: string;
}

/** The QR fulfilment emails for one seat: `woco://t/{eventId}/{seriesId}/{edition}/{sig}`. */
export function ticketQrNamesSeat(qrContent: string, eventId: string, seriesId: string, edition: number): boolean {
  const m = /^woco:\/\/t\/([0-9a-z-]{1,64})\/([0-9a-z-]{1,64})\/([1-9][0-9]{0,9})\/0x[0-9a-fA-F]{130}$/.exec(qrContent);
  return !!m && m[1] === eventId && m[2] === seriesId && Number(m[3]) === edition;
}

/** A box that opens to anything but this seat's held ticket is refused, never shown. */
export function isTicketHoldPlaintext(
  x: unknown,
  seat: { eventId: string; seriesId: string; edition: number; sessionId: string },
): x is TicketHoldPlaintext {
  const { eventId, seriesId, edition, sessionId } = seat;
  const p = x as Partial<TicketHoldPlaintext> | null;
  return (
    !!p && p.v === 1 && p.sessionId === sessionId && p.seriesId === seriesId && p.edition === edition &&
    typeof p.qrContent === "string" && ticketQrNamesSeat(p.qrContent, eventId, seriesId, edition)
  );
}
