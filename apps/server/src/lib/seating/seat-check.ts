/**
 * Can these seats be held? (docs/SEATING.md "Selling a seat".) Pure: the plan pinned at
 * registration, the event feed's band prices, our own minted seats and ONE chain read
 * (`seatBatch`: the event views, the seats' words and their nonces at one block). The
 * per-seat rules are the buyer map's (`seatStates`), so the server refuses exactly
 * what the map shows unavailable. Live holds are the store's to check, under its lock.
 */

import type { PaymentConfig } from "@woco/shared";
import { SEAT_FREE, seatStates, type ChainSeats } from "@woco/shared/seating/availability";
import type { SeatBatchRead } from "@woco/shared/seating/chain";
import { formatSeatLabel, seatLabel, ticketSeatOf, type SeatPlan } from "@woco/shared/seating/plan";
import { bandPricesMinor, seriesSeatingRefusal } from "@woco/shared/seating/series";
import { seatStateView } from "@woco/shared/seating/state";
import type { SeriesSeating } from "@woco/shared";
import type { SeatedHoldSeat, SeatVerify } from "../event/reservation-store.js";

export const SEATS_NOT_ON_SALE = "Tickets for this event are not currently on sale";
export const SEATS_UNREADABLE = "We couldn't check these seats just now. Try again in a moment.";

export function checkSeats(input: {
  plan: SeatPlan;
  planDigest: string;
  /** The event feed's band prices and payment, as served now. */
  seating: unknown;
  payment: PaymentConfig | undefined;
  /** Ascending, each once. */
  seats: readonly number[];
  minted: ReadonlySet<number>;
  chain: SeatBatchRead;
}): SeatVerify {
  const { plan, seats, chain } = input;
  const n = plan.seats.length;
  const outside = seats.filter((k) => k >= n);
  if (outside.length) return { ok: false, status: 409, error: "These seats are not on the seating plan", conflicts: outside };

  // The feed can be re-signed: its prices must still cover the plan exactly.
  if (seriesSeatingRefusal(input.seating, plan, input.payment)) return { ok: false, status: 409, error: SEATS_NOT_ON_SALE };
  const byId = bandPricesMinor(input.seating as SeriesSeating);
  const bandPrices = plan.bands.map((b) => byId.get(b.id) ?? null);

  const ev = chain.event;
  if (chain.block === null || !ev) return { ok: false, status: 503, error: SEATS_UNREADABLE };
  if (!ev.seated) return { ok: false, status: 409, error: SEATS_NOT_ON_SALE };
  // Every seat's word and nonce, from this one read: a seat freed between two reads
  // would otherwise sell unconfirmed (state.ts).
  const words: (bigint | null)[] = Array.from({ length: Math.ceil(n / 256) }, (_, w) => chain.words.get(w) ?? null);
  if (seats.some((k) => words[k >> 8] === null || !chain.nonces.has(k))) return { ok: false, status: 503, error: SEATS_UNREADABLE };

  const read: ChainSeats = {
    words,
    remaining: ev.remaining,
    cancelled: ev.cancelled,
    eventEndTs: ev.eventEndTs,
    blockTs: ev.blockTs,
    nonces: chain.nonces,
  };
  // The organiser's seat-state feed arrives with S6; until then the plan's own held
  // flags, and nothing confirmed, so a freed seat (nonce > 0) never sells.
  const states = seatStates(plan, { chain: read, organiser: seatStateView(plan, input.planDigest, null), onHold: [], bandPrices });
  if (states.sale === "cancelled") return { ok: false, status: 409, error: "This event has been cancelled" };
  if (states.sale === "closed") return { ok: false, status: 409, error: "Ticket sales for this event have closed" };
  if (states.sale === "sold-out") return { ok: false, status: 409, error: "Sold out" };
  if (states.sale !== "on-sale") return { ok: false, status: 503, error: SEATS_UNREADABLE };

  const taken = seats.filter((k) => states.codes[k] !== SEAT_FREE || input.minted.has(k));
  if (taken.length) return { ok: false, status: 409, error: "Some of these seats are no longer available. Choose others.", conflicts: taken };

  const out: SeatedHoldSeat[] = [];
  for (const k of seats) {
    const band = plan.bands[plan.seats[k].b];
    const label = seatLabel(plan, k);
    const ticketSeat = ticketSeatOf(plan, k);
    const price = bandPrices[plan.seats[k].b];
    if (!band || !label || !ticketSeat || price === null) return { ok: false, status: 409, error: SEATS_NOT_ON_SALE };
    out.push({ band: band.id, bandName: band.name, label: formatSeatLabel(label), ticketSeat, priceMinor: price });
  }
  return { ok: true, remaining: Number(ev.remaining), seats: out };
}
