/**
 * The buyer map's camera, as pure maths: what part of the room is on screen, how far
 * in it is zoomed, and which level of detail that calls for. picker.ts does the DOM.
 *
 * `z` is screen pixels per design pixel. A seat is SEAT_SIZE design pixels, plus a
 * 2 px hit margin on each side (draw.ts `seat-hit`).
 */

import { SEAT_SIZE, type Box } from "@woco/shared/seating/geometry";

export interface View {
  /** Room-space centre of the screen. */
  cx: number;
  cy: number;
  z: number;
}

export interface Screen {
  w: number;
  h: number;
}

/** Up to this many seats the whole map is drawn seat by seat at every zoom. */
export const SEATS_ALWAYS_DRAWN = 2_500;
/** Above it, seats smaller than this on screen are drawn as whole sections. */
export const SECTION_LEVEL_BELOW_PX = 7;
/** Hit target a finger needs (docs/SEATING.md: 28 px). */
export const TOUCH_TARGET_PX = 28;
/** And a mouse. */
export const POINTER_TARGET_PX = 14;
const MAX_Z = 4;
const PAD = 24;

/** The seat's hit target on screen at zoom `z`. */
export const seatTargetPx = (z: number): number => (SEAT_SIZE + 4) * z;

/** The zoom at which a seat's hit target is `px` on screen. */
export const zoomForTarget = (px: number): number => px / (SEAT_SIZE + 4);

export function viewBoxOf(v: View, s: Screen): { x: number; y: number; w: number; h: number } {
  const w = s.w / v.z, h = s.h / v.z;
  return { x: v.cx - w / 2, y: v.cy - h / 2, w, h };
}

/** The view showing `box` whole, padded, centred. */
export function fitBox(box: Box, s: Screen, pad = PAD): View {
  const bw = Math.max(1, box.x1 - box.x0 + pad * 2), bh = Math.max(1, box.y1 - box.y0 + pad * 2);
  const z = Math.max(0.01, Math.min(s.w / bw, s.h / bh));
  return { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, z };
}

/** Zoom limits: never smaller than most of the whole room, never past MAX_Z (or the touch target). */
export function zoomLimits(bounds: Box, s: Screen): { min: number; max: number } {
  const min = fitBox(bounds, s).z * 0.7;
  return { min, max: Math.max(MAX_Z, zoomForTarget(TOUCH_TARGET_PX) * 1.5, min) };
}

/** Clamp zoom, and keep some of the room on screen whatever the pan. */
export function clampView(v: View, bounds: Box, s: Screen): View {
  const { min, max } = zoomLimits(bounds, s);
  const z = Math.min(max, Math.max(min, v.z));
  const halfW = s.w / z / 2, halfH = s.h / z / 2;
  const cx = Math.min(bounds.x1 + halfW * 0.5, Math.max(bounds.x0 - halfW * 0.5, v.cx));
  const cy = Math.min(bounds.y1 + halfH * 0.5, Math.max(bounds.y0 - halfH * 0.5, v.cy));
  return { cx, cy, z };
}

/** Zoom by `factor` keeping the room point under screen point (sx, sy) where it is. */
export function zoomAt(v: View, factor: number, sx: number, sy: number, s: Screen): View {
  const z = v.z * factor;
  const wx = v.cx + (sx - s.w / 2) / v.z, wy = v.cy + (sy - s.h / 2) / v.z;
  return { cx: wx - (sx - s.w / 2) / z, cy: wy - (sy - s.h / 2) / z, z };
}

/** Pan by a screen-pixel drag. */
export const panBy = (v: View, dx: number, dy: number): View => ({ cx: v.cx - dx / v.z, cy: v.cy - dy / v.z, z: v.z });

/** Most seats drawn one by one at once (~4 SVG nodes each): above it the screen shows sections. */
export const SEAT_DRAW_BUDGET = 4_000;

export type Level = "sections" | "seats";

/**
 * Seats one by one, or whole sections: small rooms are always seats; a big one shows
 * seats once they are big enough to see AND few enough on screen to draw smoothly.
 */
export function levelFor(seats: number, z: number, seatsOnScreen: number): Level {
  if (seats <= SEATS_ALWAYS_DRAWN) return "seats";
  return SEAT_SIZE * z >= SECTION_LEVEL_BELOW_PX && seatsOnScreen <= SEAT_DRAW_BUDGET ? "seats" : "sections";
}

/** Boxes that intersect the view, grown by `margin` of its size (drawn ahead of a pan). */
export function visible<T extends { box: Box }>(list: readonly T[], v: View, s: Screen, margin = 0.3): number[] {
  const vb = viewBoxOf(v, s);
  const mx = vb.w * margin, my = vb.h * margin;
  const x0 = vb.x - mx, y0 = vb.y - my, x1 = vb.x + vb.w + mx, y1 = vb.y + vb.h + my;
  const out: number[] = [];
  list.forEach((it, i) => {
    if (it.box.x1 >= x0 && it.box.x0 <= x1 && it.box.y1 >= y0 && it.box.y0 <= y1) out.push(i);
  });
  return out;
}

/**
 * The view to show these room points from `current`: unchanged when they are already on
 * screen with seats big enough to tap (`minZ`), else centred on them at `minZ` or the
 * current zoom, whichever is closer in. Never zooms in further than that: the buyer
 * should still see where in the room the seats are.
 */
export function showPoints(current: View, points: readonly { x: number; y: number }[], s: Screen, minZ: number): View | null {
  if (!points.length) return null;
  if (current.z >= minZ && points.every((p) => onScreen(current, s, p.x, p.y, 40))) return current;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  // Zoomed in enough to tap, but never so far that the picks spill off screen.
  const fits = fitBox({ x0, y0, x1, y1 }, s, 60).z;
  const z = Math.min(fits, Math.max(minZ, current.z));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z };
}

/** Is room point (x, y) on screen, inset by `inset` screen pixels? */
export function onScreen(v: View, s: Screen, x: number, y: number, inset = 24): boolean {
  const sx = (x - v.cx) * v.z + s.w / 2, sy = (y - v.cy) * v.z + s.h / 2;
  return sx >= inset && sx <= s.w - inset && sy >= inset && sy <= s.h - inset;
}
