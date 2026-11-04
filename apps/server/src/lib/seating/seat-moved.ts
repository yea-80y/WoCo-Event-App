/**
 * "Your seat has changed" (docs/SEATING.md S6, S5 D3): after an organiser moves a
 * ticket, its buyer is told the new seat. S6 consult (Fable, 2026-11-04):
 *
 *   - NO ticket or QR in it. The QR exists only in the held copy sealed to the
 *     organiser, and #983 serves that copy only for a ticket that did not arrive; opening
 *     it for a move would let an organiser open any live ticket's QR by moving it. The
 *     buyer keeps the ticket they have; the door reads the new seat.
 *   - The address must be THAT sale's buyer: the order's own email hash (attendee
 *     ledger, through the sale's `orderRef`) or an address a #983 resend of that sale
 *     went to. Event-wide membership would tell an organiser whether any address bought,
 *     send one buyer's seat to another, and still reach an erased buyer.
 *   - Erased or burned orders are refused. The organiser is the event's write-once
 *     record creator, never the feed's description of itself.
 *   - What is sent is the seat the ledger says NOW (`seatOf` + the pinned plan), built
 *     here: no organiser-written text. A ticket moved and moved back is mailed again.
 *   - The server sees the address once, to send; it is never stored or logged.
 */

import { MAILABLE_EMAIL_RE } from "@woco/shared";
import type { TicketSeat } from "@woco/shared/seating/ticket-seat";
import { SlidingWindowLimiter } from "../http/rate-limit.js";

export const SEAT_MOVED_MAX_SLOTS = 50;
/** One buyer, one ticket, one seat: mailed once a day at most. */
const DEDUPE_MS = 24 * 60 * 60_000;

/**
 * Per ticket: emailed now, or not. Never why not - "not this buyer", "erased", "no such
 * sale", "no seat now" and "already sent" all read the same, so the reply cannot be
 * used to test whether an address bought a ticket (automated security review).
 */
export type SlotOutcome = "sent" | "not_sent";

export interface SeatMovedDeps {
  recordedCreator(eventId: string): string | null;
  seatedAllowed(): boolean;
  event(eventId: string): Promise<{ title: string; series: Array<{ seriesId: string; onChainEventId?: string; swarmManifestRef?: string }> } | null>;
  /** The sale that minted `slot` of this series, with its order and resends. */
  saleOf(eventId: string, seriesId: string, onChainEventId: string, slot: number): {
    sessionId: string;
    orderRef?: string;
    resends?: Array<{ toHash: string; accepted: boolean }>;
  } | null;
  /** The order's buyer hash and whether it was erased; null when there is no record. */
  order(orderRef: string): { emailHash?: string; erased: boolean } | null;
  hashEmail(email: string): string;
  currentSeats(a: { eventId: string; seriesId: string; onChainEventId: string; swarmManifestRef?: string; slots: readonly number[] }): Promise<
    { kind: "seats"; seats: Map<number, TicketSeat | "none"> } | { kind: "unseated" } | { kind: "unreadable" }
  >;
  send(a: { to: string; eventTitle: string; seats: Array<{ edition: number; seat: TicketSeat }> }): Promise<void>;
  now(): number;
}

export type SeatMovedReply =
  | { ok: true; status: 200; data: { slots: Array<{ slot: number; outcome: SlotOutcome }> } }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429 | 502 | 503; error: string; code: string };

const fail = (status: Extract<SeatMovedReply, { ok: false }>["status"], code: string, error: string): SeatMovedReply => ({ ok: false, status, error, code });

/** The route's memory: what was mailed (24 h) and the misuse barriers. In memory only. */
export function seatMovedState() {
  return {
    sent: new Map<string, number>(),
    perEvent: new SlidingWindowLimiter([{ limit: 300, windowMs: 24 * 60 * 60_000 }]),
    perAccount: new SlidingWindowLimiter([{ limit: 60, windowMs: 60 * 60_000 }]),
  };
}
export type SeatMovedState = ReturnType<typeof seatMovedState>;

export async function seatMoved(
  deps: SeatMovedDeps,
  st: SeatMovedState,
  eventId: string,
  parent: string,
  body: { seriesId?: unknown; slots?: unknown; to?: unknown },
): Promise<SeatMovedReply> {
  if (!deps.seatedAllowed()) return fail(404, "NOT_AVAILABLE", "Not available");
  const creator = deps.recordedCreator(eventId);
  if (!creator || creator.toLowerCase() !== parent.toLowerCase()) return fail(403, "NOT_ORGANISER", "Only the event's organiser can do this");
  const { seriesId, slots, to } = body;
  if (typeof seriesId !== "string" || !/^[\w-]{1,100}$/.test(seriesId)) return fail(400, "BAD_BODY", "Which ticket type?");
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > SEAT_MOVED_MAX_SLOTS) return fail(400, "BAD_BODY", "Which tickets?");
  if (!slots.every((s) => Number.isSafeInteger(s) && s >= 0) || new Set(slots).size !== slots.length) return fail(400, "BAD_BODY", "Which tickets?");
  if (typeof to !== "string" || to.length > 254 || !MAILABLE_EMAIL_RE.test(to)) return fail(400, "BAD_EMAIL", "That email address can't be used");

  if (!st.perAccount.peek(parent.toLowerCase()) || !st.perEvent.peek(eventId)) return fail(429, "RATE_LIMITED", "Too many emails for now. Try again later.");
  // Every request that compares an address counts, sent or not.
  st.perAccount.record(parent.toLowerCase());
  st.perEvent.record(eventId);

  const event = await deps.event(eventId).catch(() => null);
  const series = event?.series.find((s) => s.seriesId === seriesId);
  if (!event || !series?.onChainEventId) return fail(404, "NOT_FOUND", "Ticket type not found");
  const onChainEventId = series.onChainEventId.toLowerCase();

  const toHash = deps.hashEmail(to);
  const out: Array<{ slot: number; outcome: SlotOutcome }> = [];
  const mine: number[] = [];
  const sessions = new Map<number, string>();
  for (const slot of slots as number[]) {
    const sale = deps.saleOf(eventId, seriesId, onChainEventId, slot);
    // No sale, no order record (an erasure, or a sale from before sealed orders), an
    // erased order, or another address: not sent, and not said why.
    const order = sale?.orderRef ? deps.order(sale.orderRef) : null;
    const buyer = !!sale && !!order && !order.erased &&
      (order.emailHash === toHash || !!sale.resends?.some((r) => r.accepted && r.toHash === toHash));
    if (!buyer) { out.push({ slot, outcome: "not_sent" }); continue; }
    mine.push(slot);
    sessions.set(slot, sale.sessionId);
  }
  if (mine.length === 0) return { ok: true, status: 200, data: { slots: out } };

  const current = await deps.currentSeats({ eventId, seriesId, onChainEventId, swarmManifestRef: series.swarmManifestRef, slots: mine });
  if (current.kind === "unreadable") return fail(503, "SEATS_UNREADABLE", "The new seats couldn't be read just now. Try again in a moment.");
  if (current.kind === "unseated") return fail(409, "NOT_SEATED", "This ticket type has no seats");

  const now = deps.now();
  for (const [k, at] of st.sent) if (now - at >= DEDUPE_MS) st.sent.delete(k);
  const seats: Array<{ edition: number; seat: TicketSeat }> = [];
  const keys: string[] = [];
  for (const slot of mine) {
    const seat = current.seats.get(slot);
    if (!seat || seat === "none") { out.push({ slot, outcome: "not_sent" }); continue; }
    const key = `${sessions.get(slot)}|${slot}|${JSON.stringify(seat)}`;
    if (st.sent.has(key)) { out.push({ slot, outcome: "not_sent" }); continue; }
    seats.push({ edition: slot + 1, seat });
    keys.push(key);
  }
  if (seats.length > 0) {
    try {
      await deps.send({ to, eventTitle: event.title, seats });
    } catch {
      return fail(502, "SEND_FAILED", "The email couldn't be sent just now. Try again in a moment.");
    }
    for (const k of keys) st.sent.set(k, now);
    for (const s of seats) out.push({ slot: s.edition - 1, outcome: "sent" });
  }
  out.sort((a, b) => a.slot - b.slot);
  return { ok: true, status: 200, data: { slots: out } };
}
