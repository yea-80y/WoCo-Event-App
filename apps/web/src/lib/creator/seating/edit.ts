/**
 * The seating builder's edits, as pure functions on a `woco.seatlayout.v1` layout
 * (packages/shared/src/seating). Everything the builder writes stays inside what
 * `validateSeatLayout` accepts: whole numbers, rotations 0..359, no gap at either end
 * of a row (tidyLayout trims what painting leaves behind).
 */

import {
  MAX_ROWS_PER_BLOCK,
  MAX_SEATS_PER_ROW,
  MAX_SEAT_BANDS,
  MAX_TABLE_SEATS,
  FOCUS_KINDS,
  hasSeats,
  isGap,
  seatLists,
  type LayoutItem,
  type LayoutSeat,
  type RowsItem,
  type SeatLayout,
  type ShapeKind,
  type TableItem,
} from "@woco/shared/seating/layout";
import { itemGeometry, itemWorldBox, toWorld, unionBox, SEAT_PITCH, type Box } from "@woco/shared/seating/geometry";
import { labelsAfter, normRot, rowsBlock, shape, table } from "@woco/shared/seating/templates";

export const TABLE_MAX: Record<TableItem["shape"], number> = { round: 16, long: 30, head: 20 };

export type AddKind = "rows" | "round" | "long" | "head" | ShapeKind;

/** What a paint stroke does to a seat. */
export type Brush = { band: string } | "held" | "wheel" | "companion" | "gap";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
export const realCount = (list: readonly LayoutSeat[]) => list.filter((s) => !isGap(s)).length;
export const longestRow = (it: RowsItem) => Math.max(0, ...it.rows.map((r) => realCount(r.seats)));

/** A fresh id not used by any item or band. */
export function freshId(layout: SeatLayout, prefix: "i" | "b"): string {
  let max = 0;
  for (const x of [...layout.items, ...layout.bands]) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export function describe(it: LayoutItem): string {
  if (it.kind === "rows") return `${it.name}, ${it.rows.length} rows, ${it.rows.reduce((n, r) => n + realCount(r.seats), 0)} seats`;
  if (it.kind === "table") return `${it.name}, ${realCount(it.seats)} seats`;
  return it.text;
}

export interface Counts {
  /** Seats that will be on sale (not held). */
  forSale: number;
  held: number;
  wheel: number;
  companion: number;
  tables: number;
  /** On-sale seats by band id. */
  byBand: Record<string, number>;
}

export function counts(layout: Pick<SeatLayout, "items">): Counts {
  const c: Counts = { forSale: 0, held: 0, wheel: 0, companion: 0, tables: 0, byBand: {} };
  for (const it of layout.items) {
    if (it.kind === "table") c.tables++;
    for (const list of seatLists(it)) {
      for (const s of list) {
        if (isGap(s)) continue;
        if (s.a) c.wheel++;
        if (s.c) c.companion++;
        if (s.h) { c.held++; continue; }
        c.forSale++;
        c.byBand[s.b] = (c.byBand[s.b] ?? 0) + 1;
      }
    }
  }
  return c;
}

export function uniqueName(layout: SeatLayout, base: string): string {
  const names = new Set(layout.items.map((it) => ("name" in it ? it.name : "")));
  if (!names.has(base)) return base;
  const stem = base.replace(/\s+\d+$/, "");
  for (let k = 2; ; k++) if (!names.has(`${stem} ${k}`)) return `${stem} ${k}`;
}

export function nextTableName(layout: SeatLayout): string {
  let max = 0;
  for (const it of layout.items) {
    const m = it.kind === "table" && /^Table\s+(\d+)$/i.exec(it.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Table ${max + 1}`;
}

/** A new thing to add, centred on (x, y) by the caller. */
export function makeItem(layout: SeatLayout, kind: AddKind, x: number, y: number): LayoutItem {
  const b = layout.bands[0].id;
  const id = freshId(layout, "i");
  switch (kind) {
    case "rows": return rowsBlock(id, uniqueName(layout, "Section 1"), x, y, 5, 12, b, "A", { aisle: false });
    case "round": return table(id, nextTableName(layout), x, y, 8, "round", b);
    case "long": return table(id, nextTableName(layout), x, y, 6, "long", b);
    case "head": return table(id, uniqueName(layout, "Top table"), x, y, 8, "head", b);
    case "stage": return shape(id, "stage", x, y, 300, 44, "Stage");
    case "ring": return shape(id, "ring", x, y, 180, 180, "Ring");
    case "pitch": return shape(id, "pitch", x, y, 420, 260, "Pitch");
    case "bar": return shape(id, "bar", x, y, 200, 40, "Bar");
    case "floor": return shape(id, "floor", x, y, 220, 160, "Dance floor");
    default: return shape(id, "label", x, y, 0, 26, "Entrance");
  }
}

const bandOfList = (list: readonly LayoutSeat[], fallback: string) => {
  for (const s of list) if (!isGap(s)) return s.b;
  return fallback;
};

/** Grow or shrink every row by `delta`, alternating ends so an aisle stays in the middle. */
export function resizeRows(it: RowsItem, fromRows: RowsItem["rows"], delta: number, fallbackBand: string): void {
  it.rows = fromRows.map((row) => {
    const seats = row.seats.map((s) => ({ ...s }));
    const b = bandOfList(seats, fallbackBand);
    if (delta > 0) {
      for (let k = 0; k < delta && seats.length < MAX_SEATS_PER_ROW; k++) k % 2 === 0 ? seats.push({ b }) : seats.unshift({ b });
    } else {
      for (let k = 0; k < -delta; k++) {
        if (realCount(seats) <= 1) break;
        k % 2 === 0 ? seats.pop() : seats.shift();
      }
    }
    trimEnds(seats);
    return { label: row.label, seats };
  });
}

export function setRowCount(it: RowsItem, fromRows: RowsItem["rows"], n: number): void {
  n = clamp(Math.round(n), 1, MAX_ROWS_PER_BLOCK);
  const rows = fromRows.slice(0, n).map((r) => ({ label: r.label, seats: r.seats.map((s) => ({ ...s })) }));
  const last = fromRows[fromRows.length - 1];
  const more = n - rows.length;
  if (more > 0) {
    const used = new Set(rows.map((r) => r.label));
    const labels = labelsAfter(last.label, more + used.size).filter((l) => !used.has(l));
    for (let k = 0; k < more; k++) {
      let label = labels[k] ?? String(rows.length + 1);
      while (used.has(label)) label = `${label}'`;
      used.add(label);
      // A new row copies the last one's shape: its gaps and bands, nothing held.
      rows.push({ label, seats: last.seats.map((s) => (isGap(s) ? { g: true as const } : { b: s.b })) });
    }
  }
  it.rows = rows;
}

export function setTableSeats(it: TableItem, n: number, fallbackBand: string): void {
  n = clamp(Math.round(n), 2, Math.min(TABLE_MAX[it.shape], MAX_TABLE_SEATS));
  const b = bandOfList(it.seats, fallbackBand);
  const seats = it.seats.map((s) => ({ ...s }));
  while (seats.length < n) seats.push({ b });
  seats.length = n;
  trimEnds(seats);
  it.seats = seats;
}

/** Copy of `it` moved by `off`, with a fresh id and a name that does not clash. */
export function cloneItem(layout: SeatLayout, it: LayoutItem, off: { x: number; y: number }): LayoutItem {
  const c = structuredClone(it) as LayoutItem;
  c.id = freshId(layout, "i");
  c.x = Math.round(it.x + off.x);
  c.y = Math.round(it.y + off.y);
  if (c.kind === "table") c.name = /^Table\s+\d+$/i.test(it.kind === "table" ? it.name : "") ? nextTableName(layout) : uniqueName(layout, c.name);
  if (c.kind === "rows") c.name = uniqueName(layout, c.name);
  return c;
}

/** Move items so nothing sits left of or above the room's edge. */
export function keepInRoom(items: LayoutItem[]): void {
  if (!items.length) return;
  const gb = unionBox(items);
  const dx = Math.max(0, Math.ceil(10 - gb.x0)), dy = Math.max(0, Math.ceil(10 - gb.y0));
  for (const it of items) { it.x += dx; it.y += dy; }
}

export function rotateItems(items: LayoutItem[], deg: number): void {
  for (const it of items) it.rot = normRot(it.rot + deg);
}

const centres = (items: LayoutItem[]) => items.map((it) => { const b = itemWorldBox(it); return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; });
function alongX(cs: { x: number; y: number }[]): boolean {
  const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
  return Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
}

/** Line items up across the way they run. */
export function lineUp(items: LayoutItem[]): void {
  if (items.length < 2) return;
  const cs = centres(items), horiz = alongX(cs);
  const t = cs.reduce((s, c) => s + (horiz ? c.y : c.x), 0) / cs.length;
  items.forEach((it, k) => { if (horiz) it.y = Math.round(it.y + t - cs[k].y); else it.x = Math.round(it.x + t - cs[k].x); });
}

/** Space items evenly along the way they run. */
export function spread(items: LayoutItem[]): void {
  if (items.length < 3) return;
  const cs = centres(items), horiz = alongX(cs), ax = horiz ? "x" : "y";
  const order = items.map((it, k) => ({ it, c: cs[k][ax] })).sort((a, b) => a.c - b.c);
  const first = order[0].c, step = (order[order.length - 1].c - first) / (order.length - 1);
  order.forEach((o, k) => { o.it[ax] = Math.round(o.it[ax] + first + step * k - o.c); });
}

/** Paint one seat (list `list`, position `pos`). */
export function applyBrush(list: LayoutSeat[], pos: number, brush: Brush, fallbackBand: string): void {
  const seat = list[pos];
  if (!seat) return;
  const b = isGap(seat) ? bandOfList(list, fallbackBand) : seat.b;
  if (brush === "gap") list[pos] = { g: true };
  else if (brush === "held") list[pos] = { ...(isGap(seat) ? { b } : seat), h: true };
  else if (brush === "wheel") list[pos] = { b, a: true, ...(!isGap(seat) && seat.h ? { h: true as const } : {}) };
  else if (brush === "companion") list[pos] = { b, c: true, ...(!isGap(seat) && seat.h ? { h: true as const } : {}) };
  // A price puts a held seat back on sale and keeps what the seat is.
  else list[pos] = { b: brush.band, ...(!isGap(seat) && seat.a ? { a: true as const } : {}), ...(!isGap(seat) && seat.c ? { c: true as const } : {}) };
}

/** Drop gaps at either end of a seat list (they are never a seat and the format refuses them). */
function trimEnds(seats: LayoutSeat[]): void {
  while (seats.length > 1 && isGap(seats[0])) seats.shift();
  while (seats.length > 1 && isGap(seats[seats.length - 1])) seats.pop();
}

/**
 * The layout as the format accepts it after painting: gaps trimmed from row and table
 * ends, rows with no seat left removed, blocks and tables with none left removed.
 * Returns how many things were removed (the builder says so).
 */
export function tidyLayout(layout: SeatLayout): number {
  let removed = 0;
  layout.items = layout.items.filter((it) => {
    if (it.kind === "rows") {
      it.rows = it.rows.filter((r) => {
        trimEnds(r.seats);
        const keep = realCount(r.seats) > 0;
        if (!keep) removed++;
        return keep;
      });
      if (it.rows.length === 0) { removed++; return false; }
    }
    if (it.kind === "table") {
      trimEnds(it.seats);
      if (realCount(it.seats) === 0) { removed++; return false; }
    }
    return true;
  });
  return removed;
}

export function addBand(layout: SeatLayout): string | null {
  if (layout.bands.length >= MAX_SEAT_BANDS) return null;
  const used = new Set(layout.bands.map((b) => b.style));
  let style = 0;
  while (used.has(style)) style++;
  const id = freshId(layout, "b");
  layout.bands.push({ id, name: `Price ${layout.bands.length + 1}`, style });
  return id;
}

/** Every seat inside a room-space rectangle, as [item, row, pos]. */
export function seatsInRect(items: readonly LayoutItem[], r: Box): [number, number, number][] {
  const out: [number, number, number][] = [];
  items.forEach((it, i) => {
    for (const s of itemGeometry(it).seats) {
      const p = toWorld(it, s.x, s.y);
      if (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) out.push([i, s.row, s.pos]);
    }
  });
  return out;
}

export const intersects = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function seatsClash(a: LayoutItem, b: LayoutItem): boolean {
  if (!intersects(itemWorldBox(a), itemWorldBox(b))) return false;
  const pa = itemGeometry(a).seats.filter((s) => !isGap(s.seat)).map((s) => toWorld(a, s.x, s.y));
  const pb = itemGeometry(b).seats.filter((s) => !isGap(s.seat)).map((s) => toWorld(b, s.x, s.y));
  return pa.some((p) => pb.some((q) => Math.abs(p.x - q.x) < SEAT_PITCH * 0.7 && Math.abs(p.y - q.y) < SEAT_PITCH * 0.7));
}

export interface PlanNote {
  /** Worth fixing before publishing (amber), or just good to know. */
  warn: boolean;
  text: string;
}

/** "Worth a second look" before using a plan. Things that STOP publishing come from seatPlanProblems. */
export function planNotes(layout: SeatLayout): PlanNote[] {
  const c = counts(layout);
  const seated = layout.items.filter(hasSeats) as (RowsItem | TableItem)[];
  const notes: PlanNote[] = [];
  for (let a = 0; a < seated.length; a++) {
    for (let b = a + 1; b < seated.length; b++) {
      if (seatsClash(seated[a], seated[b])) notes.push({ warn: true, text: `${seated[a].name} and ${seated[b].name} have seats on top of each other. Move one of them apart.` });
    }
  }
  for (const it of seated) {
    if (it.kind !== "rows") continue;
    it.rows.forEach((row, r) => {
      const n = realCount(row.seats);
      const nb = [it.rows[r - 1], it.rows[r + 1]].filter(Boolean).map((x) => realCount(x.seats));
      if (nb.length && nb.every((m) => m - n >= 3)) notes.push({ warn: true, text: `${it.name}, row ${row.label} has ${n} seats, at least 3 fewer than the rows beside it. Is that right?` });
    });
  }
  if (!c.wheel) notes.push({ warn: true, text: "There are no wheelchair spaces. Add some if the room has step-free spaces." });
  if (c.wheel && !c.companion) notes.push({ warn: false, text: "No companion seats are marked. Mark the seat beside each wheelchair space if it is for a companion." });
  if (!layout.items.some((it) => (FOCUS_KINDS as readonly string[]).includes(it.kind))) {
    notes.push({ warn: false, text: "There's no stage, ring or pitch on the plan. Buyers use it to see which way they'll face." });
  }
  if (c.held) notes.push({ warn: false, text: `${c.held} held ${c.held === 1 ? "seat stays" : "seats stay"} off sale until you put ${c.held === 1 ? "it" : "them"} on sale.` });
  return notes;
}
