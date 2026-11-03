/**
 * The buyer's map as data: where every seat is, which seats can be picked right now,
 * and what a pick looks like in words. Pure (no DOM), so the picker (picker.ts), each
 * host's order panel and the tests share one implementation. docs/SEATING.md.
 *
 * A seat index `k` is the plan's walk order, which is also the ledger's seat number.
 * An item's seats are numbered contiguously by that walk, so a section is a range.
 */

import { formatSeatLabel, seatLabel, seatRefs, type SeatPlan, type SeatRef } from "@woco/shared/seating/plan";
import { bestSeats, loneSeatLeft, seatRuns, type SeatRun } from "@woco/shared/seating/best";
import { itemWorldBox, planFocus, seatWorldPoints, unionBox, type Box } from "@woco/shared/seating/geometry";
import { hasSeats, type LayoutItem } from "@woco/shared/seating/layout";
import { CURRENCY_SYMBOLS } from "@woco/shared/event/fees";

export interface Section {
  item: number;
  name: string;
  table: boolean;
  /** Room-space box. */
  box: Box;
  /** The item's seats are `first .. first + count - 1`. */
  first: number;
  count: number;
}

export interface BuyerPlan {
  plan: SeatPlan;
  /** The plan's `seatPlanDigest`: what a hold names, so a hold is for the plan the buyer saw. */
  digest: string;
  seats: number;
  refs: SeatRef[];
  runs: SeatRun[];
  /** `runsOf[item][row]` = that row's seat indices by position, -1 for a gap. */
  runsOf: number[][][];
  /** Room-space centre of each seat. */
  points: { x: number; y: number }[];
  focus: { x: number; y: number };
  sections: Section[];
  /** Section index of each item, -1 for an item without seats. */
  sectionOf: number[];
  bounds: Box;
}

export function buyerPlan(plan: SeatPlan, digest: string): BuyerPlan {
  const refs = seatRefs(plan.items);
  const runs = seatRuns(plan.items);
  const runsOf: number[][][] = plan.items.map(() => []);
  for (const r of runs) runsOf[r.item][r.row] = r.seats;
  const sections: Section[] = [];
  const sectionOf = plan.items.map(() => -1);
  let k = 0;
  plan.items.forEach((it, item) => {
    if (!hasSeats(it)) return;
    const count = runsOf[item].reduce((n, row) => n + row.filter((s) => s >= 0).length, 0);
    if (count === 0) return;
    sectionOf[item] = sections.length;
    sections.push({ item, name: it.name, table: it.kind === "table", box: itemWorldBox(it), first: k, count });
    k += count;
  });
  return {
    plan,
    digest: digest.toLowerCase(),
    seats: plan.seats.length,
    refs,
    runs,
    runsOf,
    points: seatWorldPoints(plan.items),
    focus: planFocus(plan.items),
    sections,
    sectionOf,
    bounds: unionBox(plan.items),
  };
}

/** Seat index at (item, row, pos), or -1 (a gap, or nothing there). */
export function seatAt(bp: BuyerPlan, item: number, row: number, pos: number): number {
  return bp.runsOf[item]?.[row]?.[pos] ?? -1;
}

// ---------------------------------------------------------------------------
// What the chain says, and what each seat is right now
// ---------------------------------------------------------------------------

/** One read of the ledger for a seated event (`load.ts` fills it). */
export interface ChainSeats {
  /** `seatWord(eventId, w)` for w = 0 .. ceil(seats / 256) - 1: bit set = a ticket holds the seat. */
  words: readonly bigint[];
  remaining: bigint;
  cancelled: boolean;
  eventEndTs: bigint;
  /** The block's timestamp the read ran at, so "sales closed" uses the chain's clock. */
  blockTs: bigint;
}

/**
 * The series as a whole:
 *   on-sale    seats can be picked
 *   sold-out   `remaining()` is 0 with sales open (every ticket sold, or capacity cut)
 *   closed     the sales cutoff has passed
 *   cancelled  the event was cancelled
 *   unknown    the chain could not be read: draw the map, pick nothing
 */
export type SaleState = "on-sale" | "sold-out" | "closed" | "cancelled" | "unknown";

export function saleState(chain: ChainSeats | null): SaleState {
  if (!chain) return "unknown";
  if (chain.cancelled) return "cancelled";
  if (chain.blockTs >= chain.eventEndTs) return "closed";
  return chain.remaining > 0n ? "on-sale" : "sold-out";
}

export const SEAT_FREE = 0;
/** A ticket holds it (the chain's bit). */
export const SEAT_TAKEN = 1;
/** The organiser keeps it back. */
export const SEAT_HELD = 2;
/** Someone else's 10-minute hold, or paid and not yet on the chain. */
export const SEAT_ON_HOLD = 3;
/** Its band has no price in the event: never sold (docs/SEATING.md decision 2). */
export const SEAT_NO_PRICE = 4;

export interface SeatStateInput {
  chain: ChainSeats | null;
  /** Seats the organiser keeps back (the plan's flags until the seat-state feed exists, S6). */
  held: ReadonlySet<number>;
  /** Seats the server will refuse (live holds route). Indices out of range are ignored. */
  onHold: Iterable<number>;
  /** This buyer's own hold: never shown as someone else's. */
  mine?: Iterable<number>;
  /** Price in minor units by plan band index, null for a band the event does not price. */
  bandPrices: readonly (number | null)[];
}

export interface SeatStates {
  sale: SaleState;
  /** One `SEAT_*` code per seat. With the chain unread, taken seats read FREE: `sale` is then "unknown". */
  codes: Uint8Array;
}

export function seatStates(bp: BuyerPlan, input: SeatStateInput): SeatStates {
  const n = bp.seats;
  const codes = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (input.bandPrices[bp.plan.seats[k].b] == null) codes[k] = SEAT_NO_PRICE;
  }
  for (const k of input.held) if (k >= 0 && k < n && codes[k] === SEAT_FREE) codes[k] = SEAT_HELD;
  const mine = new Set(input.mine ?? []);
  for (const k of input.onHold) {
    if (Number.isInteger(k) && k >= 0 && k < n && !mine.has(k) && codes[k] === SEAT_FREE) codes[k] = SEAT_ON_HOLD;
  }
  const words = input.chain?.words;
  if (words) {
    for (let w = 0; w < words.length; w++) {
      let word = words[w];
      if (word === 0n) continue;
      for (let bit = 0; word !== 0n; bit++, word >>= 1n) {
        if (word & 1n) {
          const k = w * 256 + bit;
          if (k < n) codes[k] = SEAT_TAKEN;
        }
      }
    }
  }
  return { sale: saleState(input.chain), codes };
}

/** Seat `k` may be picked: the series is on sale and the seat is free. */
export const pickable = (s: SeatStates, k: number): boolean => s.sale === "on-sale" && s.codes[k] === SEAT_FREE;

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

export type PickRefusal = "not-free" | "full";

/** Add or remove seat `k`. A seat already picked can always be removed. */
export function togglePick(picks: readonly number[], k: number, s: SeatStates, max: number): number[] | PickRefusal {
  const at = picks.indexOf(k);
  if (at >= 0) return picks.filter((x) => x !== k);
  if (!pickable(s, k)) return "not-free";
  if (picks.length >= max) return "full";
  return [...picks, k];
}

/** Picks that are no longer free after a refresh (bought, held, or the sale stopped), and the rest. */
export function prunePicks(picks: readonly number[], s: SeatStates): { kept: number[]; lost: number[] } {
  const kept: number[] = [], lost: number[] = [];
  for (const k of picks) (pickable(s, k) ? kept : lost).push(k);
  return { kept, lost };
}

/** The best run of `qty` free seats (optionally only those `allow` passes), or null. */
export function bestFor(bp: BuyerPlan, s: SeatStates, qty: number, allow: (k: number) => boolean = () => true): number[] | null {
  if (s.sale !== "on-sale") return null;
  return bestSeats(bp.plan.items, (k) => s.codes[k] === SEAT_FREE && allow(k), qty, { runs: bp.runs, points: bp.points, focus: bp.focus });
}

/** A free seat the picks would leave alone in a row, or null (advice only, never blocks). */
export function loneSeat(bp: BuyerPlan, s: SeatStates, picks: readonly number[]): number | null {
  return loneSeatLeft(bp.plan.items, (k) => s.codes[k] === SEAT_FREE, picks, bp.runs);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "£22" / "£22.50" / "CHF 22". */
export function formatMinor(minor: number, currency: string): string {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const whole = minor % 100 === 0;
  return `${sym}${whole ? String(minor / 100) : (minor / 100).toFixed(2)}`;
}

/** "Stalls, Row D, seat 7". */
export function seatText(bp: BuyerPlan, k: number): string {
  const l = seatLabel(bp.plan, k);
  return l ? formatSeatLabel(l) : `Seat ${k + 1}`;
}

/** The seat's printed number. */
export const seatNumber = (bp: BuyerPlan, k: number): number => bp.plan.seats[k]?.n ?? 0;

/** Band name of seat `k`. */
export const bandName = (bp: BuyerPlan, k: number): string => bp.plan.bands[bp.plan.seats[k]?.b]?.name ?? "";

/** What a screen reader says for a seat: "Stalls, Row D, seat 7, Premium, £22, wheelchair space". */
export function spokenLabel(bp: BuyerPlan, k: number, price: string | null): string {
  const s = bp.plan.seats[k];
  const area = seatLabel(bp.plan, k)?.area ?? "";
  const band = bandName(bp, k);
  // A band named after its section ("Stalls", "Stalls") is said once.
  const parts = [seatText(bp, k), band.trim().toLowerCase() === area.trim().toLowerCase() ? "" : band];
  if (price) parts.push(price);
  if (s?.a) parts.push("wheelchair space");
  if (s?.c) parts.push("companion seat");
  return parts.filter(Boolean).join(", ");
}

export interface SectionSummary {
  free: number;
  /** Lowest and highest price among the section's priced seats, minor units. */
  min: number | null;
  max: number | null;
}

export function sectionSummaries(bp: BuyerPlan, s: SeatStates, bandPrices: readonly (number | null)[]): SectionSummary[] {
  return bp.sections.map((sec) => {
    let free = 0, min: number | null = null, max: number | null = null;
    for (let k = sec.first; k < sec.first + sec.count; k++) {
      if (s.codes[k] === SEAT_FREE) free++;
      const p = bandPrices[bp.plan.seats[k].b];
      if (p == null) continue;
      if (min === null || p < min) min = p;
      if (max === null || p > max) max = p;
    }
    return { free: s.sale === "on-sale" ? free : 0, min, max };
  });
}

// ---------------------------------------------------------------------------
// Arrow keys walk a row
// ---------------------------------------------------------------------------

export type Direction = "left" | "right" | "up" | "down";

/**
 * The seat an arrow key moves to from `k`, or null. Left/right walk the row as it looks
 * on screen (a block turned past a quarter reads backwards), skipping gaps; a round
 * table wraps. Up/down go to the nearest seat in the row in front or behind.
 */
export function neighbour(bp: BuyerPlan, k: number, dir: Direction): number | null {
  const ref = bp.refs[k];
  if (!ref) return null;
  const it = bp.plan.items[ref.item] as LayoutItem;
  const flipped = Math.cos((it.rot * Math.PI) / 180) < 0;
  const rows = bp.runsOf[ref.item];
  if (dir === "left" || dir === "right") {
    const row = rows[ref.row];
    const step = (dir === "right") !== flipped ? 1 : -1;
    const ring = it.kind === "table" && it.shape === "round";
    for (let i = 1; i < row.length; i++) {
      const p = ring ? (ref.pos + step * i + row.length * i) % row.length : ref.pos + step * i;
      if (p < 0 || p >= row.length) return null;
      if (row[p] >= 0) return row[p];
    }
    return null;
  }
  if (it.kind !== "rows") return null;
  const back = (dir === "down") !== flipped;
  const target = rows[ref.row + (back ? 1 : -1)];
  if (!target) return null;
  const here = bp.points[k];
  let best: number | null = null, bestD = Infinity;
  for (const j of target) {
    if (j < 0) continue;
    const d = Math.hypot(bp.points[j].x - here.x, bp.points[j].y - here.y);
    if (d < bestD) { bestD = d; best = j; }
  }
  return best;
}
