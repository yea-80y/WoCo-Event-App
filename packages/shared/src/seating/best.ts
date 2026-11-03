/**
 * "Find me the best N seats": a run of free seats side by side, nearest what the
 * audience faces, avoiding runs that strand one empty seat at either end. At a round
 * table the run may wrap. Runs never cross a gap (an aisle or a pillar). Runs in the
 * buyer's browser; the server only checks the seats it is asked to hold.
 */

import type { LayoutItem } from "./layout.js";
import { isGap, seatLists } from "./layout.js";
import { planFocus, seatWorldPoints } from "./geometry.js";

/** One row or table, as seat indices by position; -1 marks a gap. */
export interface SeatRun {
  item: number;
  row: number;
  /** A round table: the first and last seats are neighbours. */
  ring: boolean;
  /** Blocks of rows only: where a stranded single seat is worth warning about. */
  isRow: boolean;
  seats: number[];
}

export function seatRuns(items: readonly LayoutItem[]): SeatRun[] {
  const out: SeatRun[] = [];
  let k = 0;
  items.forEach((it, item) => {
    seatLists(it).forEach((list, row) => {
      out.push({
        item,
        row,
        ring: it.kind === "table" && it.shape === "round",
        isRow: it.kind === "rows",
        seats: list.map((s) => (isGap(s) ? -1 : k++)),
      });
    });
  });
  return out;
}

/** Score added to a run that leaves one free seat alone at a row end, in design pixels (~3.5 seats). */
export const LONE_SEAT_PENALTY = 80;

export interface BestSeatsOptions {
  runs?: SeatRun[];
  points?: { x: number; y: number }[];
  focus?: { x: number; y: number };
}

/** Seat indices of the best run of `qty` free seats, or null when no run fits. */
export function bestSeats(items: readonly LayoutItem[], free: (k: number) => boolean, qty: number, opts: BestSeatsOptions = {}): number[] | null {
  if (!Number.isInteger(qty) || qty < 1) return null;
  const runs = opts.runs ?? seatRuns(items);
  const points = opts.points ?? seatWorldPoints(items);
  const focus = opts.focus ?? planFocus(items);
  let best: { score: number; seats: number[] } | null = null;
  for (const run of runs) {
    const n = run.seats.length;
    const ok = run.seats.map((k) => k >= 0 && free(k));
    if (ok.filter(Boolean).length < qty) continue;
    for (let start = 0; start < n; start++) {
      if (!run.ring && start + qty > n) break;
      let fits = true;
      for (let j = 0; j < qty; j++) if (!ok[(start + j) % n]) { fits = false; break; }
      if (!fits) continue;
      const seats = Array.from({ length: qty }, (_, j) => run.seats[(start + j) % n]);
      let cx = 0, cy = 0;
      for (const k of seats) { cx += points[k].x; cy += points[k].y; }
      let score = Math.hypot(cx / qty - focus.x, cy / qty - focus.y);
      if (!run.ring) {
        const L = start - 1, R = start + qty;
        // A free seat just outside the run whose other neighbour is not free (or is the row end).
        const lone = (i: number, beyond: number) => i >= 0 && i < n && ok[i] && !(beyond >= 0 && beyond < n && ok[beyond]);
        if (lone(L, L - 1) || lone(R, R + 1)) score += LONE_SEAT_PENALTY;
      }
      if (!best || score < best.score) best = { score, seats };
    }
  }
  return best ? best.seats : null;
}

/**
 * A free seat the buyer's picks would leave on its own in a row (between a pick
 * and the row end, a gap, or a seat that is not free), or null. Advice only.
 */
export function loneSeatLeft(items: readonly LayoutItem[], free: (k: number) => boolean, picked: readonly number[], runs: SeatRun[] = seatRuns(items)): number | null {
  const mine = new Set(picked);
  for (const run of runs) {
    if (!run.isRow || !run.seats.some((k) => mine.has(k))) continue;
    const n = run.seats.length;
    const open = run.seats.map((k) => k >= 0 && free(k) && !mine.has(k));
    for (let j = 0; j < n; j++) {
      if (!open[j]) continue;
      const leftShut = j === 0 || !open[j - 1];
      const rightShut = j === n - 1 || !open[j + 1];
      const nextToPick = (j > 0 && mine.has(run.seats[j - 1])) || (j < n - 1 && mine.has(run.seats[j + 1]));
      if (leftShut && rightShut && nextToPick) return run.seats[j];
    }
  }
  return null;
}
