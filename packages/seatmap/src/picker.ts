/**
 * The buyer's seat map on a page: an SVG that pans, pinches and zooms, draws whole
 * sections when seats would be too small to see, draws only the blocks on screen
 * for big rooms, and turns taps, clicks and keys into "this seat". Framework-free,
 * so the app, organisers' websites and the embed run the same picker; what a pick
 * MEANS (price, holds, limits) is the host's, through `onSeat`. docs/SEATING.md.
 *
 * A tap on a seat too small for a finger zooms in instead of picking it, so nobody
 * buys the seat next to the one they meant.
 */

import { itemGeometry, type Box } from "@woco/shared/seating/geometry";
import { hasSeats } from "@woco/shared/seating/layout";
import { drawDefs, drawItem, el, type BuyerView } from "./draw.js";
import type { SeatmapPalette } from "./palette.js";
import { neighbour, seatAt, type BuyerPlan, type Direction } from "./buyer.js";
import {
  POINTER_TARGET_PX, SEATS_ALWAYS_DRAWN, TOUCH_TARGET_PX, clampView, fitBox, levelFor, onScreen, panBy, seatTargetPx, showPoints,
  viewBoxOf, visible, zoomAt, zoomForTarget, type Level, type Screen, type View,
} from "./view.js";

/** What the map shows. The host owns every rule; the picker only draws and reports. */
export interface PickerState {
  picks: readonly number[];
  /** Picking paused: a hold is being placed or is running. */
  locked: boolean;
  /** Drawn in its band's fill (free, or not checkable right now), else as a small mark. */
  free(k: number): boolean;
  /** Choosing it does something: a buyer picks a free seat in their price; the dashboard (S6) may select any. */
  canPick(k: number): boolean;
  /** The seat's spoken label. */
  label(k: number): string;
  /** Why it cannot be chosen ("sold"), null when it can. */
  reason(k: number): string | null;
  /** A section's second line in the overview: "40 free · £22-28". */
  sectionLine(section: number): string;
  /** No free seat in the section (drawn quieter). */
  sectionEmpty(section: number): boolean;
}

export interface PickerOptions {
  plan: BuyerPlan;
  palette: SeatmapPalette;
  /** Unique per page: pattern ids hang off it. */
  id: string;
  /** "Seating plan for <event>". */
  label: string;
  /** A tap, click or Enter on a seat the buyer can pick or un-pick (a picked seat always counts). */
  onSeat(k: number): void;
  /** The level of detail changed: the host can say "Tap a section" or "Tap seats". */
  onLevel?(level: Level): void;
  /** The sections on screen changed (indices into `plan.sections`): what a live map keeps fresh. */
  onView?(sections: readonly number[]): void;
}

export interface Picker {
  set(state: PickerState): void;
  /** Zoom to these seats (best seats, a pick in the order list). */
  showSeats(seats: readonly number[]): void;
  showSection(section: number): void;
  fit(): void;
  zoomBy(factor: number): void;
  focusSeat(k: number): void;
  /** Say something to screen readers ("Added Stalls, Row D, seat 7. 2 seats, £44"). */
  announce(text: string): void;
  destroy(): void;
}

const Z_LAYER: Record<string, number> = { pitch: 0, floor: 0, stage: 1, ring: 1, bar: 1, rows: 2, table: 2, label: 3 };
const TAP_SLOP_PX = 6;

export function createPicker(container: HTMLElement, o: PickerOptions): Picker {
  const bp = o.plan;
  const p = o.palette;
  const items = bp.plan.items;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const minTarget = coarse ? TOUCH_TARGET_PX : POINTER_TARGET_PX;

  const svg = el("svg", {
    id: o.id, class: "wsm-map", role: "group", "aria-label": o.label, tabindex: "0", focusable: "true",
    preserveAspectRatio: "xMidYMid meet",
  }) as SVGSVGElement;
  svg.style.cssText = "display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none;outline:none";
  container.appendChild(svg);
  drawDefs(svg, p);
  const layers = [0, 1, 2, 3].map((z) => el("g", { class: `wsm-l${z}` }, svg));
  const blockLayer = el("g", { class: "wsm-blocks" }, svg);

  // Shapes are few: always drawn. Seat items are drawn when on screen.
  const seatItems = bp.sections.map((s) => s.item);
  const sectionBoxes = bp.sections.map((s) => ({ box: s.box }));
  const localBox = new Map<number, Box>(seatItems.map((i) => [i, itemGeometry(items[i]).box]));
  let state: PickerState | null = null;
  const drawn = new Map<number, SVGGElement>();
  let screen: Screen = { w: 0, h: 0 };
  let view: View = { cx: 0, cy: 0, z: 1 };
  let level: Level | null = null;
  let fitted = false;

  const live = document.createElement("div");
  live.setAttribute("aria-live", "polite");
  live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";
  container.appendChild(live);

  // The roving tab stop: the one seat Tab reaches; arrows move it.
  let stop = -1;
  const buyerView = (): BuyerView => {
    const s = state;
    return {
      seatAt: (item, row, pos) => seatAt(bp, item, row, pos),
      free: (k) => !!s && s.free(k),
      canPick: (k) => !!s && s.canPick(k),
      picked: (k) => !!s && s.picks.includes(k),
      label: (k) => s?.label(k) ?? "",
      reason: (k) => s?.reason(k) ?? null,
      tabStop: (k) => k === stop,
      number: (k) => bp.plan.seats[k]?.n ?? 0,
      locked: !s || s.locked,
    };
  };
  const seatEl = (k: number) => svg.querySelector(`.seat[data-seat="${k}"]`) as SVGElement | null;
  function moveStop(k: number): void {
    if (k === stop) return;
    seatEl(stop)?.setAttribute("tabindex", "-1");
    stop = k;
    seatEl(stop)?.setAttribute("tabindex", "0");
  }

  for (let i = 0; i < items.length; i++) {
    if (hasSeats(items[i])) continue;
    drawItem(layers[Z_LAYER[items[i].kind] ?? 1], items[i], { mode: "buy", svgId: o.id, palette: p, bands: bp.plan.bands, itemIndex: i });
  }

  function drawSeatItem(i: number): void {
    const old = drawn.get(i);
    const g = drawItem(layers[2], items[i], {
      mode: "buy", svgId: o.id, palette: p, bands: bp.plan.bands, itemIndex: i, buyer: buyerView(),
    });
    if (old) { old.replaceWith(g); } // keep z-order stable
    drawn.set(i, g);
  }

  function drawBlocks(): void {
    blockLayer.replaceChildren();
    if (level !== "sections" || !state) return;
    const scale = 1 / view.z;
    bp.sections.forEach((sec, si) => {
      const it = items[sec.item];
      const b = localBox.get(sec.item)!;
      const g = el("g", {
        class: "wsm-block", "data-section": si, role: "button", tabindex: "0",
        "aria-label": `${sec.name}. ${state!.sectionLine(si)}`,
        transform: `translate(${it.x} ${it.y})${it.rot ? ` rotate(${it.rot})` : ""}`,
      }, blockLayer);
      const empty = state!.sectionEmpty(si);
      el("rect", {
        x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, rx: 6,
        fill: empty ? p.bg : p.elevated, stroke: empty ? p.line : p.lineStrong, "stroke-width": 1.5, "vector-effect": "non-scaling-stroke",
      }, g);
      // Text at a constant size on screen, always upright, and only as much as the block has room for.
      const w = (b.x1 - b.x0) * view.z, h = (b.y1 - b.y0) * view.z;
      const roomy = Math.min(w, h) >= 44 && Math.max(w, h) >= 96;
      const named = Math.min(w, h) >= 18 && Math.max(w, h) >= 52;
      if (!named) return;
      const t = el("g", { transform: `translate(${(b.x0 + b.x1) / 2} ${(b.y0 + b.y1) / 2})${it.rot ? ` rotate(${-it.rot})` : ""} scale(${scale})`, "pointer-events": "none" }, g);
      const name = el("text", { y: roomy ? -3 : 4, "text-anchor": "middle", "font-size": roomy ? 13 : 11, "font-weight": 600, fill: empty ? p.muted : p.text, "font-family": p.fontUi }, t);
      name.textContent = sec.name;
      if (!roomy) return;
      const line = el("text", { y: 13, "text-anchor": "middle", "font-size": 11, fill: p.text2, "font-family": p.fontMono }, t);
      line.textContent = state!.sectionLine(si);
    });
    // Stage, bar and signs keep a readable name at this zoom too.
    for (const it of items) {
      if (hasSeats(it) || it.kind === "pitch" || !it.text) continue;
      const t = el("text", {
        "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: it.kind === "stage" ? p.bg : p.text2, "font-family": p.fontUi,
        transform: `translate(${it.x} ${it.y}) scale(${scale})`, y: 4, "pointer-events": "none",
      }, blockLayer);
      t.textContent = it.text;
    }
  }

  function syncSeats(): void {
    const all = bp.seats <= SEATS_ALWAYS_DRAWN;
    const want = new Set(level !== "seats" ? [] : all ? seatItems : visible(sectionBoxes, view, screen, 0.15).map((si) => bp.sections[si].item));
    for (const [i, g] of drawn) if (!want.has(i)) { g.remove(); drawn.delete(i); }
    let added = false;
    for (const i of seatItems) if (want.has(i) && !drawn.has(i)) { drawSeatItem(i); added = true; }
    // Plan order, so items that overlap stack the same way however the buyer got there.
    if (added) for (const i of seatItems) { const g = drawn.get(i); if (g) layers[2].appendChild(g); }
  }

  function levelAt(v: View): Level {
    let onScreenSeats = 0;
    if (bp.seats > SEATS_ALWAYS_DRAWN) for (const si of visible(sectionBoxes, v, screen, 0)) onScreenSeats += bp.sections[si].count;
    return levelFor(bp.seats, v.z, onScreenSeats);
  }

  /** `v`, zoomed in (about its centre) until seats are drawn one by one there. */
  function seatsLevel(v: View): View {
    let out = clampView(v, bp.bounds, screen);
    for (let i = 0; i < 24 && levelAt(out) === "sections"; i++) {
      const next = clampView({ ...out, z: out.z * 1.2 }, bp.bounds, screen);
      if (next.z === out.z) break;
      out = next;
    }
    return out;
  }

  let frame = 0;
  let lastView = "";
  function render(): void {
    frame = 0;
    if (!screen.w || !screen.h) return;
    const vb = viewBoxOf(view, screen);
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const next = levelAt(view);
    const changed = next !== level;
    level = next;
    syncSeats();
    if (changed || level === "sections") drawBlocks();
    if (changed) o.onLevel?.(level);
    if (o.onView) {
      const on = visible(sectionBoxes, view, screen, 0);
      const key = on.join(",");
      if (key !== lastView) { lastView = key; o.onView(on); }
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  function setView(v: View): void {
    view = clampView(v, bp.bounds, screen);
    schedule();
  }

  let anim = 0;
  function animateTo(target: View): void {
    cancelAnimationFrame(anim);
    const to = clampView(target, bp.bounds, screen);
    if (reduceMotion) { setView(to); return; }
    const from = view, t0 = performance.now(), dur = 240;
    const step = (t: number) => {
      const u = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - u, 3);
      // Zoom moves geometrically, so the motion looks even at every scale.
      view = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, z: from.z * Math.pow(to.z / from.z, e) };
      render();
      if (u < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function fit(): void {
    animateTo(fitBox(bp.bounds, screen));
  }

  const ro = new ResizeObserver(() => {
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const was = screen;
    screen = { w: r.width, h: r.height };
    if (!fitted) { fitted = true; view = clampView(fitBox(bp.bounds, screen), bp.bounds, screen); render(); return; }
    // Keep the zoom relative to the width, so rotating a phone keeps the same part of the room.
    setView({ ...view, z: was.w ? view.z * (screen.w / was.w) : view.z });
  });
  ro.observe(container);

  // ── Pointers: drag pans, two fingers pinch, a still tap picks ────────────────
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { kind: "pan" | "pinch" | "maybe"; x: number; y: number; view: View; dist?: number; mid?: { x: number; y: number } } | null = null;
  let suppressClick = false;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, local(e));
    cancelAnimationFrame(anim);
    if (pointers.size === 1) {
      gesture = { kind: "maybe", ...local(e), view };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", x: 0, y: 0, view, dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      suppressClick = true;
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, local(e));
    if (gesture.kind === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoomed = zoomAt(gesture.view, dist / (gesture.dist || dist), gesture.mid!.x, gesture.mid!.y, screen);
      setView(panBy(zoomed, mid.x - gesture.mid!.x, mid.y - gesture.mid!.y));
      return;
    }
    const at = local(e);
    if (gesture.kind === "maybe" && Math.hypot(at.x - gesture.x, at.y - gesture.y) > TAP_SLOP_PX) {
      gesture.kind = "pan";
      suppressClick = true;
      svg.setPointerCapture(e.pointerId);
    }
    if (gesture.kind === "pan") setView(panBy(gesture.view, at.x - gesture.x, at.y - gesture.y));
  });
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      gesture = null;
      // The click (if any) follows this event; let it through only after a still tap.
      setTimeout(() => { suppressClick = false; }, 0);
    } else if (pointers.size === 1 && gesture?.kind === "pinch") {
      const [rest] = [...pointers.values()];
      gesture = { kind: "pan", ...rest, view };
    }
  };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? screen.h : 1;
    const k = e.ctrlKey ? 0.01 : 0.0015; // a trackpad pinch arrives as ctrl+wheel
    const at = local(e);
    cancelAnimationFrame(anim);
    setView(zoomAt(view, Math.exp(-e.deltaY * unit * k), at.x, at.y, screen));
  }, { passive: false });

  // Clicks carry activation for mouse, touch AND assistive tech (detail 0 = not a pointer).
  svg.addEventListener("click", (e) => {
    if (suppressClick) return;
    const target = e.target as Element;
    const seat = target.closest?.(".seat[data-seat]");
    if (seat && seat.getAttribute("role") === "button") {
      const k = Number(seat.getAttribute("data-seat"));
      if (e.detail > 0 && seatTargetPx(view.z) < minTarget) {
        // Too small to be sure which seat a finger meant: bring it closer first.
        const pt = local(e as unknown as PointerEvent);
        animateTo(zoomAt(view, zoomForTarget(minTarget * 1.15) / view.z, pt.x, pt.y, screen));
        return;
      }
      if (seat.getAttribute("aria-disabled") !== "true") o.onSeat(k);
      return;
    }
    const block = target.closest?.(".wsm-block[data-section]");
    if (block) showSection(Number(block.getAttribute("data-section")));
  });

  // ── Keys ─────────────────────────────────────────────────────────────────────
  const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  svg.addEventListener("keydown", (e) => {
    const target = e.target as Element;
    const seat = target.closest?.(".seat[data-seat]");
    const block = target.closest?.(".wsm-block[data-section]");
    if ((e.key === "Enter" || e.key === " ") && (seat || block)) {
      e.preventDefault();
      if (seat && seat.getAttribute("aria-disabled") !== "true") o.onSeat(Number(seat.getAttribute("data-seat")));
      if (block) showSection(Number(block.getAttribute("data-section")));
      return;
    }
    // On the map itself, Enter goes to the seats (the tab stop, drawn and brought into view).
    if ((e.key === "Enter" || e.key === " ") && target === svg && stop >= 0) {
      e.preventDefault();
      focusSeat(stop);
      return;
    }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.4); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / 1.4); return; }
    if (e.key === "0") { e.preventDefault(); fit(); return; }
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    if (seat) {
      const next = neighbour(bp, Number(seat.getAttribute("data-seat")), dir);
      if (next !== null) focusSeat(next);
      return;
    }
    const step = 80;
    const d = { left: [step, 0], right: [-step, 0], up: [0, step], down: [0, -step] }[dir];
    setView(panBy(view, d[0], d[1]));
  });

  // Tabbing onto a seat off screen brings it into view.
  svg.addEventListener("focusin", (e) => {
    const seat = (e.target as Element).closest?.(".seat[data-seat]");
    if (!seat) return;
    const k = Number(seat.getAttribute("data-seat"));
    moveStop(k);
    const pt = bp.points[k];
    if (pt && !onScreen(view, screen, pt.x, pt.y)) animateTo({ ...view, cx: pt.x, cy: pt.y });
  });

  function focusSeat(k: number): void {
    const pt = bp.points[k];
    if (!pt) return;
    if (levelAt(view) === "sections" || !onScreen(view, screen, pt.x, pt.y)) {
      view = seatsLevel({ cx: pt.x, cy: pt.y, z: Math.max(view.z, zoomForTarget(minTarget)) });
      render();
    }
    (svg.querySelector(`.seat[data-seat="${k}"]`) as SVGElement | null)?.focus();
  }

  function zoomBy(factor: number): void {
    animateTo(zoomAt(view, factor, screen.w / 2, screen.h / 2, screen));
  }

  function showSection(si: number): void {
    const sec = bp.sections[si];
    if (!sec) return;
    const v = fitBox(sec.box, screen, 16);
    animateTo(seatsLevel({ ...v, z: Math.max(v.z, zoomForTarget(minTarget)) }));
  }

  return {
    set(next) {
      const active = document.activeElement;
      const focusedSeat = active && svg.contains(active) ? active.closest(".seat[data-seat]")?.getAttribute("data-seat") : null;
      state = next;
      if (stop < 0) {
        // First visit: Tab lands on the buyer's first pick, else the first seat they could pick.
        stop = next.picks[0] ?? -1;
        for (let k = 0; stop < 0 && k < bp.seats; k++) if (next.canPick(k)) stop = k;
        if (stop < 0 && bp.seats > 0) stop = 0;
      }
      for (const i of [...drawn.keys()]) drawSeatItem(i);
      if (level === "sections") drawBlocks();
      if (focusedSeat != null) seatEl(Number(focusedSeat))?.focus();
      schedule();
    },
    showSeats(seats) {
      const v = showPoints(view, seats.map((k) => bp.points[k]).filter(Boolean), screen, zoomForTarget(minTarget));
      if (v && (v !== view || levelAt(view) === "sections")) animateTo(seatsLevel(v));
    },
    showSection,
    fit,
    zoomBy,
    focusSeat,
    announce(text) {
      // Cleared first, so the same words twice are still read out.
      live.textContent = "";
      setTimeout(() => { live.textContent = text; }, 30);
    },
    destroy() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(anim);
      ro.disconnect();
      svg.remove();
      live.remove();
    },
  };
}

/** Behaviour the host page's CSS gives the map (hover, focus, cursors). Inject once per page. */
export function pickerCss(p: SeatmapPalette): string {
  return `
.wsm-map .seat.avail, .wsm-map .seat[aria-pressed="true"], .wsm-map .wsm-block { cursor: pointer; }
.wsm-map:active { cursor: grabbing; }
.wsm-map .seat.avail:hover .seat-shape { stroke: ${p.accent}; stroke-width: 2; }
.wsm-map .wsm-block:hover rect { stroke: ${p.accent}; }
.wsm-map .seat:focus, .wsm-map .wsm-block:focus { outline: none; }
.wsm-map .seat:focus-visible .seat-hit { stroke: ${p.accent}; stroke-width: 2; }
.wsm-map .wsm-block:focus-visible rect { stroke: ${p.accent}; stroke-width: 3; }
`;
}
