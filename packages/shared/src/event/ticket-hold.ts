/**
 * A held ticket (#983): what fulfilment seals to the organiser's order key for each
 * ticket it emails, so a ticket whose email bounces can be sent again - the same
 * ticket, not a new one. The QR's contents exist nowhere else: the key that signed
 * it is discarded at mint.
 *
 * Sealed under `ticketHoldSealContext(eventId, seriesId, edition)`; the server holds
 * the box, never the plaintext, and only the organiser's client can open it.
 */
export interface TicketHoldPlaintext {
  v: 1;
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
export function isTicketHoldPlaintext(x: unknown, eventId: string, seriesId: string, edition: number): x is TicketHoldPlaintext {
  const p = x as Partial<TicketHoldPlaintext> | null;
  return (
    !!p && p.v === 1 && p.seriesId === seriesId && p.edition === edition &&
    typeof p.qrContent === "string" && ticketQrNamesSeat(p.qrContent, eventId, seriesId, edition)
  );
}
