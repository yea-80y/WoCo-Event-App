/**
 * A seated event's seat state (`woco.seatstate.v1`), the organiser-signed feed at
 * `seatStateTopic(eventId, seriesId)`, owned by the same feed signer as the event feed.
 * Latest version wins. It carries what changes after publish; the seats do not:
 *
 * - `holds`: seats kept back from sale, one bitmap per KIND of hold ("house seats",
 *   "press"...), a seat in at most one. Kinds are a fixed list, never free text: the
 *   feed is public, and a hold called after a sponsor or a fault would be public for
 *   good. Buyers only ever see "unavailable". Absent feed = the plan's own `h` flags
 *   (`initialHeldSeats`), read as house seats.
 * - `confirmed`: `[seat, seatNonce]` pairs. The ledger bumps a seat's `seatNonces`
 *   whenever a ticket leaves it (`_freeSeat`). The contract header asks every seat
 *   picker not to sell a seat an organiser-only move freed "until the account
 *   confirms it": a seat whose on-chain nonce is not 0 sells only while this list
 *   names that exact nonce. The organiser's dashboard writes it, signed by the feed
 *   signer - a different key from the organiser key a seat move is signed with - so a
 *   leaked organiser key alone cannot put a seat it emptied back on sale.
 * - `eventId` + `seriesId`: which seated ticket type the state is for (one plan = one
 *   seated series, and an event may have more than one). The plan digest alone is not
 *   unique (a plan can be reused), and the server keys its memory on the series.
 *
 * Bitmap encoding: lowercase hex of ceil(seats / 8) bytes; seat k is byte k >> 3,
 * bit (k & 7), least significant first. Bits at or past `seats` are zero. (Not the
 * ledger's `seatWord` layout, which packs 256 seats per uint256.) An empty hold is
 * left out, so a state names only the kinds in use.
 */

import { hasExactKeys, isIntIn, isPlainRecord } from "../validate.js";
import { MAX_PLAN_SEATS } from "./layout.js";
import { initialHeldSeats, type SeatPlan } from "./plan.js";

export const SEAT_STATE_FORMAT = "woco.seatstate.v1";

/** The kinds of hold, in the order a state lists them. Display names are the app's. */
export const SEAT_HOLD_KINDS = ["house", "guest", "press", "access", "unavailable", "other"] as const;
export type SeatHoldKind = (typeof SEAT_HOLD_KINDS)[number];
/** What the plan's own held flags read as before the organiser writes a state. */
export const PLAN_HOLD_KIND: SeatHoldKind = "house";

export interface SeatHold {
  kind: SeatHoldKind;
  /** Bitmap of the seats in this hold; at least one bit set. */
  held: string;
}

export interface SeatState {
  format: typeof SEAT_STATE_FORMAT;
  eventId: string;
  seriesId: string;
  /** The plan this state is for (its `seatPlanDigest`). */
  planDigest: string;
  seats: number;
  /** In `SEAT_HOLD_KINDS` order, each kind once, no seat in two. */
  holds: SeatHold[];
  /** Ascending by seat, each seat once, nonce >= 1. */
  confirmed: [number, number][];
  /** Counts the organiser's writes; never goes down. */
  seq: number;
  updatedAt: string;
}

const DIGEST_RE = /^0x[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]*$/;
/** As the event routes accept them (door-keys.ts, the ledger2 relay). */
const EVENT_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
const SERIES_ID_RE = /^[0-9A-Za-z_-]{1,100}$/;

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

/** Each hold well formed, in kind order, non-empty, and no seat in two of them. */
function validHolds(holds: unknown, seats: number): boolean {
  if (!Array.isArray(holds) || holds.length > SEAT_HOLD_KINDS.length) return false;
  let prev = -1;
  const union = new Uint8Array(heldBytes(seats));
  for (const h of holds) {
    if (!isPlainRecord(h) || !hasExactKeys(h, ["kind", "held"])) return false;
    const order = SEAT_HOLD_KINDS.indexOf(h.kind as SeatHoldKind);
    if (order <= prev) return false;
    prev = order;
    if (!validHeld(h.held, seats)) return false;
    let any = false;
    for (let i = 0; i < union.length; i++) {
      const byte = parseInt(h.held.slice(i * 2, i * 2 + 2), 16);
      if (byte & union[i]) return false;
      union[i] |= byte;
      if (byte) any = true;
    }
    if (!any) return false;
  }
  return true;
}

/** Closed-schema check. With `expect`, also that it belongs to that series and plan. */
export function validateSeatState(
  value: unknown,
  expect?: { eventId: string; seriesId: string; planDigest: string; seats: number },
): value is SeatState {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, ["format", "eventId", "seriesId", "planDigest", "seats", "holds", "confirmed", "seq", "updatedAt"])) return false;
  if (value.format !== SEAT_STATE_FORMAT) return false;
  if (typeof value.eventId !== "string" || !EVENT_ID_RE.test(value.eventId)) return false;
  if (typeof value.seriesId !== "string" || !SERIES_ID_RE.test(value.seriesId)) return false;
  if (typeof value.planDigest !== "string" || !DIGEST_RE.test(value.planDigest)) return false;
  if (!isIntIn(value.seats, 1, MAX_PLAN_SEATS)) return false;
  const seats = value.seats;
  if (!validHolds(value.holds, seats)) return false;
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
  if (
    expect &&
    (value.eventId !== expect.eventId || value.seriesId !== expect.seriesId ||
      value.planDigest !== expect.planDigest.toLowerCase() || seats !== expect.seats)
  ) {
    return false;
  }
  return true;
}

export function buildSeatState(input: {
  eventId: string;
  seriesId: string;
  planDigest: string;
  seats: number;
  /** Seat -> its hold. */
  holds: ReadonlyMap<number, SeatHoldKind>;
  confirmed: ReadonlyMap<number, number>;
  seq: number;
  updatedAt: string;
}): SeatState {
  const byKind = new Map<SeatHoldKind, number[]>();
  for (const [k, kind] of input.holds) {
    const list = byKind.get(kind) ?? [];
    list.push(k);
    byKind.set(kind, list);
  }
  // Key order is the wire order: the short fields first, so the first 4 KB page of a
  // large state still names the series and `seq` (`seatStateWriteSignal`).
  const state: SeatState = {
    format: SEAT_STATE_FORMAT,
    eventId: input.eventId,
    seriesId: input.seriesId,
    planDigest: input.planDigest.toLowerCase(),
    seats: input.seats,
    seq: input.seq,
    updatedAt: input.updatedAt,
    holds: SEAT_HOLD_KINDS.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, held: encodeHeld(byKind.get(kind)!, input.seats) })),
    confirmed: [...input.confirmed].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]),
  };
  if (!validateSeatState(state)) throw new Error("invalid seat state");
  return state;
}

const SIGNAL_RE =
  /^\{"format":"woco\.seatstate\.v1","eventId":"([0-9A-Za-z_-]{1,128})","seriesId":"([0-9A-Za-z_-]{1,100})","planDigest":"0x[0-9a-f]{64}","seats":[1-9]\d{0,5},"seq":(0|[1-9]\d{0,15}),/;

/**
 * What a relayed chunk says about a seat-state write about to land: the event and the
 * new `seq`, read from the START of the payload - the whole state when it fits one
 * chunk, else its first page (pages go up before the version's head, and the head of a
 * paged state is a bare page count). Only `buildSeatState`'s key order matches. Null for
 * anything else. A signal is a claim, not a state: the server only uses it to stop
 * trusting OLDER reads for a short while.
 */
export function seatStateWriteSignal(payload: Uint8Array): { eventId: string; seriesId: string; seq: number } | null {
  const head = new TextDecoder().decode(payload.subarray(0, 512));
  const m = SIGNAL_RE.exec(head);
  if (!m) return null;
  const seq = Number(m[3]);
  return Number.isSafeInteger(seq) ? { eventId: m[1], seriesId: m[2], seq } : null;
}

/** What the seat state says about each seat, with the plan's own flags when there is no state yet. */
export interface SeatStateView {
  /** Every held seat, whatever its hold. */
  held: ReadonlySet<number>;
  /** Each held seat's kind of hold. */
  holds: ReadonlyMap<number, SeatHoldKind>;
  confirmed: ReadonlyMap<number, number>;
}

/**
 * The view to sell from. `state` must already be validated; a state for another plan is
 * ignored here (the plan's flags apply, nothing confirmed). The buyer map takes that
 * lenient reading; the server treats such a state as unreadable instead
 * (`lib/seating/seat-state-gate.ts`).
 */
export function seatStateView(plan: Pick<SeatPlan, "items" | "seats">, planDigest: string, state: SeatState | null): SeatStateView {
  if (!state || state.planDigest !== planDigest.toLowerCase() || state.seats !== plan.seats.length) {
    const held = initialHeldSeats(plan);
    return { held, holds: new Map([...held].map((k) => [k, PLAN_HOLD_KIND])), confirmed: new Map() };
  }
  const holds = new Map<number, SeatHoldKind>();
  for (const h of state.holds) for (const k of decodeHeld(h.held, state.seats)) holds.set(k, h.kind);
  return { held: new Set(holds.keys()), holds, confirmed: new Map(state.confirmed) };
}

/**
 * Whether the organiser lets seat `k` sell: not held, and either never freed on
 * chain (`seatNonce` 0) or freed and confirmed at exactly that nonce. Whether a
 * ticket holds it now is the chain's `seatWord`, checked separately - and in the SAME
 * read as `seatNonces`, or a seat freed between the two reads sells unconfirmed.
 *
 * Stricter than the contract header asks: a seat freed by ANY move (a holder-consented
 * `reseat` included, not only an organiser-only one) waits for confirmation. One rule
 * for every freed seat; the organiser confirms with one tap.
 */
export function organiserAllowsSale(view: SeatStateView, k: number, seatNonce: number | bigint): boolean {
  if (view.held.has(k)) return false;
  const n = typeof seatNonce === "bigint" ? seatNonce : BigInt(seatNonce);
  if (n === 0n) return true;
  const c = view.confirmed.get(k);
  return c !== undefined && BigInt(c) === n;
}
