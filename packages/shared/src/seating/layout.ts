/**
 * Seating layouts (`woco.seatlayout.v1`): what an organiser draws. A layout is
 * price bands plus things placed freely in the room - blocks of rows, tables,
 * and shapes (stage, bar, ...). It lives in the organiser's library and in an
 * event's draft; publishing freezes it into a `woco.seatplan.v1` (plan.ts),
 * which is what the ledger's `manifestRef` commits.
 *
 * Every number is an integer (positions in design pixels, rotation in whole
 * degrees, curve in percent): the formats travel as JSON and stay inside the
 * statement rule (`isJsonSafeStatementValue`: no floats, no null - absent is
 * omitted).
 *
 * A seat is `{ b }` (its band), optionally `a` (a wheelchair space), `c` (a
 * companion seat for one) and `h` (held back from sale at the start; the
 * event's seat-state feed changes that after publish). A gap is `{ g: true }`:
 * it keeps its place in the row and is never a seat.
 *
 * Validation is closed and refuses, never normalises.
 */

import { hasExactKeys, isDisplayText, isIntIn, isPlainRecord, labelIdentity } from "../validate.js";

export const SEAT_LAYOUT_FORMAT = "woco.seatlayout.v1";

/** Price bands per plan. Each gets its own fill on the map, so the count is the number of fills. */
export const MAX_SEAT_BANDS = 8;
/** A structural ceiling well above any real venue, not a product limit. */
export const MAX_PLAN_SEATS = 200_000;
export const MAX_PLAN_ITEMS = 5_000;
export const MAX_ROWS_PER_BLOCK = 500;
export const MAX_SEATS_PER_ROW = 1_000;
export const MAX_TABLE_SEATS = 100;
export const MAX_COORD = 1_000_000;
export const MAX_SHAPE_SIZE = 100_000;

export const TABLE_SHAPES = ["round", "long", "head"] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

export const SHAPE_KINDS = ["stage", "ring", "pitch", "bar", "floor", "label"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
/** What the audience faces: "best seats" measures distance to the first of these. */
export const FOCUS_KINDS: readonly ShapeKind[] = ["stage", "ring", "pitch"];

export type LayoutSeat = { b: string; a?: true; c?: true; h?: true } | { g: true };

export interface SeatBand {
  id: string;
  name: string;
  /** Which fill the map draws it with, 0..MAX_SEAT_BANDS-1, unique per plan. */
  style: number;
}

export interface RowsItem {
  id: string;
  kind: "rows";
  name: string;
  x: number;
  y: number;
  rot: number;
  /** 0 = straight, 100 = tightest; rows bow round a centre in front of the block. */
  curve: number;
  /** Which end of a row is seat `numberStart`, seen from the seats facing forward. */
  numberFrom: "left" | "right";
  /** First seat number in every row (default 1), for blocks that continue another's numbering. */
  numberStart?: number;
  /**
   * 2 = numbers go up in twos (odd seats on one side of a house, even on the other:
   * start 1 gives 1, 3, 5...; start 2 gives 2, 4, 6...). Absent = consecutive.
   */
  numberStep?: 2;
  rows: { label: string; seats: LayoutSeat[] }[];
}

export interface TableItem {
  id: string;
  kind: "table";
  shape: TableShape;
  name: string;
  x: number;
  y: number;
  rot: number;
  numberStart?: number;
  seats: LayoutSeat[];
}

export interface ShapeItem {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  text: string;
}

export type LayoutItem = RowsItem | TableItem | ShapeItem;

export interface SeatLayout {
  format: typeof SEAT_LAYOUT_FORMAT;
  name: string;
  bands: SeatBand[];
  items: LayoutItem[];
}

export const isGap = (s: LayoutSeat): s is { g: true } => "g" in s;
export const hasSeats = (it: LayoutItem): it is RowsItem | TableItem => it.kind === "rows" || it.kind === "table";

/** The seat lists of an item, in storage order: one per row, or the table's one. */
export function seatLists(it: LayoutItem): LayoutSeat[][] {
  if (it.kind === "rows") return it.rows.map((r) => r.seats);
  if (it.kind === "table") return [it.seats];
  return [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const isText = isDisplayText;

function validSeat(v: unknown, bandIds: ReadonlySet<string>): boolean {
  if (!isPlainRecord(v)) return false;
  if ("g" in v) return hasExactKeys(v, ["g"]) && v.g === true;
  if (!hasExactKeys(v, ["b"], ["a", "c", "h"])) return false;
  if (typeof v.b !== "string" || !bandIds.has(v.b)) return false;
  for (const k of ["a", "c", "h"] as const) if (k in v && v[k] !== true) return false;
  // A wheelchair space is not also a companion seat.
  if (v.a === true && v.c === true) return false;
  return true;
}

/** A row or table's seats: at least one real seat, no gap at either end. */
function validSeatList(v: unknown, max: number, bandIds: ReadonlySet<string>): v is LayoutSeat[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return false;
  if (!v.every((s) => validSeat(s, bandIds))) return false;
  const seats = v as LayoutSeat[];
  return !isGap(seats[0]) && !isGap(seats[seats.length - 1]);
}

function validPlace(o: Record<string, unknown>): boolean {
  return isIntIn(o.x, -MAX_COORD, MAX_COORD) && isIntIn(o.y, -MAX_COORD, MAX_COORD) && isIntIn(o.rot, 0, 359);
}

function validItem(v: unknown, bandIds: ReadonlySet<string>): boolean {
  if (!isPlainRecord(v)) return false;
  if (typeof v.id !== "string" || !ID_RE.test(v.id)) return false;
  if (v.kind === "rows") {
    if (!hasExactKeys(v, ["id", "kind", "name", "x", "y", "rot", "curve", "numberFrom", "rows"], ["numberStart", "numberStep"])) return false;
    if (!isText(v.name, 80) || !validPlace(v) || !isIntIn(v.curve, 0, 100)) return false;
    if (v.numberFrom !== "left" && v.numberFrom !== "right") return false;
    if ("numberStart" in v && !isIntIn(v.numberStart, 1, 100_000)) return false;
    if ("numberStep" in v && v.numberStep !== 2) return false;
    if (!Array.isArray(v.rows) || v.rows.length === 0 || v.rows.length > MAX_ROWS_PER_BLOCK) return false;
    const labels = new Set<string>();
    for (const row of v.rows) {
      if (!isPlainRecord(row) || !hasExactKeys(row, ["label", "seats"])) return false;
      if (!isText(row.label, 12) || labels.has(labelIdentity(row.label))) return false;
      labels.add(labelIdentity(row.label));
      if (!validSeatList(row.seats, MAX_SEATS_PER_ROW, bandIds)) return false;
    }
    return true;
  }
  if (v.kind === "table") {
    if (!hasExactKeys(v, ["id", "kind", "shape", "name", "x", "y", "rot", "seats"], ["numberStart"])) return false;
    if (!(TABLE_SHAPES as readonly unknown[]).includes(v.shape)) return false;
    if (!isText(v.name, 80) || !validPlace(v)) return false;
    if ("numberStart" in v && !isIntIn(v.numberStart, 1, 100_000)) return false;
    return validSeatList(v.seats, MAX_TABLE_SEATS, bandIds);
  }
  if ((SHAPE_KINDS as readonly unknown[]).includes(v.kind)) {
    if (!hasExactKeys(v, ["id", "kind", "x", "y", "w", "h", "rot", "text"])) return false;
    return validPlace(v) && isIntIn(v.w, 1, MAX_SHAPE_SIZE) && isIntIn(v.h, 1, MAX_SHAPE_SIZE) && isText(v.text, 80);
  }
  return false;
}

/** Bands: 1..MAX_SEAT_BANDS, unique ids and fills. */
export function validBands(v: unknown): v is SeatBand[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_SEAT_BANDS) return false;
  const ids = new Set<string>();
  const styles = new Set<number>();
  for (const b of v) {
    if (!isPlainRecord(b) || !hasExactKeys(b, ["id", "name", "style"])) return false;
    if (typeof b.id !== "string" || !ID_RE.test(b.id) || ids.has(b.id)) return false;
    if (!isText(b.name, 60) || !isIntIn(b.style, 0, MAX_SEAT_BANDS - 1) || styles.has(b.style)) return false;
    ids.add(b.id);
    styles.add(b.style);
  }
  return true;
}

/** Items with unique ids whose seats name only `bands`, and no more than MAX_PLAN_SEATS seats. */
export function validItems(v: unknown, bands: readonly SeatBand[]): v is LayoutItem[] {
  if (!Array.isArray(v) || v.length > MAX_PLAN_ITEMS) return false;
  const bandIds = new Set(bands.map((b) => b.id));
  const ids = new Set<string>();
  let seats = 0;
  for (const it of v) {
    if (!validItem(it, bandIds)) return false;
    const item = it as LayoutItem;
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    for (const list of seatLists(item)) for (const s of list) if (!isGap(s) && ++seats > MAX_PLAN_SEATS) return false;
  }
  return true;
}

/** Closed-schema check of a layout. A layout may be empty of seats (a draft). */
export function validateSeatLayout(value: unknown): value is SeatLayout {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["format", "name", "bands", "items"])) return false;
  if (value.format !== SEAT_LAYOUT_FORMAT || !isText(value.name, 80)) return false;
  return validBands(value.bands) && validItems(value.items, value.bands);
}
