/**
 * A seated event's seat state (`woco.seatstate.v1`), the organiser-signed feed at
 * `eventSeatStateTopic(eventId)`, owned by the same feed signer as the event feed.
 * Latest version wins. It carries what changes after publish; the seats do not:
 *
 * - `held`: seats kept back from sale, a bitmap over the plan's seats. Absent feed =
 *   the plan's own `h` flags (`initialHeldSeats`).
 * - `confirmed`: `[seat, seatNonce]` pairs. The ledger bumps a seat's `seatNonces`
 *   whenever a ticket leaves it (`_freeSeat`). The contract header asks every seat
 *   picker not to sell a seat an organiser-only move freed "until the account
 *   confirms it": a seat whose on-chain nonce is not 0 sells only while this list
 *   names that exact nonce. The organiser's dashboard writes it, signed by the feed
 *   signer - a different key from the organiser key a seat move is signed with - so a
 *   leaked organiser key alone cannot put a seat it emptied back on sale.
 *
 * Bitmap encoding: lowercase hex of ceil(seats / 8) bytes; seat k is byte k >> 3,
 * bit (k & 7), least significant first. Bits at or past `seats` are zero. (Not the
 * ledger's `seatWord` layout, which packs 256 seats per uint256.)
 */

import { hasExactKeys, isIntIn, isPlainRecord } from "../validate.js";
import { MAX_PLAN_SEATS } from "./layout.js";
import { initialHeldSeats, type SeatPlan } from "./plan.js";

export const SEAT_STATE_FORMAT = "woco.seatstate.v1";

export interface SeatState {
  format: typeof SEAT_STATE_FORMAT;
  /** The plan this state is for (its `seatPlanDigest`). */
  planDigest: string;
  seats: number;
  held: string;
  /** Ascending by seat, each seat once, nonce >= 1. */
  confirmed: [number, number][];
  /** Counts the organiser's writes; never goes down. */
  seq: number;
  updatedAt: string;
}

const DIGEST_RE = /^0x[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]*$/;

export const heldBytes = (seats: number) => Math.ceil(seats / 8);

export function encodeHeld(held: Iterable<number>, seats: number): string {
  const bytes = new Uint8Array(heldBytes(seats));
  for (const k of held) {
    if (!isIntIn(k, 0, seats - 1)) throw new RangeError("held seat out of range");
    bytes[k >> 3] |= 1 << (k & 7);
  }
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** The held seats of a well-formed bitmap. */
export function decodeHeld(hex: string, seats: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < heldBytes(seats); i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!byte) continue;
    for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out.add(i * 8 + bit);
  }
  return out;
}

function validHeld(hex: unknown, seats: number): hex is string {
  if (typeof hex !== "string" || hex.length !== heldBytes(seats) * 2 || !HEX_RE.test(hex)) return false;
  const tailBits = seats & 7;
  if (tailBits === 0 || hex.length === 0) return true;
  const last = parseInt(hex.slice(-2), 16);
  return (last >> tailBits) === 0;
}

/** Closed-schema check. With `expect`, also that it belongs to that plan. */
export function validateSeatState(value: unknown, expect?: { planDigest: string; seats: number }): value is SeatState {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, ["format", "planDigest", "seats", "held", "confirmed", "seq", "updatedAt"])) return false;
  if (value.format !== SEAT_STATE_FORMAT) return false;
  if (typeof value.planDigest !== "string" || !DIGEST_RE.test(value.planDigest)) return false;
  if (!isIntIn(value.seats, 1, MAX_PLAN_SEATS)) return false;
  const seats = value.seats;
  if (!validHeld(value.held, seats)) return false;
  if (!Array.isArray(value.confirmed) || value.confirmed.length > seats) return false;
  let prev = -1;
  for (const pair of value.confirmed) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [seat, nonce] = pair as unknown[];
    if (!isIntIn(seat, prev + 1, seats - 1) || !isIntIn(nonce, 1, Number.MAX_SAFE_INTEGER)) return false;
    prev = seat;
  }
  if (!isIntIn(value.seq, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (typeof value.updatedAt !== "string" || value.updatedAt.length > 40 || Number.isNaN(Date.parse(value.updatedAt))) return false;
  if (expect && (value.planDigest !== expect.planDigest.toLowerCase() || seats !== expect.seats)) return false;
  return true;
}

export function buildSeatState(input: {
  planDigest: string;
  seats: number;
  held: Iterable<number>;
  confirmed: ReadonlyMap<number, number>;
  seq: number;
  updatedAt: string;
}): SeatState {
  const state: SeatState = {
    format: SEAT_STATE_FORMAT,
    planDigest: input.planDigest.toLowerCase(),
    seats: input.seats,
    held: encodeHeld(input.held, input.seats),
    confirmed: [...input.confirmed].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]),
    seq: input.seq,
    updatedAt: input.updatedAt,
  };
  if (!validateSeatState(state)) throw new Error("invalid seat state");
  return state;
}

/** What the seat state says about each seat, with the plan's own flags when there is no state yet. */
export interface SeatStateView {
  held: ReadonlySet<number>;
  confirmed: ReadonlyMap<number, number>;
}

/**
 * The view to sell from. `state` must already be validated against this plan; a
 * state for another plan is ignored (the plan's flags apply, nothing confirmed).
 */
export function seatStateView(plan: Pick<SeatPlan, "items" | "seats">, planDigest: string, state: SeatState | null): SeatStateView {
  if (!state || state.planDigest !== planDigest.toLowerCase() || state.seats !== plan.seats.length) {
    return { held: initialHeldSeats(plan), confirmed: new Map() };
  }
  return { held: decodeHeld(state.held, state.seats), confirmed: new Map(state.confirmed) };
}

/**
 * Whether the organiser lets seat `k` sell: not held, and either never freed on
 * chain (`seatNonce` 0) or freed and confirmed at exactly that nonce. Whether a
 * ticket holds it now is the chain's `seatWord`, checked separately.
 */
export function organiserAllowsSale(view: SeatStateView, k: number, seatNonce: number | bigint): boolean {
  if (view.held.has(k)) return false;
  const n = typeof seatNonce === "bigint" ? seatNonce : BigInt(seatNonce);
  if (n === 0n) return true;
  const c = view.confirmed.get(k);
  return c !== undefined && BigInt(c) === n;
}
