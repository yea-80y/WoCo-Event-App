/**
 * Event seating plans (`woco.seatplan.v1`): a layout frozen at publish, plus its
 * explicit seat list. Seat INDEX `k` of the list is seat `k` on the ledger
 * (`registerSeatedEvent` seats `0 .. supply - 1`), so the walk that numbers them is
 * FROZEN: changing it renumbers every seated event ever published.
 * `packages/shared/test/seating/plan.test.ts` pins it with golden vectors.
 *
 * The walk: items in array order; a block's rows in order, each row's seats in
 * stored order; a table's seats in order; gaps skipped, shapes contribute none.
 *
 * Labels are physical facts and are committed: the manifest names the plan blob
 * by Swarm ref and by `keccak256` of its exact bytes (template.ts). Prices are not
 * here - a seat names its band, and band prices live in the event feed.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  SEAT_LAYOUT_FORMAT,
  type LayoutItem,
  type LayoutSeat,
  type SeatBand,
  type SeatLayout,
  isGap,
  seatLists,
  validateSeatLayout,
} from "./layout.js";
import { hasExactKeys, isIntIn, isPlainRecord, labelIdentity } from "../validate.js";
import { ticketSeatText, type TicketSeat } from "./ticket-seat.js";

export const SEAT_PLAN_FORMAT = "woco.seatplan.v1";

/** One seat in the committed list. `i` indexes `items`, `b` indexes `bands`. */
export interface PlanSeat {
  i: number;
  /** Row label, blocks of rows only. */
  r?: string;
  /** Seat number as printed. */
  n: number;
  b: number;
  /** A wheelchair space. */
  a?: true;
  /** A companion seat for a wheelchair space. */
  c?: true;
}

export interface SeatPlan {
  format: typeof SEAT_PLAN_FORMAT;
  name: string;
  bands: SeatBand[];
  items: LayoutItem[];
  seats: PlanSeat[];
  /** The library layout this plan was copied from (read-only trace). */
  source?: string;
}

/** Where seat `k` sits in its item: list `row` (0 for a table), position `pos` counting gaps. */
export interface SeatRef {
  item: number;
  row: number;
  pos: number;
}

/** The frozen walk: every seat's place, in seat-index order. */
export function seatRefs(items: readonly LayoutItem[]): SeatRef[] {
  const out: SeatRef[] = [];
  items.forEach((it, item) => {
    seatLists(it).forEach((list, row) => {
      list.forEach((s, pos) => {
        if (!isGap(s)) out.push({ item, row, pos });
      });
    });
  });
  return out;
}

/** The printed number of each real seat of one row or table, by position (null for a gap). */
function rowNumbers(it: LayoutItem, list: readonly LayoutSeat[]): (number | null)[] {
  const start = it.kind === "rows" || it.kind === "table" ? (it.numberStart ?? 1) : 1;
  const step = it.kind === "rows" ? (it.numberStep ?? 1) : 1;
  const real = list.filter((s) => !isGap(s)).length;
  const fromRight = it.kind === "rows" && it.numberFrom === "right";
  let k = 0;
  return list.map((s) => {
    if (isGap(s)) return null;
    const n = start + step * (fromRight ? real - 1 - k : k);
    k++;
    return n;
  });
}

/** The committed seat list a layout's items and bands produce. */
export function canonicalSeats(layout: { bands: readonly SeatBand[]; items: readonly LayoutItem[] }): PlanSeat[] {
  const bandIndex = new Map(layout.bands.map((b, i) => [b.id, i]));
  const out: PlanSeat[] = [];
  layout.items.forEach((it, i) => {
    seatLists(it).forEach((list, r) => {
      const numbers = rowNumbers(it, list);
      list.forEach((s, pos) => {
        if (isGap(s)) return;
        const b = bandIndex.get(s.b);
        if (b === undefined) throw new Error("seat names a band the plan does not have");
        out.push({
          i,
          ...(it.kind === "rows" ? { r: it.rows[r].label } : {}),
          n: numbers[pos] as number,
          b,
          ...(s.a ? { a: true as const } : {}),
          ...(s.c ? { c: true as const } : {}),
        });
      });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface SeatLabel {
  /** The block or table name: "Stalls", "Table 3". */
  area: string;
  /** Row label, blocks of rows only. */
  row?: string;
  seat: number;
  atTable: boolean;
}

export function seatLabel(plan: Pick<SeatPlan, "items" | "seats">, index: number): SeatLabel | null {
  const s = plan.seats[index];
  if (!s) return null;
  const it = plan.items[s.i];
  if (!it || (it.kind !== "rows" && it.kind !== "table")) return null;
  return { area: it.name, ...(s.r !== undefined ? { row: s.r } : {}), seat: s.n, atTable: it.kind === "table" };
}

/** "Stalls, Row D, seat 7" / "Table 3, seat 5". */
export function formatSeatLabel(l: SeatLabel): string {
  return ticketSeatText(l);
}

/** Seat `index` as printed on its ticket, wheelchair and companion flags included. */
export function ticketSeatOf(plan: Pick<SeatPlan, "items" | "seats">, index: number): TicketSeat | null {
  const l = seatLabel(plan, index);
  if (!l) return null;
  const s = plan.seats[index];
  return {
    area: l.area,
    ...(l.row !== undefined ? { row: l.row } : {}),
    seat: l.seat,
    ...(l.atTable ? { table: true as const } : {}),
    ...(s.a ? { wheelchair: true as const } : {}),
    ...(s.c ? { companion: true as const } : {}),
  };
}

/** Two seats print the same label when these keys match (case and spacing do not tell them apart). */
const labelKey = (area: string, s: PlanSeat) => `${labelIdentity(area)}\u0000${labelIdentity(s.r ?? "")}\u0000${s.n}`;

// ---------------------------------------------------------------------------
// Freezing a layout
// ---------------------------------------------------------------------------

export type SeatPlanProblem =
  | { kind: "invalid" }
  | { kind: "no-seats" }
  /** Two seats would print the same label. `seats` are the clashing indices in the would-be plan. */
  | { kind: "duplicate-label"; label: string; seats: number[] };

/** Everything that stops a layout from being published. Empty = it can be frozen. */
export function seatPlanProblems(layout: unknown): SeatPlanProblem[] {
  return inspectLayout(layout).problems;
}

/** The problems, and the derived seat list when the layout is valid (one walk for both). */
function inspectLayout(layout: unknown): { problems: SeatPlanProblem[]; seats: PlanSeat[] } {
  if (!validateSeatLayout(layout)) return { problems: [{ kind: "invalid" }], seats: [] };
  const seats = canonicalSeats(layout);
  return { problems: labelProblems(layout, seats), seats };
}

function labelProblems(layout: SeatLayout, seats: PlanSeat[]): SeatPlanProblem[] {
  if (seats.length === 0) return [{ kind: "no-seats" }];
  const byLabel = new Map<string, number[]>();
  seats.forEach((s, k) => {
    const key = labelKey((layout.items[s.i] as { name: string }).name, s);
    const at = byLabel.get(key);
    if (at) at.push(k);
    else byLabel.set(key, [k]);
  });
  const problems: SeatPlanProblem[] = [];
  for (const [, at] of byLabel) {
    if (at.length < 2) continue;
    const l = seatLabel({ items: layout.items, seats }, at[0]) as SeatLabel;
    problems.push({ kind: "duplicate-label", label: formatSeatLabel(l), seats: at });
  }
  return problems;
}

/**
 * Freeze a layout for publishing: bands no seat uses are dropped (keeping order),
 * the seat list is derived. Throws on any `seatPlanProblems`.
 */
export function freezeSeatPlan(layout: SeatLayout, source?: string): SeatPlan {
  if (seatPlanProblems(layout).length > 0) throw new Error("layout cannot be published as it is");
  if (source !== undefined && !SOURCE_RE.test(source)) throw new Error("invalid source id");
  const used = new Set<string>();
  for (const it of layout.items) for (const list of seatLists(it)) for (const s of list) if (!isGap(s)) used.add(s.b);
  const bands = layout.bands.filter((b) => used.has(b.id));
  // canonicalSeatPlan rebuilds every item and seat, so the result shares nothing with `layout`.
  return canonicalSeatPlan({
    format: SEAT_PLAN_FORMAT,
    name: layout.name,
    bands,
    items: layout.items,
    seats: canonicalSeats({ bands, items: layout.items }),
    ...(source !== undefined ? { source } : {}),
  });
}

/** The layout a plan was frozen from (for "Edit a copy" in the builder). */
export function layoutOfPlan(plan: SeatPlan): SeatLayout {
  return { format: SEAT_LAYOUT_FORMAT, name: plan.name, bands: structuredClone(plan.bands), items: structuredClone(plan.items) };
}

const SOURCE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Closed-schema check of a frozen plan, INCLUDING that `seats` is exactly what
 * the walk derives from `items`, that every band is used and every label unique.
 */
export function validateSeatPlan(value: unknown): value is SeatPlan {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["format", "name", "bands", "items", "seats"], ["source"])) return false;
  if (value.format !== SEAT_PLAN_FORMAT) return false;
  if ("source" in value && (typeof value.source !== "string" || !SOURCE_RE.test(value.source))) return false;
  const asLayout = { format: SEAT_LAYOUT_FORMAT, name: value.name, bands: value.bands, items: value.items };
  // Validates the layout part too.
  const { problems, seats: derived } = inspectLayout(asLayout);
  if (problems.length > 0) return false;
  const layout = asLayout as SeatLayout;
  if (!Array.isArray(value.seats) || value.seats.length !== derived.length) return false;
  for (let k = 0; k < derived.length; k++) {
    if (!samePlanSeat(value.seats[k], derived[k])) return false;
  }
  const used = new Set(derived.map((s) => s.b));
  return used.size === layout.bands.length;
}

function samePlanSeat(v: unknown, d: PlanSeat): boolean {
  if (!isPlainRecord(v) || !hasExactKeys(v, ["i", "n", "b"], ["r", "a", "c"])) return false;
  if (("a" in v && v.a !== true) || ("c" in v && v.c !== true)) return false;
  return v.i === d.i && v.n === d.n && v.b === d.b && v.r === d.r && (v.a === true) === (d.a === true) && (v.c === true) === (d.c === true);
}

/** Seats held back from sale when the plan was published (before any seat-state update). */
export function initialHeldSeats(plan: Pick<SeatPlan, "items">): Set<number> {
  const held = new Set<number>();
  seatRefs(plan.items).forEach((ref, k) => {
    const s = seatLists(plan.items[ref.item])[ref.row][ref.pos];
    if (!isGap(s) && s.h) held.add(k);
  });
  return held;
}

// ---------------------------------------------------------------------------
// Bytes and digest
// ---------------------------------------------------------------------------

function canonicalSeat(s: LayoutSeat): LayoutSeat {
  if (isGap(s)) return { g: true };
  return { b: s.b, ...(s.a ? { a: true } : {}), ...(s.c ? { c: true } : {}), ...(s.h ? { h: true } : {}) };
}

function canonicalItem(it: LayoutItem): LayoutItem {
  if (it.kind === "rows") {
    return {
      id: it.id, kind: "rows", name: it.name, x: it.x, y: it.y, rot: it.rot, curve: it.curve, numberFrom: it.numberFrom,
      ...(it.numberStart !== undefined ? { numberStart: it.numberStart } : {}),
      ...(it.numberStep !== undefined ? { numberStep: it.numberStep } : {}),
      rows: it.rows.map((r) => ({ label: r.label, seats: r.seats.map(canonicalSeat) })),
    };
  }
  if (it.kind === "table") {
    return {
      id: it.id, kind: "table", shape: it.shape, name: it.name, x: it.x, y: it.y, rot: it.rot,
      ...(it.numberStart !== undefined ? { numberStart: it.numberStart } : {}),
      seats: it.seats.map(canonicalSeat),
    };
  }
  return { id: it.id, kind: it.kind, x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot, text: it.text };
}

/** Rebuild in fixed key order, so the same plan always encodes to the same bytes. */
export function canonicalSeatPlan(plan: SeatPlan): SeatPlan {
  return {
    format: plan.format,
    name: plan.name,
    bands: plan.bands.map((b) => ({ id: b.id, name: b.name, style: b.style })),
    items: plan.items.map(canonicalItem),
    seats: plan.seats.map((s) => ({
      i: s.i, ...(s.r !== undefined ? { r: s.r } : {}), n: s.n, b: s.b,
      ...(s.a ? { a: true as const } : {}), ...(s.c ? { c: true as const } : {}),
    })),
    ...(plan.source !== undefined ? { source: plan.source } : {}),
  };
}

/** The bytes uploaded to Swarm. The manifest commits their keccak256 (`seatPlanDigest`). */
export function encodeSeatPlan(plan: SeatPlan): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalSeatPlan(plan)));
}

/** `0x` + keccak256 of the exact bytes, lowercase. */
export function seatPlanDigest(bytes: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(bytes))}`;
}

/**
 * Largest plan blob a reader will hash or parse. A plan at MAX_PLAN_SEATS encodes to
 * roughly 45 bytes a seat (~9 MB); anything past this is refused before any work.
 */
export const MAX_SEAT_PLAN_BYTES = 12 * 1024 * 1024;

/**
 * Bytes fetched from anywhere -> a plan, only if they hash to `digest` and the
 * plan is valid. Null otherwise: a reader treats that as "no plan", and the money
 * path refuses.
 */
export function parseSeatPlan(bytes: Uint8Array, digest: string): SeatPlan | null {
  if (bytes.length > MAX_SEAT_PLAN_BYTES) return null;
  if (seatPlanDigest(bytes) !== digest.toLowerCase()) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  return validateSeatPlan(value) ? value : null;
}

/** Seat `k` exists on the plan. */
export const isSeatIndex = (plan: Pick<SeatPlan, "seats">, k: unknown): k is number =>
  isIntIn(k, 0, plan.seats.length - 1);
