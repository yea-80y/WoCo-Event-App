/**
 * The seat picker's words and small rules, kept out of the component (svelte/SeatPicker)
 * so they are testable (test/picker-model.test.ts). docs/SEATING.md "Buyer experience".
 */

import { formatMinor, seatText, type BuyerPlan } from "./buyer.js";
import type { SeatMapProblem } from "./load.js";
import { SEAT_FREE, type SaleState, type SeatStates } from "@woco/shared/seating/availability";

/** A sentence for why the map cannot sell right now, or null when it can. */
export function mapNotice(o: { problem?: SeatMapProblem | null; sale?: SaleState | null; serverOk?: boolean }): { text: string; retry: boolean } | null {
  switch (o.problem) {
    case "publishing": return { text: "The seating plan is still being published. Try again in a minute.", retry: true };
    case "unavailable": return { text: "We couldn't load the seating plan. Check your connection and try again.", retry: true };
    case "mismatch": return { text: "This seating plan couldn't be checked, so seats can't be chosen here. Please contact the organiser.", retry: false };
    case "not-seated": return { text: "Seat choice isn't available for these tickets.", retry: false };
  }
  switch (o.sale) {
    case "sold-out": return { text: "Sold out.", retry: false };
    case "closed": return { text: "Ticket sales have closed.", retry: false };
    case "cancelled": return { text: "This event has been cancelled.", retry: false };
    case "unknown": return { text: "We can't check which seats are free right now. The plan is shown; seats can be chosen once we can.", retry: true };
  }
  if (o.serverOk === false) return { text: "Seat holds aren't working right now. You can look at the plan; try again in a moment to book.", retry: true };
  return null;
}

/** "Stalls, Row D, seats 7-8" for one run in one row; else each seat, shortest first. */
export function seatsText(bp: BuyerPlan, seats: readonly number[]): string {
  if (seats.length === 0) return "";
  if (seats.length === 1) return seatText(bp, seats[0]);
  const s0 = bp.plan.seats[seats[0]];
  const sameRow = seats.every((k) => bp.plan.seats[k].i === s0.i && bp.plan.seats[k].r === s0.r);
  if (sameRow) {
    const nums = seats.map((k) => bp.plan.seats[k].n).sort((a, b) => a - b);
    const where = seatText(bp, seats[0]).replace(/, seat \d+$/, "");
    return `${where}, seats ${nums[0]}-${nums[nums.length - 1]}`;
  }
  return seats.map((k) => seatText(bp, k)).join("; ");
}

/** Price of seat `k` in minor units, or null when its band has none. */
export const seatPriceMinor = (bp: BuyerPlan, bandPrices: readonly (number | null)[], k: number): number | null =>
  bandPrices[bp.plan.seats[k]?.b] ?? null;

export function picksTotal(bp: BuyerPlan, bandPrices: readonly (number | null)[], picks: readonly number[]): number {
  return picks.reduce((sum, k) => sum + (seatPriceMinor(bp, bandPrices, k) ?? 0), 0);
}

/** "2 seats · £44". */
export function totalLine(bp: BuyerPlan, bandPrices: readonly (number | null)[], picks: readonly number[], currency: string): string {
  const n = picks.length;
  return `${n} ${n === 1 ? "seat" : "seats"} · ${formatMinor(picksTotal(bp, bandPrices, picks), currency)}`;
}

/** "£22-28" / "£22" for a set of minor prices. */
export function priceRange(min: number | null, max: number | null, currency: string): string {
  if (min === null || max === null) return "";
  if (min === max) return formatMinor(min, currency);
  return `${formatMinor(min, currency)}-${formatMinor(max, currency).replace(/^[^0-9]*/, "")}`;
}

/**
 * The free companion seat beside wheelchair space `k` in the same row or table, or
 * null. Advice only: the buyer chooses whether to add it.
 */
export function companionBeside(bp: BuyerPlan, s: SeatStates, k: number, picks: readonly number[]): number | null {
  const ref = bp.refs[k];
  if (!ref || !bp.plan.seats[k]?.a) return null;
  const row = bp.runsOf[ref.item][ref.row];
  for (const d of [-1, 1]) {
    const j = row[ref.pos + d];
    if (j !== undefined && j >= 0 && bp.plan.seats[j].c && s.codes[j] === SEAT_FREE && !picks.includes(j)) return j;
  }
  return null;
}

/** Where a buyer's picks survive a reload: per series, per plan (another plan's indices mean other seats). */
export const picksStorageKey = (eventId: string, seriesId: string, planDigest: string) =>
  `woco:seat-picks:${eventId}:${seriesId}:${planDigest}`;

export function readPicks(store: Pick<Storage, "getItem"> | null, key: string, seats: number, max: number): number[] {
  try {
    const v = JSON.parse(store?.getItem(key) ?? "[]");
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((k): k is number => Number.isInteger(k) && k >= 0 && k < seats))].slice(0, max);
  } catch {
    return [];
  }
}

export function writePicks(store: Pick<Storage, "setItem" | "removeItem"> | null, key: string, picks: readonly number[]): void {
  try {
    if (picks.length) store?.setItem(key, JSON.stringify(picks));
    else store?.removeItem(key);
  } catch { /* storage full or blocked: picks just don't survive a reload */ }
}
