/**
 * Where everything sits, derived from a layout. One pass serves the builder, the
 * buyer's map, thumbnails and "best seats", so all of them agree. Positions are in
 * design pixels; an item's own coordinates have its origin at its middle (for a
 * block of rows, the middle of the front row) before its rotation.
 *
 * Not part of what the ledger commits: seat identity is the walk in plan.ts. Drawing
 * may change between releases; seat numbers never do.
 */

import { FOCUS_KINDS, type LayoutItem, type LayoutSeat, type RowsItem, seatLists } from "./layout.js";
import { seatRefs } from "./plan.js";

export const SEAT_PITCH = 22;
export const SEAT_SIZE = 16;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SeatPoint {
  /** List within the item (a row; 0 for a table). */
  row: number;
  /** Position in that list, counting gaps. */
  pos: number;
  seat: LayoutSeat;
  x: number;
  y: number;
  /** Which way the seat faces, degrees (0 = towards negative y). */
  a: number;
}

export interface ItemLabel {
  kind: "row" | "title";
  row?: number;
  text: string;
  x: number;
  y: number;
}

export interface ItemGeometry {
  seats: SeatPoint[];
  labels: ItemLabel[];
  box: Box;
}

const maxLen = (it: RowsItem) => Math.max(1, ...it.rows.map((r) => r.seats.length));

/** Radius of a curved block's front row, 0 when straight. */
function curveRadius(it: RowsItem): number {
  const c = it.curve / 100;
  if (!(c > 0.02)) return 0;
  const half = (maxLen(it) * SEAT_PITCH) / 2;
  return Math.max(half * 0.75, half / (c * 1.2));
}
export const roundTableRadius = (n: number) => Math.max(28, (n * SEAT_PITCH) / (2 * Math.PI) + 6);
export const longTableLength = (n: number) => Math.max(1, Math.ceil(n / 2)) * SEAT_PITCH + 8;
export const headTableLength = (n: number) => Math.max(1, n) * SEAT_PITCH + 8;

function boxOf(seats: readonly SeatPoint[], labels: readonly ItemLabel[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of seats) { x0 = Math.min(x0, p.x - 10); x1 = Math.max(x1, p.x + 10); y0 = Math.min(y0, p.y - 10); y1 = Math.max(y1, p.y + 10); }
  for (const p of labels) { x0 = Math.min(x0, p.x - 8); x1 = Math.max(x1, p.x + 8); y0 = Math.min(y0, p.y - 7); y1 = Math.max(y1, p.y + 7); }
  if (!Number.isFinite(x0)) return { x0: -20, y0: -20, x1: 20, y1: 20 };
  return { x0, y0, x1, y1 };
}

export function itemGeometry(it: LayoutItem): ItemGeometry {
  const seats: SeatPoint[] = [];
  const labels: ItemLabel[] = [];
  let box: Box;
  if (it.kind === "rows") {
    const R = curveRadius(it);
    it.rows.forEach((row, r) => {
      const n = row.seats.length;
      // Curved rows share a centre in front of the block, so every row bows round the stage.
      const at = (u: number) => {
        if (!R) return { x: u, y: r * SEAT_PITCH, a: 0 };
        const Rr = R + r * SEAT_PITCH, t = u / Rr;
        return { x: Rr * Math.sin(t), y: -R + Rr * Math.cos(t), a: (-t * 180) / Math.PI };
      };
      row.seats.forEach((seat, pos) => seats.push({ row: r, pos, seat, ...at((pos - (n - 1) / 2) * SEAT_PITCH) }));
      const end = ((n - 1) / 2) * SEAT_PITCH + SEAT_PITCH * 0.95;
      const L = at(-end), Rt = at(end);
      labels.push({ kind: "row", row: r, text: row.label, x: L.x, y: L.y }, { kind: "row", row: r, text: row.label, x: Rt.x, y: Rt.y });
    });
    box = boxOf(seats, labels);
    labels.push({ kind: "title", text: it.name, x: 0, y: box.y0 - 8 });
    box.y0 -= 22;
  } else if (it.kind === "table") {
    const n = it.seats.length;
    if (it.shape === "long") {
      const top = Math.ceil(n / 2), bot = n - top, len = longTableLength(n);
      it.seats.forEach((seat, pos) => {
        const onTop = pos < top, k = onTop ? pos : pos - top, m = onTop ? top : bot;
        // The far side counts back, so seat numbers run round the table.
        const x = onTop ? (k - (m - 1) / 2) * SEAT_PITCH : ((m - 1) / 2 - k) * SEAT_PITCH;
        seats.push({ row: 0, pos, seat, x, y: onTop ? -26 : 26, a: onTop ? 0 : 180 });
      });
      box = { x0: -len / 2 - 4, x1: len / 2 + 4, y0: -36, y1: 36 };
    } else if (it.shape === "head") {
      const len = headTableLength(n);
      it.seats.forEach((seat, pos) => seats.push({ row: 0, pos, seat, x: (pos - (n - 1) / 2) * SEAT_PITCH, y: -26, a: 0 }));
      box = { x0: -len / 2 - 4, x1: len / 2 + 4, y0: -36, y1: 16 };
    } else {
      const Rs = roundTableRadius(n);
      it.seats.forEach((seat, pos) => {
        const a = -Math.PI / 2 + (pos / n) * Math.PI * 2;
        seats.push({ row: 0, pos, seat, x: Rs * Math.cos(a), y: Rs * Math.sin(a), a: (a * 180) / Math.PI + 90 });
      });
      box = { x0: -Rs - 10, x1: Rs + 10, y0: -Rs - 10, y1: Rs + 10 };
    }
  } else {
    box = { x0: -it.w / 2, x1: it.w / 2, y0: -it.h / 2, y1: it.h / 2 };
  }
  return { seats, labels, box };
}

/** Item space -> room space. */
export function toWorld(it: Pick<LayoutItem, "x" | "y" | "rot">, x: number, y: number): { x: number; y: number } {
  const a = (it.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: it.x + x * c - y * s, y: it.y + x * s + y * c };
}

/** Room space -> item space. */
export function toLocal(it: Pick<LayoutItem, "x" | "y" | "rot">, X: number, Y: number): { x: number; y: number } {
  const a = (-it.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), dx = X - it.x, dy = Y - it.y;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function itemWorldBox(it: LayoutItem, g: ItemGeometry = itemGeometry(it)): Box {
  const b = g.box;
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => toWorld(it, x, y));
  return {
    x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)),
  };
}

export function unionBox(items: readonly LayoutItem[]): Box {
  if (!items.length) return { x0: 400, y0: 100, x1: 900, y1: 500 };
  const bs = items.map((it) => itemWorldBox(it));
  return {
    x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)),
    x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)),
  };
}

/** Every seat's room position, by seat index (the walk's order). */
export function seatWorldPoints(items: readonly LayoutItem[]): { x: number; y: number }[] {
  const geoms = items.map(itemGeometry);
  const byItem = geoms.map((g) => {
    const m = new Map<string, SeatPoint>();
    for (const p of g.seats) m.set(`${p.row}:${p.pos}`, p);
    return m;
  });
  return seatRefs(items).map((ref) => {
    const p = byItem[ref.item].get(`${ref.row}:${ref.pos}`) as SeatPoint;
    return toWorld(items[ref.item], p.x, p.y);
  });
}

/** What the audience faces: the first stage, ring or pitch; else the top middle of the room. */
export function planFocus(items: readonly LayoutItem[]): { x: number; y: number } {
  const f = items.find((it) => (FOCUS_KINDS as readonly string[]).includes(it.kind));
  if (f) return { x: f.x, y: f.y };
  const b = unionBox(items);
  return { x: (b.x0 + b.x1) / 2, y: b.y0 };
}

/** Number of real seats in an item. */
export function itemSeatCount(it: LayoutItem): number {
  let n = 0;
  for (const list of seatLists(it)) for (const s of list) if (!("g" in s)) n++;
  return n;
}
