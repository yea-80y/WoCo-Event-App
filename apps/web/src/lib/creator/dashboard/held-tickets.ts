/**
 * Opening a sale's held tickets on the organiser's device (#983). Pure - no app state -
 * so it is tested with real seals; `api/undelivered.ts` fetches and sends.
 */
import { isTicketHoldPlaintext } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";

export interface HeldCopy {
  eventId: string;
  seriesId: string;
  orderKeyRef: string;
  tickets: Array<{ edition: number; box: SealedBoxV2 }>;
}

/**
 * Open a sale's held tickets with whichever of the organiser's order keys sealed them.
 * Every box must open under ITS seat and THIS sale and name that seat's QR - one that
 * does not is refused, never sent on.
 */
export async function openHeldTickets(
  copy: HeldCopy,
  sessionId: string,
  secretKeys: Uint8Array[],
  open: <T>(keys: Uint8Array[], box: unknown, ctx: { info: string; aad: string }) => Promise<T>,
): Promise<Array<{ edition: number; qrContent: string }>> {
  const { ticketHoldSealContext } = await import("@woco/shared/crypto/sealed-box");
  const out: Array<{ edition: number; qrContent: string }> = [];
  for (const t of copy.tickets) {
    const seat = { eventId: copy.eventId, seriesId: copy.seriesId, edition: t.edition, sessionId };
    const plain = await open<unknown>(secretKeys, t.box, ticketHoldSealContext(copy.eventId, copy.seriesId, t.edition, sessionId));
    if (!isTicketHoldPlaintext(plain, seat)) throw new Error("A held ticket did not match its order.");
    out.push({ edition: t.edition, qrContent: plain.qrContent });
  }
  return out;
}

