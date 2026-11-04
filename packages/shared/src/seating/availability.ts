/**
 * Which seats of a seated series can be bought right now, from what the chain, the
 * organiser and our server each say (docs/SEATING.md "Selling a seat"). Pure: the
 * buyer's map uses it in the browser; the server's per-seat checks (S4) use the
 * same rules.
 *
 * Seat k is free only if no ticket holds it (the ledger's `seatWord` bit), its band
 * has a price, the organiser does not keep it back, the organiser has confirmed it
 * if a ticket ever left it (`organiserAllowsSale`), and nobody else holds it. The
 * series is on sale only while `remaining()` is above 0, sales are open and the
 * event is not cancelled.
 */

import { organiserAllowsSale, type SeatStateView } from "./state.js";
import type { SeatPlan } from "./plan.js";

/** One read of the ledger for a seated event. */
export interface ChainSeats {
  /** `seatWord(eventId, w)` for w = 0 .. ceil(seats / 256) - 1; null = that word could not be read. */
  words: readonly (bigint | null)[];
  remaining: bigint;
  cancelled: boolean;
  eventEndTs: bigint;
  /** The block timestamp the read ran at: "sales closed" goes by the chain's clock. */
  blockTs: bigint;
  /** `seatNonces` for the seats read (picked seats and best-seat candidates). */
  nonces?: ReadonlyMap<number, bigint>;
}

/**
 *   on-sale    seats can be picked
 *   sold-out   `remaining()` is 0 with sales open (every ticket sold, or capacity cut)
 *   closed     the sales cutoff has passed
 *   cancelled  the event was cancelled
 *   unknown    the chain could not be read: the map draws, nothing can be picked
 */
export type SaleState = "on-sale" | "sold-out" | "closed" | "cancelled" | "unknown";

export function saleState(chain: Pick<ChainSeats, "remaining" | "cancelled" | "eventEndTs" | "blockTs"> | null): SaleState {
  if (!chain) return "unknown";
  if (chain.cancelled) return "cancelled";
  if (chain.blockTs >= chain.eventEndTs) return "closed";
  return chain.remaining > 0n ? "on-sale" : "sold-out";
}

export const SEAT_FREE = 0;
/** A ticket holds it. */
export const SEAT_TAKEN = 1;
/** Its band has no price in the event: never sold. */
export const SEAT_NO_PRICE = 2;
/** The organiser keeps it back. */
export const SEAT_HELD = 3;
/** A ticket left it and the organiser has not put it back on sale. */
export const SEAT_UNCONFIRMED = 4;
/** Someone else's hold, or paid and not on the chain yet. */
export const SEAT_ON_HOLD = 5;
/** Its word of the ledger could not be read. */
export const SEAT_UNKNOWN = 6;

export type SeatCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface SeatStateInput {
  chain: ChainSeats | null;
  /** The organiser's seat state (S1 `seatStateView`): held seats and confirmed nonces. */
  organiser: SeatStateView;
  /** Seats the server would refuse (the live holds route). Out-of-range entries are ignored. */
  onHold: Iterable<number>;
  /** The buyer's own hold: never shown as someone else's. */
  mine?: Iterable<number>;
  /** Price in minor units by plan band index; null for a band the event does not price. */
  bandPrices: readonly (number | null)[];
}

export interface SeatStates {
  sale: SaleState;
  /** One code per seat. With the chain unread every seat the other sources allow reads SEAT_UNKNOWN. */
  codes: Uint8Array;
}

export function seatStates(plan: Pick<SeatPlan, "seats">, input: SeatStateInput): SeatStates {
  const n = plan.seats.length;
  const codes = new Uint8Array(n);
  const { chain, organiser } = input;
  const mine = new Set(input.mine ?? []);
  const onHold = new Set<number>();
  for (const k of input.onHold) if (Number.isInteger(k) && k >= 0 && k < n && !mine.has(k)) onHold.add(k);
  // Each word as 32 bytes, least significant first: one conversion per 256 seats.
  const words = chain ? Array.from({ length: Math.ceil(n / 256) }, (_, w) => wordBits(chain.words[w])) : null;
  for (let k = 0; k < n; k++) {
    if (words) {
      const bits = words[k >> 8];
      if (!bits) { codes[k] = SEAT_UNKNOWN; continue; }
      const bit = k & 255;
      if (bits[bit >> 3] & (1 << (bit & 7))) { codes[k] = SEAT_TAKEN; continue; }
    }
    if (input.bandPrices[plan.seats[k].b] == null) codes[k] = SEAT_NO_PRICE;
    else if (organiser.held.has(k)) codes[k] = SEAT_HELD;
    else if (chain?.nonces?.has(k) && !organiserAllowsSale(organiser, k, chain.nonces.get(k)!)) codes[k] = SEAT_UNCONFIRMED;
    else if (onHold.has(k)) codes[k] = SEAT_ON_HOLD;
    else if (!chain) codes[k] = SEAT_UNKNOWN;
  }
  return { sale: saleState(chain), codes };
}

function wordBits(w: bigint | null | undefined): Uint8Array | null {
  if (w === null || w === undefined || w < 0n || w >= 1n << 256n) return null;
  const hex = w.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(62 - 2 * i, 64 - 2 * i), 16);
  return out;
}

/** Seat `k` may be picked: the series is on sale and the seat is free. */
export const pickable = (s: SeatStates, k: number): boolean => s.sale === "on-sale" && s.codes[k] === SEAT_FREE;

/** Why seat `k` is not available, in a buyer's words (spoken after its label); null when it is. */
export function seatReason(code: number): string | null {
  switch (code) {
    case SEAT_FREE: return null;
    case SEAT_TAKEN: return "sold";
    case SEAT_ON_HOLD: return "being bought";
    case SEAT_UNKNOWN: return "can't check right now";
    default: return "not available";
  }
}
