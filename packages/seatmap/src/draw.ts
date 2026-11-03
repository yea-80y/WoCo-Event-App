/**
 * Drawing a seating layout as SVG. `drawItem` paints one thing in four modes:
 *   layout - the builder's first step: things are grabbable, the selection shows handles
 *   seats  - the builder's second step: seats, row letters and table tops are paintable
 *   buy    - the buyer's map: free seats are buttons, the rest are small marks
 *   thumb  - small previews (starting layouts, a thing being dragged in)
 *
 * Presentation lives in attributes (colours and fonts from the palette), so a drawing
 * looks the same in the app, on an organiser's website and inside an embed. Behaviour
 * (cursors, hover) is the host page's CSS, keyed on the classes and data attributes:
 *   .it[data-id]            an item (layout mode)          .handle[data-handle]  a handle
 *   .seat[data-key]         "item:row:pos" (seats mode)    [data-rowlab] / [data-tabletop]
 *   .seat[data-seat]        the seat index (buy mode)
 */

import {
  type LayoutItem,
  type LayoutSeat,
  type SeatBand,
  type SeatLayout,
  SHAPE_KINDS,
  isGap,
} from "@woco/shared/seating/layout";
import {
  SEAT_SIZE,
  headTableLength,
  itemGeometry,
  longTableLength,
  roundTableRadius,
  unionBox,
  type Box,
} from "@woco/shared/seating/geometry";
import { bandStyle, type BandStyle, type SeatmapPalette } from "./palette.js";

const NS = "http://www.w3.org/2000/svg";
const r2 = (v: number) => Math.round(v * 100) / 100;

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | null | undefined> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(n);
  return n;
}

/** Patterns the fills use. Ids are per drawing: a pattern inside a hidden drawing would not paint. */
export function drawDefs(svg: SVGSVGElement, p: SeatmapPalette): void {
  const id = svg.id;
  const d = el("defs", {}, svg);
  const pattern = (name: string, size: number, rot: number, bg: string, paint: (g: SVGPatternElement) => void) => {
    const pt = el("pattern", { id: `${id}-${name}`, width: size, height: size, patternUnits: "userSpaceOnUse", patternTransform: `rotate(${rot})` }, d);
    el("rect", { width: size, height: size, fill: bg }, pt);
    paint(pt);
  };
  for (let k = 0; k < 8; k++) {
    const st = bandStyle(p, k);
    if (st.kind === "hatch") pattern(`band${k}`, 4, 45, p.surface, (g) => el("line", { x1: 0, y1: 0, x2: 0, y2: 4, stroke: st.tone, "stroke-width": 2 }, g));
    if (st.kind === "cross") pattern(`band${k}`, 5, 45, p.surface, (g) => {
      el("line", { x1: 0, y1: 0, x2: 0, y2: 5, stroke: st.tone, "stroke-width": 1.4 }, g);
      el("line", { x1: 0, y1: 0, x2: 5, y2: 0, stroke: st.tone, "stroke-width": 1.4 }, g);
    });
    if (st.kind === "dots") pattern(`band${k}`, 4, 0, p.surface, (g) => el("circle", { cx: 2, cy: 2, r: 1.1, fill: st.tone }, g));
  }
  pattern("held", 5, -45, p.elevated, (g) => el("line", { x1: 0, y1: 0, x2: 0, y2: 5, stroke: p.dim, "stroke-width": 2 }, g));
  pattern("floor", 10, 45, p.surface, (g) => el("line", { x1: 0, y1: 0, x2: 0, y2: 10, stroke: p.line, "stroke-width": 3 }, g));
}

function bandFill(svgId: string, st: BandStyle, k: number, p: SeatmapPalette): { fill: string; stroke: string; width: number; dash?: string } {
  switch (st.kind) {
    case "solid": return { fill: st.tone, stroke: st.tone, width: 1 };
    case "outline": return { fill: "transparent", stroke: st.tone, width: 1.5 };
    case "dashed": return { fill: p.surface, stroke: st.tone, width: 1.5, dash: "2.5 1.5" };
    default: return { fill: `url(#${svgId}-band${k})`, stroke: st.tone, width: 1 };
  }
}

function seatRect(g: Element, x: number, y: number, f: { fill: string; stroke: string; width: number; dash?: string }): SVGRectElement {
  return el("rect", {
    class: "seat-shape", x: r2(x + 0.5), y: r2(y + 0.5), width: SEAT_SIZE - 1, height: SEAT_SIZE - 1, rx: 2,
    fill: f.fill, stroke: f.stroke, "stroke-width": f.width, "stroke-dasharray": f.dash ?? null,
  }, g);
}

/** A small wheelchair mark on a seat whose top-left corner is (x, y). */
function wheelMark(g: Element, x: number, y: number, color: string): void {
  el("circle", { cx: r2(x + 8), cy: r2(y + 4.2), r: 1.6, fill: color }, g);
  el("path", {
    d: `M${r2(x + 7.6)} ${r2(y + 6.2)}v4.2h3.4l1.4 2.8M${r2(x + 6)} ${r2(y + 8.4)}a3.4 3.4 0 1 0 4.8 3.8`,
    fill: "none", stroke: color, "stroke-width": 1.3, "stroke-linecap": "round",
  }, g);
}

/** A companion-seat mark: a small dot in the corner. */
function companionMark(g: Element, x: number, y: number, color: string): void {
  el("circle", { cx: r2(x + SEAT_SIZE - 4), cy: r2(y + 4), r: 1.8, fill: color }, g);
}

/** Flip text that would read upside down on something turned past a quarter. */
function upright(rot: number, x = 0, y = 0): string | null {
  return rot > 90 && rot < 270 ? `rotate(180 ${r2(x)} ${r2(y)})` : null;
}

function tableShort(it: Extract<LayoutItem, { kind: "table" }>): string {
  const m = /^Table\s+(\d+)$/i.exec(it.name);
  if (it.shape !== "round") {
    // The name runs along the table, so it gets the table's length.
    const len = it.shape === "head" ? headTableLength(it.seats.length) : longTableLength(it.seats.length);
    const room = Math.floor((len - 10) / 6.4);
    return it.name.length <= room ? it.name : m ? m[1] : `${it.name.slice(0, Math.max(1, room - 1))}…`;
  }
  if (m) return m[1];
  return roundTableRadius(it.seats.length) >= 40 ? it.name.slice(0, 7) : it.name.slice(0, 3);
}

/** What a buyer's map needs to know per seat. Seats are addressed by their plan index. */
export interface BuyerView {
  /** Seat index of (item, row, pos), or -1 for a gap. */
  seatAt(item: number, row: number, pos: number): number;
  free(k: number): boolean;
  picked(k: number): boolean;
  /** The spoken label: "Stalls, Row D, seat 7, £22, wheelchair space". */
  label(k: number): string;
  /** The printed number on a picked seat. */
  number(k: number): number;
  /** Picking is paused (a hold is running). */
  locked: boolean;
}

export type DrawMode = "layout" | "seats" | "buy" | "thumb";

export interface DrawOptions {
  mode: DrawMode;
  /** The <svg>'s id (pattern references). */
  svgId: string;
  palette: SeatmapPalette;
  bands: readonly SeatBand[];
  itemIndex: number;
  selected?: boolean;
  /** Layout mode: draw the selection's handles, sized for this zoom. */
  handles?: { zoom: number };
  /** Layout mode: the item's spoken description. */
  describe?: string;
  buyer?: BuyerView;
}

export function drawItem(parent: Element, it: LayoutItem, o: DrawOptions): SVGGElement {
  const { mode, svgId, palette: p } = o;
  const G = itemGeometry(it);
  const b = G.box;
  const g = el("g", {
    class: `it k-${it.kind}${o.selected ? " is-sel" : ""}`,
    "data-id": it.id,
    transform: `translate(${r2(it.x)} ${r2(it.y)})${it.rot ? ` rotate(${it.rot})` : ""}`,
  }, parent);
  if (mode === "layout") {
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-pressed", String(!!o.selected));
    if (o.describe) g.setAttribute("aria-label", o.describe);
    el("rect", {
      class: "hover-box", x: b.x0 - 6, y: b.y0 - 6, width: b.x1 - b.x0 + 12, height: b.y1 - b.y0 + 12, rx: 6,
      fill: "transparent", stroke: o.selected ? p.accent : "transparent", "stroke-dasharray": o.selected ? "5 4" : null,
      "stroke-width": o.selected ? 1.5 : 1, "vector-effect": "non-scaling-stroke",
    }, g);
  }
  const text = (attrs: Record<string, string | number | null>, content: string, size: number, weight: number, fill: string, mono = false) => {
    const t = el("text", {
      ...attrs, "text-anchor": "middle", "font-size": size, "font-weight": weight, fill,
      "font-family": mono ? p.fontMono : p.fontUi, "pointer-events": "none",
    }, g);
    t.textContent = content;
    return t;
  };

  // Shapes
  if ((SHAPE_KINDS as readonly string[]).includes(it.kind) && "w" in it) {
    const x = -it.w / 2, y = -it.h / 2;
    if (it.kind === "stage") el("rect", { x, y, width: it.w, height: it.h, rx: 3, fill: p.text2 }, g);
    if (it.kind === "bar") el("rect", { x, y, width: it.w, height: it.h, rx: 3, fill: p.elevated, stroke: p.lineStrong }, g);
    if (it.kind === "floor") el("rect", { x, y, width: it.w, height: it.h, rx: 3, fill: `url(#${svgId}-floor)`, stroke: p.lineStrong, "stroke-dasharray": "5 4" }, g);
    if (it.kind === "pitch") {
      el("rect", { x, y, width: it.w, height: it.h, rx: 2, fill: p.surface, stroke: p.dim, "stroke-width": 1.5 }, g);
      // Halfway line and centre circle only: reads as any sport's pitch or court.
      const m = { fill: "none", stroke: p.lineStrong, "stroke-width": 1.2 };
      el("line", { x1: 0, y1: y, x2: 0, y2: -y, ...m }, g);
      el("circle", { cx: 0, cy: 0, r: r2(Math.min(it.w, it.h) * 0.14), ...m }, g);
      el("circle", { cx: 0, cy: 0, r: 2, fill: p.lineStrong }, g);
    }
    if (it.kind === "ring") {
      el("rect", { x, y, width: it.w, height: it.h, rx: 2, fill: p.elevated, stroke: p.lineStrong }, g);
      for (const inset of [7, 13]) el("rect", { x: x + inset, y: y + inset, width: it.w - inset * 2, height: it.h - inset * 2, fill: "none", stroke: p.muted, "stroke-width": 1 }, g);
      for (const [cx, cy] of [[x, y], [-x, y], [x, -y], [-x, -y]]) el("rect", { x: cx - 4.5, y: cy - 4.5, width: 9, height: 9, rx: 1, fill: p.text2 }, g);
    }
    if (mode !== "thumb" && it.kind !== "pitch") {
      text({ x: 0, y: 4.5, transform: upright(it.rot) }, it.text, 13, 600, it.kind === "stage" ? p.bg : p.text2);
    }
  }

  // Table top
  if (it.kind === "table") {
    const top = mode === "seats" ? { "data-tabletop": o.itemIndex, class: "tabletop" } : {};
    const n = it.seats.length;
    const attrs = { fill: p.surface, stroke: p.lineStrong, ...top };
    if (it.shape === "round") el("circle", { cx: 0, cy: 0, r: r2(roundTableRadius(n) - 15), ...attrs }, g);
    else if (it.shape === "head") { const len = headTableLength(n); el("rect", { x: -len / 2, y: -13, width: len, height: 22, rx: 3, ...attrs }, g); }
    else { const len = longTableLength(n); el("rect", { x: -len / 2, y: -13, width: len, height: 26, rx: 3, ...attrs }, g); }
    if (mode !== "thumb") {
      // A round table keeps its number upright; on a long one it reads along the table, never upside down.
      const turn = it.shape === "round" ? (it.rot ? `rotate(${-it.rot})` : null) : upright(it.rot);
      text({ x: 0, y: it.shape === "head" ? 1.5 : 3.5, transform: turn }, tableShort(it), 10, 500, p.text2, true);
    }
  }

  // Row letters and the block's name: row letters stay upright on a turned block.
  if (mode !== "thumb") {
    for (const lb of G.labels) {
      const tf = lb.kind === "row" ? (it.rot ? `rotate(${-it.rot} ${r2(lb.x)} ${r2(lb.y)})` : null) : upright(it.rot, lb.x, lb.y);
      const t = text({ x: r2(lb.x), y: r2(lb.y + 3.5), transform: tf }, lb.text, lb.kind === "title" ? 12 : 10, 500,
        lb.kind === "title" ? p.text2 : p.muted, lb.kind === "row");
      if (lb.kind === "row" && mode === "seats") {
        t.setAttribute("data-rowlab", `${o.itemIndex}:${lb.row}`);
        t.setAttribute("class", "row-lab");
        t.removeAttribute("pointer-events");
      }
    }
  }

  // Seats
  const bandIndex = new Map(o.bands.map((bd, i) => [bd.id, i]));
  for (const s of G.seats) {
    const x = s.x - SEAT_SIZE / 2, y = s.y - SEAT_SIZE / 2;
    const rot = s.a ? `rotate(${r2(s.a)} ${r2(s.x)} ${r2(s.y)})` : null;
    const seat = s.seat;
    const bk = isGap(seat) ? 0 : (o.bands[bandIndex.get(seat.b) ?? 0]?.style ?? 0);
    const st = bandStyle(p, bk);
    const fill = bandFill(svgId, st, bk, p);

    if (mode === "buy" && o.buyer) {
      const k = o.buyer.seatAt(o.itemIndex, s.row, s.pos);
      if (k < 0 || isGap(seat)) continue;
      const picked = o.buyer.picked(k), free = o.buyer.free(k);
      const sg = el("g", { class: `seat${free && !o.buyer.locked ? " avail" : ""}`, "data-seat": k, transform: rot }, g);
      if (free || picked) {
        sg.setAttribute("tabindex", "0");
        sg.setAttribute("role", "button");
        sg.setAttribute("aria-pressed", String(picked));
        sg.setAttribute("aria-label", o.buyer.label(k));
      }
      el("rect", { class: "seat-hit", x: x - 2, y: y - 2, width: SEAT_SIZE + 4, height: SEAT_SIZE + 4, fill: "transparent" }, sg);
      if (picked) {
        seatRect(sg, x, y, { fill: p.accent, stroke: p.accent, width: 1 });
        const turn = -((it.rot || 0) + (s.a || 0));
        const n = el("text", {
          x: r2(s.x), y: r2(s.y + 3), "text-anchor": "middle", "font-size": 8, "font-family": p.fontMono, fill: p.accentInk,
          "pointer-events": "none", transform: turn ? `rotate(${r2(turn)} ${r2(s.x)} ${r2(s.y)})` : null,
        }, sg);
        n.textContent = String(o.buyer.number(k));
      } else if (free) {
        seatRect(sg, x, y, fill);
        if (seat.a) wheelMark(sg, x, y, st.ink);
      } else {
        // Sold, held, or not in the chosen price: a small mark, so free seats read first.
        el("rect", { x: x + 4, y: y + 4, width: SEAT_SIZE - 8, height: SEAT_SIZE - 8, rx: 1, fill: p.line }, sg);
      }
      continue;
    }

    if (mode === "thumb" && isGap(seat)) continue;
    const sg = el("g", { class: "seat", "data-key": mode === "seats" ? `${o.itemIndex}:${s.row}:${s.pos}` : null, transform: rot }, g);
    if (mode === "seats") el("rect", { class: "seat-hit", x: x - 2, y: y - 2, width: SEAT_SIZE + 4, height: SEAT_SIZE + 4, fill: "transparent" }, sg);
    if (isGap(seat)) {
      el("rect", { x: x + 3, y: y + 3, width: SEAT_SIZE - 6, height: SEAT_SIZE - 6, rx: 1, fill: "none", stroke: p.lineStrong, "stroke-dasharray": "2 2" }, sg);
      continue;
    }
    if (seat.h) {
      seatRect(sg, x, y, { fill: `url(#${svgId}-held)`, stroke: p.dim, width: 1 });
    } else {
      seatRect(sg, x, y, fill);
    }
    if (seat.a) wheelMark(sg, x, y, seat.h ? p.text2 : st.ink);
    if (seat.c) companionMark(sg, x, y, seat.h ? p.text2 : st.ink);
  }

  if (o.handles) drawHandles(g, it, b, o.handles.zoom, p);
  return g;
}

// Handles stay the same size on screen whatever the zoom.
const GLYPH: Record<string, string> = {
  seats: "M-5 0h10M-5 0l2.5-2.5M-5 0l2.5 2.5M5 0l-2.5-2.5M5 0l-2.5 2.5",
  rows: "M0-5v10M0-5l-2.5 2.5M0-5l2.5 2.5M0 5l-2.5-2.5M0 5l2.5-2.5",
  tseats: "M-4.5 0h9M0-4.5v9",
  rotate: "M3.9 2.25A4.5 4.5 0 1 1 3.9 -2.25M3.9-2.25l-2.8-.3M3.9-2.25l.4-2.8",
  resize: "M-3.5-3.5l7 7M3.5 3.5v-4.5M3.5 3.5h-4.5",
};

export type HandleKind = "seats" | "rows" | "tseats" | "rotate" | "resize";

export function handlesFor(it: LayoutItem, b: Box): { h: HandleKind; x: number; y: number; tip: string }[] {
  const my = (b.y0 + b.y1) / 2;
  const list: { h: HandleKind; x: number; y: number; tip: string }[] = [];
  if (it.kind === "rows") {
    list.push({ h: "seats", x: b.x1 + 16, y: my, tip: "Drag sideways to add or take away seats in every row" });
    list.push({ h: "rows", x: 0, y: b.y1 + 16, tip: "Drag down to add rows, up to take them away" });
    list.push({ h: "rotate", x: 0, y: b.y0 - 24, tip: "Drag to turn" });
  } else if (it.kind === "table") {
    list.push({ h: "tseats", x: b.x1 + 16, y: it.shape === "head" ? -26 : 0, tip: "Drag out to add seats, in to take them away. Tap to add one." });
    if (it.shape !== "round") list.push({ h: "rotate", x: 0, y: b.y0 - 24, tip: "Drag to turn" });
  } else {
    if (it.kind !== "label") list.push({ h: "resize", x: b.x1, y: b.y1, tip: "Drag to resize" });
    list.push({ h: "rotate", x: 0, y: b.y0 - 24, tip: "Drag to turn" });
  }
  return list;
}

function drawHandles(g: Element, it: LayoutItem, b: Box, zoom: number, p: SeatmapPalette): void {
  const z = 1 / zoom;
  for (const h of handlesFor(it, b)) {
    if (h.h === "rotate") {
      el("line", { x1: 0, y1: b.y0 - 6, x2: 0, y2: h.y, stroke: p.accent, "stroke-width": z, "stroke-dasharray": `${2 * z} ${2 * z}` }, g);
    }
    const hg = el("g", { class: `handle h-${h.h}`, "data-handle": h.h, transform: `translate(${r2(h.x)} ${r2(h.y)}) scale(${z.toFixed(3)})` }, g);
    el("title", {}, hg).textContent = h.tip;
    el("circle", { r: 9, fill: p.accent, stroke: p.accentInk, "stroke-width": 2 }, hg);
    el("path", { d: GLYPH[h.h], fill: "none", stroke: p.accentInk, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }, hg);
  }
}

/** Shapes first, then seats, then labels, so seats are never under a floor. */
const Z: Record<string, number> = { pitch: 0, floor: 0, stage: 1, ring: 1, bar: 1, rows: 2, table: 2, label: 3 };

/** Item indices in drawing order. */
export function drawOrder(items: readonly LayoutItem[]): number[] {
  return items.map((_, i) => i).sort((a, b) => (Z[items[a].kind] ?? 2) - (Z[items[b].kind] ?? 2) || a - b);
}

/** A whole layout, fitted to `svg` (thumbnails, previews). */
export function drawThumb(svg: SVGSVGElement, layout: Pick<SeatLayout, "bands" | "items">, palette: SeatmapPalette, pad = 24): void {
  svg.replaceChildren();
  const cb = unionBox(layout.items);
  svg.setAttribute("viewBox", `${cb.x0 - pad} ${cb.y0 - pad} ${cb.x1 - cb.x0 + pad * 2} ${cb.y1 - cb.y0 + pad * 2}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  drawDefs(svg, palette);
  for (const i of drawOrder(layout.items)) {
    drawItem(svg, layout.items[i], { mode: "thumb", svgId: svg.id, palette, bands: layout.bands, itemIndex: i });
  }
}

/** A swatch for band style `k`, as markup (legends, the price list). */
export function swatchSvg(p: SeatmapPalette, k: number, size = 14): string {
  const st = bandStyle(p, k);
  const s = 13;
  const base = `<rect x=".5" y=".5" width="${s}" height="${s}" rx="2"`;
  let inner: string;
  switch (st.kind) {
    case "solid": inner = `${base} fill="${st.tone}"/>`; break;
    case "outline": inner = `${base} fill="none" stroke="${st.tone}" stroke-width="1.5"/>`; break;
    case "dashed": inner = `${base} fill="none" stroke="${st.tone}" stroke-width="1.5" stroke-dasharray="2.5 1.5"/>`; break;
    case "dots": inner = `${base} fill="${p.surface}" stroke="${st.tone}"/><g fill="${st.tone}">${[3.5, 7, 10.5].flatMap((x) => [3.5, 7, 10.5].map((y) => `<circle cx="${x}" cy="${y}" r="1"/>`)).join("")}</g>`; break;
    case "cross": inner = `${base} fill="${p.surface}" stroke="${st.tone}"/><path d="M1 13L13 1M1 1l12 12" stroke="${st.tone}" stroke-width="1.4"/>`; break;
    default: inner = `${base} fill="${p.surface}" stroke="${st.tone}"/><path d="M0 14L14 0M-4 10L10-4M4 18L18 4" stroke="${st.tone}" stroke-width="2"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true">${inner}</svg>`;
}

/** A seat-state helper the buyer map shares: a layout seat, by list position. */
export function layoutSeatAt(it: LayoutItem, row: number, pos: number): LayoutSeat | undefined {
  if (it.kind === "rows") return it.rows[row]?.seats[pos];
  if (it.kind === "table") return it.seats[pos];
  return undefined;
}
