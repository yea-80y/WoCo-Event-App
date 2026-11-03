/**
 * The seating builder's engine: the plan being edited, selection, undo, zoom, and
 * every pointer and key gesture (prototype v3.1, docs/SEATING.md). The plan is drawn
 * imperatively with @woco/seatmap - thousands of seats redraw faster as SVG than as
 * reactive markup - and the Svelte component renders the panels around it, re-reading
 * this object whenever `onchange` fires.
 *
 * The layout here is a PLAIN object (never a Svelte proxy: those cannot be cloned).
 * Every write keeps it inside the format: whole numbers, rotations 0..359.
 */

import { drawDefs, drawItem, drawOrder, drawThumb, el, type SeatmapPalette } from "@woco/seatmap";
import { hasSeats, isGap, seatLists, type LayoutItem, type RowsItem, type SeatLayout, type TableItem } from "@woco/shared/seating/layout";
import { itemGeometry, itemWorldBox, toLocal, unionBox, SEAT_PITCH, type Box } from "@woco/shared/seating/geometry";
import { normRot } from "@woco/shared/seating/templates";
import {
  addBand, applyBrush, cloneItem, describe, keepInRoom, lineUp, longestRow, makeItem, resizeRows, rotateItems,
  seatsInRect, setRowCount, setTableSeats, spread, intersects, type AddKind, type Brush,
} from "./edit.js";

export type Step = "layout" | "seats";

type Drag =
  | { type: "tap"; x: number; y: number }
  | { type: "box" | "pbox"; start: Pt; cur: Pt; add?: boolean }
  | { type: "paint"; done: Set<string> }
  | { type: "move"; start: Pt; ids: string[]; primary: string; alt: boolean; moved: boolean; orig: Record<string, Pt>; gb?: Box; others?: Box[] }
  | { type: "handle"; kind: string; id: string; start: Pt; orig: LayoutItem; moved: boolean };
type Pt = { x: number; y: number };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
const MAX_UNDO = 100;

export interface BuilderEls {
  svg: SVGSVGElement;
  canvas: HTMLElement;
  shell: HTMLElement;
  ctx: HTMLElement;
  bubble: HTMLElement;
}

export class BuilderController {
  plan: SeatLayout;
  step: Step = "layout";
  sel: string[] = [];
  brush: Brush;
  zoom = 1;
  undoStack: string[] = [];
  redoStack: string[] = [];
  /** Called after every change the panels may show. */
  onchange: () => void = () => {};
  /** A short message for the organiser ("Deleted Table 3. Ctrl+Z brings it back."). */
  ontoast: (msg: string) => void = () => {};

  private els: BuilderEls | null = null;
  private drag: Drag | null = null;
  private guides: Record<string, number>[] = [];
  private dup: { srcIds: string[]; newIds: string[]; offset: Pt | null } | null = null;
  private raf = 0;
  private lastNudge = 0;
  private palette: SeatmapPalette;
  private paletteDrag: { kind: AddKind; x0: number; y0: number; moved: boolean; over: boolean; ghost: HTMLElement | null; w: number; h: number } | null = null;
  /** A drag from a tile that ended away from it is not also a tap. */
  swallowClick = false;
  private editSnap = false;
  readonly mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";
  readonly touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

  constructor(plan: SeatLayout, palette: SeatmapPalette) {
    this.plan = plan;
    this.palette = palette;
    this.brush = { band: plan.bands[0].id };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach(els: BuilderEls): () => void {
    this.els = els;
    const down = (e: PointerEvent) => this.onDown(e);
    const move = (e: PointerEvent) => this.onMove(e);
    const up = (e: PointerEvent) => this.onUp(e);
    const key = (e: KeyboardEvent) => this.onKey(e);
    const scroll = () => this.placeCtx();
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // a trackpad pinch arrives as ctrl + wheel
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX, y: e.clientY });
    };
    const resize = () => this.placeCtx();
    els.svg.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", resize);
    els.canvas.addEventListener("scroll", scroll, { passive: true });
    els.canvas.addEventListener("wheel", wheel, { passive: false });
    this.fit();
    return () => {
      els.svg.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", resize);
      els.canvas.removeEventListener("scroll", scroll);
      els.canvas.removeEventListener("wheel", wheel);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.paletteDrag?.ghost?.remove();
      this.els = null;
    };
  }

  // ── Queries the panels use ────────────────────────────────────────────────

  itemOf(id: string): LayoutItem | undefined {
    return this.plan.items.find((it) => it.id === id);
  }
  selItems(): LayoutItem[] {
    return this.sel.map((id) => this.itemOf(id)).filter((x): x is LayoutItem => !!x);
  }
  get dragging(): boolean {
    return !!this.drag && "moved" in this.drag && this.drag.moved;
  }
  /** The band every seat of these items has, or "" when mixed. */
  bandOfItems(items: LayoutItem[]): string {
    const used = new Set<string>();
    for (const it of items) for (const l of seatLists(it)) for (const s of l) if (!isGap(s)) used.add(s.b);
    return used.size === 1 ? [...used][0] : "";
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  snapshot(): void {
    this.undoStack.push(JSON.stringify(this.plan));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }
  private restore(from: string[], to: string[]): void {
    const prev = from.pop();
    if (prev === undefined) return;
    to.push(JSON.stringify(this.plan));
    this.plan = JSON.parse(prev) as SeatLayout;
    this.sel = this.sel.filter((id) => this.itemOf(id));
    if (typeof this.brush === "object" && !this.plan.bands.some((b) => b.id === (this.brush as { band: string }).band)) {
      this.brush = { band: this.plan.bands[0].id };
    }
    this.render();
  }
  undo(): void { this.restore(this.undoStack, this.redoStack); }
  redo(): void { this.restore(this.redoStack, this.undoStack); }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private worldSize(): { w: number; h: number } {
    const cb = unionBox(this.plan.items);
    return { w: Math.max(1300, cb.x1 + 400), h: Math.max(900, cb.y1 + 400) };
  }
  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render({ ctx: false }); });
  }

  render({ ctx = true }: { ctx?: boolean } = {}): void {
    const els = this.els;
    if (!els) return;
    const svg = els.svg;
    const a = document.activeElement;
    const focusId = a instanceof Element && a.closest(".it") && svg.contains(a) ? a.closest(".it")!.getAttribute("data-id") : null;
    svg.replaceChildren();
    const W = this.worldSize();
    svg.setAttribute("viewBox", `0 0 ${W.w} ${W.h}`);
    svg.setAttribute("width", String(Math.round(W.w * this.zoom)));
    svg.setAttribute("height", String(Math.round(W.h * this.zoom)));
    const mode = this.step === "layout" ? "layout" : "seats";
    svg.setAttribute("class", `mode-${mode}`);
    drawDefs(svg, this.palette);
    const d = this.drag;
    const handlesOn = mode === "layout" && this.sel.length === 1 && (!d || d.type === "handle");
    for (const i of drawOrder(this.plan.items)) {
      const it = this.plan.items[i];
      const selected = mode === "layout" && this.sel.includes(it.id);
      drawItem(svg, it, {
        mode, svgId: svg.id, palette: this.palette, bands: this.plan.bands, itemIndex: i, selected,
        describe: describe(it), ...(handlesOn && selected ? { handles: { zoom: this.zoom } } : {}),
      });
    }
    for (const gd of this.guides) el("line", { class: "guide", ...gd, stroke: this.palette.accent, "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke", "pointer-events": "none" }, svg);
    if (d && (d.type === "box" || d.type === "pbox")) {
      const r = rectOf(d.start, d.cur);
      el("rect", { class: "boxsel", x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, fill: this.palette.accent, "fill-opacity": 0.07, stroke: this.palette.accent, "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke", "pointer-events": "none" }, svg);
    }
    if (focusId) (svg.querySelector(`.it[data-id="${focusId}"]`) as SVGGElement | null)?.focus({ preventScroll: true });
    if (!ctx) this.placeCtx();
    this.onchange();
    if (ctx) queueMicrotask(() => this.placeCtx());
  }

  /** Put the selection bar next to the selection, clear of the turn handle. */
  placeCtx(): void {
    const els = this.els;
    if (!els) return;
    const ctx = els.ctx;
    if (ctx.hidden) return;
    if (matchMedia("(max-width: 760px)").matches) { ctx.style.left = ""; ctx.style.top = ""; return; }
    const items = this.selItems();
    const m = els.svg.getScreenCTM();
    if (!items.length || !m) return;
    const wb = unionBox(items);
    const sr = els.shell.getBoundingClientRect();
    const p0 = new DOMPoint(wb.x0, wb.y0).matrixTransform(m), p1 = new DOMPoint(wb.x1, wb.y1).matrixTransform(m);
    const cw = ctx.offsetWidth, ch = ctx.offsetHeight;
    const left = clamp((p0.x + p1.x) / 2 - sr.left - cw / 2, 8, Math.max(8, sr.width - cw - 8));
    let top = p0.y - sr.top - ch - 34;
    if (top < 8) top = p1.y - sr.top + 34;
    if (top + ch > sr.height - 8) top = 8;
    ctx.style.left = `${left}px`;
    ctx.style.top = `${top}px`;
  }

  // ── Coordinates, zoom, scrolling ──────────────────────────────────────────

  private worldAt(cx: number, cy: number): Pt {
    const m = this.els!.svg.getScreenCTM()!.inverse();
    const p = new DOMPoint(cx, cy).matrixTransform(m);
    return { x: p.x, y: p.y };
  }
  private screenOf(wx: number, wy: number): Pt {
    const p = new DOMPoint(wx, wy).matrixTransform(this.els!.svg.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }
  visibleCentre(): Pt {
    const c = this.els!.canvas, r = c.getBoundingClientRect();
    return this.worldAt(r.left + c.clientWidth / 2, r.top + c.clientHeight / 2);
  }
  private centreOn(wx: number, wy: number): void {
    const c = this.els!.canvas, r = c.getBoundingClientRect(), p = this.screenOf(wx, wy);
    c.scrollLeft += p.x - (r.left + c.clientWidth / 2);
    c.scrollTop += p.y - (r.top + c.clientHeight / 2);
    this.placeCtx();
  }
  fit(): void {
    const c = this.els?.canvas;
    if (!c || !c.clientWidth) { this.render(); return; }
    const cb = unionBox(this.plan.items);
    this.zoom = clamp(Math.min((c.clientWidth - 90) / (cb.x1 - cb.x0), (c.clientHeight - 90) / (cb.y1 - cb.y0)), 0.3, 1.5);
    this.render();
    this.centreOn((cb.x0 + cb.x1) / 2, (cb.y0 + cb.y1) / 2);
  }
  zoomBy(f: number, at?: Pt): void {
    const c = this.els!.canvas, r = c.getBoundingClientRect();
    const cx = at ? at.x : r.left + c.clientWidth / 2, cy = at ? at.y : r.top + c.clientHeight / 2;
    const w = this.worldAt(cx, cy);
    this.zoom = clamp(this.zoom * f, 0.3, 3);
    this.render();
    const p = this.screenOf(w.x, w.y);
    c.scrollLeft += p.x - cx;
    c.scrollTop += p.y - cy;
    this.placeCtx();
  }
  private revealSelection(): void {
    this.render();
    const items = this.selItems();
    if (!items.length || !this.els) return;
    const c = this.els.canvas, r = c.getBoundingClientRect(), wb = unionBox(items);
    const p0 = this.screenOf(wb.x0, wb.y0), p1 = this.screenOf(wb.x1, wb.y1);
    if (p0.x < r.left || p0.y < r.top || p1.x > r.left + c.clientWidth || p1.y > r.top + c.clientHeight) {
      this.centreOn((wb.x0 + wb.x1) / 2, (wb.y0 + wb.y1) / 2);
    }
  }

  // ── Steps and brushes ─────────────────────────────────────────────────────

  setStep(step: Step): void {
    if (this.step === step) return;
    this.step = step;
    this.drag = null;
    this.guides = [];
    this.render();
  }
  setBrush(b: Brush): void {
    this.brush = b;
    this.onchange();
  }
  addPriceBand(): string | null {
    this.snapshot();
    const id = addBand(this.plan);
    if (id) this.brush = { band: id };
    this.render();
    return id;
  }
  renameBand(id: string, name: string): void {
    const b = this.plan.bands.find((x) => x.id === id);
    if (!b || !name.trim() || b.name === name) return;
    this.snapshot();
    b.name = name.trim().slice(0, 60);
    this.onchange();
  }

  // ── Adding, copying, removing ─────────────────────────────────────────────

  private overlapsAny(it: LayoutItem): boolean {
    const a = itemWorldBox(it);
    return this.plan.items.some((o) => o !== it && intersects(a, itemWorldBox(o)));
  }
  addItem(kind: AddKind, at: Pt, findSpace: boolean): void {
    this.snapshot();
    const it = makeItem(this.plan, kind, Math.round(at.x), Math.round(at.y));
    const wb = itemWorldBox(it);
    it.x = Math.round(it.x + at.x - (wb.x0 + wb.x1) / 2);
    it.y = Math.round(it.y + at.y - (wb.y0 + wb.y1) / 2);
    if (findSpace) for (let k = 0; k < 40 && this.overlapsAny(it); k++) it.y += 24;
    keepInRoom([it]);
    this.plan.items.push(it);
    this.sel = [it.id];
    this.dup = null;
    if (findSpace) this.revealSelection(); else this.render();
    if (matchMedia("(max-width: 760px)").matches) this.els?.shell.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  addAtCentre(kind: AddKind): void {
    this.addItem(kind, this.visibleCentre(), true);
  }
  /** A copy beside the original; after a copy is moved, the next copy repeats that move. */
  duplicateSel(): void {
    const items = this.selItems();
    if (!items.length) return;
    this.snapshot();
    let off: Pt;
    if (this.dup?.offset && this.dup.newIds.join() === this.sel.join()) off = this.dup.offset;
    else {
      const gb = unionBox(items);
      if (items.every((it) => it.kind === "table")) off = { x: gb.x1 - gb.x0 + 14, y: 0 };
      else if (items.every((it) => it.kind === "rows")) off = { x: 0, y: gb.y1 - gb.y0 + 20 };
      else off = { x: 30, y: 30 };
    }
    const made = items.map((it) => {
      const c = cloneItem(this.plan, it, off);
      this.plan.items.push(c);
      return c;
    });
    keepInRoom(made);
    this.dup = { srcIds: items.map((it) => it.id), newIds: made.map((m) => m.id), offset: off };
    this.sel = made.map((m) => m.id);
    this.revealSelection();
  }
  deleteSel(): void {
    const items = this.selItems();
    if (!items.length) return;
    this.snapshot();
    this.plan.items = this.plan.items.filter((it) => !this.sel.includes(it.id));
    this.sel = [];
    const what = items.length === 1 ? describe(items[0]).split(",")[0] : `${items.length} things`;
    this.ontoast(`Deleted ${what}. ${this.mod}+Z brings it back.`);
    this.render();
  }
  changeSeats(delta: number): void {
    const items = this.selItems().filter(hasSeats) as (RowsItem | TableItem)[];
    if (!items.length) return;
    this.snapshot();
    const fb = this.plan.bands[0].id;
    for (const it of items) {
      if (it.kind === "table") setTableSeats(it, it.seats.length + delta, fb);
      else resizeRows(it, structuredClone(it.rows), delta, fb);
    }
    this.render();
  }
  changeRows(delta: number): void {
    const it = this.selItems()[0];
    if (!it || it.kind !== "rows") return;
    this.snapshot();
    setRowCount(it, it.rows, it.rows.length + delta);
    this.render();
  }
  setShape(shape: TableItem["shape"]): void {
    this.snapshot();
    for (const it of this.selItems()) {
      if (it.kind === "table") { it.shape = shape; setTableSeats(it, it.seats.length, this.plan.bands[0].id); }
    }
    this.render();
  }
  setItemsBand(bandId: string): void {
    this.snapshot();
    for (const it of this.selItems()) {
      for (const l of seatLists(it)) l.forEach((s, i) => { if (!isGap(s)) l[i] = { ...s, b: bandId }; });
    }
    this.render();
  }
  setNumberFrom(v: "left" | "right"): void {
    this.snapshot();
    for (const it of this.selItems()) if (it.kind === "rows") it.numberFrom = v;
    this.render();
  }
  /** 1 = consecutive; 2 = odd or even (with numbers starting at 1 or 2). */
  setNumberStep(step: 1 | 2): void {
    this.snapshot();
    for (const it of this.selItems()) {
      if (it.kind !== "rows") continue;
      if (step === 2) it.numberStep = 2; else delete it.numberStep;
    }
    this.render();
  }
  setNumberStart(n: number): void {
    const it = this.selItems()[0];
    if (!it || (it.kind !== "rows" && it.kind !== "table")) return;
    this.snapshot();
    const v = clamp(Math.round(n), 1, 100_000);
    if (v === 1) delete it.numberStart; else it.numberStart = v;
    this.render();
  }
  /** Typing in the bar: one undo step per field visit. */
  editText(field: "name" | "text" | "curve", value: string): void {
    const it = this.selItems()[0];
    if (!it) return;
    if (!this.editSnap) { this.snapshot(); this.editSnap = true; }
    if (field === "name" && "name" in it) it.name = value.slice(0, 80);
    if (field === "text" && "text" in it) {
      it.text = value.slice(0, 80);
      if (it.kind === "label") it.w = Math.max(48, Math.round(value.length * 7.6 + 18));
    }
    if (field === "curve" && it.kind === "rows") it.curve = clamp(Math.round(Number(value)), 0, 100);
    this.render({ ctx: false });
  }
  endEdit(): void { this.editSnap = false; }
  lineUpSel(): void { this.snapshot(); lineUp(this.selItems()); this.render(); }
  spreadSel(): void { this.snapshot(); spread(this.selItems()); this.render(); }
  rotateSel(deg: number): void { this.snapshot(); rotateItems(this.selItems(), deg); this.render(); }
  replacePlan(next: SeatLayout): void {
    this.snapshot();
    this.plan = { ...next, name: this.plan.name };
    this.sel = [];
    this.brush = { band: this.plan.bands[0].id };
    this.dup = null;
    this.fit();
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  private paintKey(k: string): void {
    const [i, r, p] = k.split(":").map(Number);
    const it = this.plan.items[i];
    if (!it) return;
    const list = seatLists(it)[r];
    if (!list) return;
    applyBrush(list, p, this.brush, this.plan.bands[0].id);
  }
  private paintList(itemIndex: number, row: number): void {
    const it = this.plan.items[itemIndex];
    const list = it && seatLists(it)[row];
    if (!list) return;
    for (let p = 0; p < list.length; p++) applyBrush(list, p, this.brush, this.plan.bands[0].id);
  }

  // ── Pointer input ─────────────────────────────────────────────────────────

  private onDown(e: PointerEvent): void {
    if (e.button > 0) return;
    const w = this.worldAt(e.clientX, e.clientY);
    const t = e.target as Element;
    if (this.step === "seats") return this.paintDown(e, t, w);
    const h = t.closest("[data-handle]");
    const itEl = t.closest(".it");
    if (h && itEl) {
      const it = this.itemOf(itEl.getAttribute("data-id")!);
      if (!it) return;
      this.drag = { type: "handle", kind: h.getAttribute("data-handle")!, id: it.id, start: w, orig: structuredClone(it), moved: false };
      e.preventDefault();
      return;
    }
    if (itEl) {
      const id = itEl.getAttribute("data-id")!;
      e.preventDefault();
      if (e.shiftKey) {
        this.sel = this.sel.includes(id) ? this.sel.filter((x) => x !== id) : [...this.sel, id];
        this.render();
        return;
      }
      if (!this.sel.includes(id)) this.sel = [id];
      this.drag = {
        type: "move", start: w, ids: [...this.sel], primary: id, alt: e.altKey, moved: false,
        orig: Object.fromEntries(this.selItems().map((it) => [it.id, { x: it.x, y: it.y }])),
      };
      this.render();
      return;
    }
    if (e.pointerType === "mouse") { this.drag = { type: "box", start: w, cur: w, add: e.shiftKey }; e.preventDefault(); }
    else this.drag = { type: "tap", x: e.clientX, y: e.clientY };
  }

  private paintDown(e: PointerEvent, t: Element, w: Pt): void {
    const sk = t.closest(".seat[data-key]");
    const rl = t.closest("[data-rowlab]");
    const tt = t.closest("[data-tabletop]");
    if (sk) {
      this.snapshot();
      const k = sk.getAttribute("data-key")!;
      this.drag = { type: "paint", done: new Set([k]) };
      this.paintKey(k);
    } else if (rl || tt) {
      this.snapshot();
      const [i, r] = rl ? rl.getAttribute("data-rowlab")!.split(":").map(Number) : [Number(tt!.getAttribute("data-tabletop")), 0];
      this.paintList(i, r);
      this.drag = { type: "paint", done: new Set() };
    } else if (e.pointerType === "mouse") {
      this.drag = { type: "pbox", start: w, cur: w };
    } else return; // a finger on the empty floor scrolls the plan
    e.preventDefault();
    this.schedule();
  }

  private seatKeyAt(e: PointerEvent): string | null {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const g = t?.closest(".seat[data-key]");
    return g && this.els?.svg.contains(g) ? g.getAttribute("data-key") : null;
  }

  private onMove(e: PointerEvent): void {
    if (this.paletteDrag) return this.movePalette(e);
    const d = this.drag;
    if (!d || !this.els) return;
    if (d.type === "tap") { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) this.drag = null; return; }
    const w = this.worldAt(e.clientX, e.clientY);
    if (d.type === "paint") {
      const k = this.seatKeyAt(e);
      if (k && !d.done.has(k)) { d.done.add(k); this.paintKey(k); this.schedule(); }
      return;
    }
    if (d.type === "box" || d.type === "pbox") { d.cur = w; this.schedule(); return; }
    if (d.type === "move") return this.moveDrag(d, w);
    if (d.type === "handle") return this.handleDrag(d, w, e);
  }

  private moveDrag(d: Extract<Drag, { type: "move" }>, w: Pt): void {
    let dx = w.x - d.start.x, dy = w.y - d.start.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) * this.zoom < 4) return;
      this.snapshot();
      d.moved = true;
      this.els!.ctx.hidden = true;
      if (d.alt) {
        // Alt-drag: the copies move and the originals stay put.
        const made = d.ids.map((id) => {
          const c = cloneItem(this.plan, this.itemOf(id)!, { x: 0, y: 0 });
          this.plan.items.push(c);
          return c;
        });
        this.dup = { srcIds: [...d.ids], newIds: made.map((m) => m.id), offset: null };
        d.primary = made[d.ids.indexOf(d.primary)].id;
        d.ids = made.map((m) => m.id);
        d.orig = Object.fromEntries(made.map((m) => [m.id, { x: m.x, y: m.y }]));
        this.sel = [...d.ids];
      }
      d.gb = unionBox(d.ids.map((id) => this.itemOf(id)!));
      d.others = this.plan.items.filter((it) => !d.ids.includes(it.id)).map((it) => itemWorldBox(it));
    }
    const s = this.snap(d, dx, dy);
    dx = Math.max(s.dx, 10 - d.gb!.x0);
    dy = Math.max(s.dy, 10 - d.gb!.y0);
    for (const id of d.ids) {
      const it = this.itemOf(id)!;
      it.x = Math.round(d.orig[id].x + dx);
      it.y = Math.round(d.orig[id].y + dy);
    }
    this.guides = s.guides;
    this.schedule();
  }

  /** Line the grabbed thing up with the edges and middles of everything else, and show the line. */
  private snap(d: Extract<Drag, { type: "move" }>, dx: number, dy: number): { dx: number; dy: number; guides: Record<string, number>[] } {
    const o = d.orig[d.primary], p = this.itemOf(d.primary)!;
    const mb = itemWorldBox({ ...p, x: o.x + dx, y: o.y + dy } as LayoutItem);
    const tol = 7 / this.zoom;
    const mxs = [mb.x0, (mb.x0 + mb.x1) / 2, mb.x1], mys = [mb.y0, (mb.y0 + mb.y1) / 2, mb.y1];
    type Hit = { d: number; at: number; ob: Box } | null;
    let bx: Hit = null;
    let by: Hit = null;
    for (const ob of d.others ?? []) {
      const oxs = [ob.x0, (ob.x0 + ob.x1) / 2, ob.x1], oys = [ob.y0, (ob.y0 + ob.y1) / 2, ob.y1];
      for (const a of mxs) for (const t of oxs) { const dd = t - a; if (Math.abs(dd) <= tol && (!bx || Math.abs(dd) < Math.abs(bx.d))) bx = { d: dd, at: t, ob }; }
      for (const a of mys) for (const t of oys) { const dd = t - a; if (Math.abs(dd) <= tol && (!by || Math.abs(dd) < Math.abs(by.d))) by = { d: dd, at: t, ob }; }
    }
    const guides: Record<string, number>[] = [];
    if (bx) { dx += bx.d; guides.push({ x1: bx.at, x2: bx.at, y1: Math.min(mb.y0, bx.ob.y0) - 16, y2: Math.max(mb.y1, bx.ob.y1) + 16 }); }
    if (by) { dy += by.d; guides.push({ y1: by.at, y2: by.at, x1: Math.min(mb.x0, by.ob.x0) - 16, x2: Math.max(mb.x1, by.ob.x1) + 16 }); }
    return { dx, dy, guides };
  }

  private handleDrag(d: Extract<Drag, { type: "handle" }>, w: Pt, e: PointerEvent): void {
    const it = this.itemOf(d.id);
    if (!it) return;
    const o = d.orig;
    if (!d.moved) {
      if (Math.hypot(w.x - d.start.x, w.y - d.start.y) * this.zoom < 3) return;
      this.snapshot();
      d.moved = true;
      this.els!.ctx.hidden = true;
    }
    const L = toLocal(o, w.x, w.y), S = toLocal(o, d.start.x, d.start.y);
    const fb = this.plan.bands[0].id;
    let msg = "";
    if (d.kind === "seats" && it.kind === "rows" && o.kind === "rows") {
      resizeRows(it, o.rows, Math.round(((L.x - S.x) * 2) / SEAT_PITCH), fb);
      msg = `${longestRow(it)} seats per row`;
    } else if (d.kind === "rows" && it.kind === "rows" && o.kind === "rows") {
      setRowCount(it, o.rows, o.rows.length + Math.round((L.y - S.y) / SEAT_PITCH));
      msg = `${it.rows.length} rows`;
    } else if (d.kind === "tseats" && it.kind === "table" && o.kind === "table") {
      const delta = o.shape === "round"
        ? Math.round((Math.hypot(L.x, L.y) - Math.hypot(S.x, S.y)) / 7)
        : Math.round((L.x - S.x) / (SEAT_PITCH / 2)) * (o.shape === "long" ? 2 : 1);
      it.seats = structuredClone(o.seats);
      setTableSeats(it, o.seats.length + delta, fb);
      msg = `${it.seats.length} seats`;
    } else if (d.kind === "rotate") {
      const a = Math.round(((Math.atan2(w.y - it.y, w.x - it.x) * 180) / Math.PI + 90) / 5) * 5;
      it.rot = normRot(a);
      msg = `${it.rot}°`;
    } else if (d.kind === "resize" && "w" in it) {
      it.w = clamp(Math.round((Math.abs(L.x) * 2) / 10) * 10, 40, 1600);
      it.h = clamp(Math.round((Math.abs(L.y) * 2) / 10) * 10, 24, 1200);
    }
    this.bubble(e, msg);
    this.schedule();
  }

  private onUp(e: PointerEvent): void {
    if (this.paletteDrag) return this.endPalette(e);
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.guides = [];
    this.bubble(null, "");
    if (d.type === "tap") this.sel = [];
    else if (d.type === "box") {
      const r = rectOf(d.start, d.cur);
      if ((r.x1 - r.x0) * this.zoom > 4 || (r.y1 - r.y0) * this.zoom > 4) {
        const hit = this.plan.items.filter((it) => intersects(itemWorldBox(it), r)).map((it) => it.id);
        this.sel = d.add ? [...new Set([...this.sel, ...hit])] : hit;
      } else if (!d.add) this.sel = [];
    } else if (d.type === "pbox") {
      const refs = seatsInRect(this.plan.items, rectOf(d.start, d.cur));
      if (refs.length) {
        this.snapshot();
        for (const [i, r, p] of refs) this.paintKey(`${i}:${r}:${p}`);
      }
    } else if (d.type === "move" && d.moved && this.dup && this.dup.newIds.join() === d.ids.join()) {
      const src = this.itemOf(this.dup.srcIds[0]), nw = this.itemOf(this.dup.newIds[0]);
      if (src && nw) this.dup.offset = { x: nw.x - src.x, y: nw.y - src.y };
    } else if (d.type === "handle" && !d.moved && d.kind === "tseats") {
      const it = this.itemOf(d.id);
      if (it?.kind === "table") {
        this.snapshot();
        setTableSeats(it, it.seats.length + 1, this.plan.bands[0].id); // a tap on the handle adds one seat
      }
    }
    if (this.els) this.els.ctx.hidden = false;
    this.render();
  }

  private bubble(e: PointerEvent | null, msg: string): void {
    const b = this.els?.bubble;
    if (!b) return;
    if (!e || !msg) { b.style.display = "none"; return; }
    b.textContent = msg;
    b.style.display = "block";
    b.style.left = `${e.clientX + 16}px`;
    b.style.top = `${e.clientY + 14}px`;
  }

  // ── Dragging things in from the rail ─────────────────────────────────────

  tileDown(kind: AddKind, e: PointerEvent): void {
    if (e.button > 0) return;
    this.swallowClick = false;
    this.paletteDrag = { kind, x0: e.clientX, y0: e.clientY, moved: false, over: false, ghost: null, w: 0, h: 0 };
  }
  private movePalette(e: PointerEvent): void {
    const p = this.paletteDrag!;
    if (!p.moved) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6) return;
      p.moved = true;
      const tmp = makeItem(this.plan, p.kind, 0, 0);
      const box = itemGeometry(tmp).box, pad = 6;
      p.w = (box.x1 - box.x0 + pad * 2) * this.zoom;
      p.h = (box.y1 - box.y0 + pad * 2) * this.zoom;
      const ghost = document.createElement("div");
      ghost.className = "seat-drag-preview";
      ghost.style.cssText = "position:fixed;z-index:60;pointer-events:none;opacity:.85";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "seat-ghost-svg";
      svg.setAttribute("width", String(p.w));
      svg.setAttribute("height", String(p.h));
      ghost.appendChild(svg);
      document.body.appendChild(ghost);
      drawThumb(svg, { bands: this.plan.bands, items: [tmp] }, this.palette, pad);
      p.ghost = ghost;
    }
    p.ghost!.style.left = `${e.clientX - p.w / 2}px`;
    p.ghost!.style.top = `${e.clientY - p.h / 2}px`;
    const r = this.els!.canvas.getBoundingClientRect();
    p.over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    this.els!.canvas.classList.toggle("drop", p.over);
  }
  private endPalette(e: PointerEvent): void {
    const p = this.paletteDrag!;
    this.paletteDrag = null;
    this.els?.canvas.classList.remove("drop");
    p.ghost?.remove();
    if (!p.moved) return; // a tap: the click adds it in the middle
    this.swallowClick = true;
    if (e.type === "pointerup" && p.over) this.addItem(p.kind, this.worldAt(e.clientX, e.clientY), false);
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (!this.els || document.querySelector(".seat-dialog-open")) return;
    const t = e.target as Element | null;
    const typing = !!t && t.matches?.("input, select, textarea");
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === "z" && !typing) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && k === "y" && !typing) { e.preventDefault(); this.redo(); return; }
    if (typing) return;
    if (this.step === "seats") {
      if (mod) return;
      if (k === "h") this.setBrush("held");
      else if (k === "w") this.setBrush("wheel");
      else if (k === "c") this.setBrush("companion");
      else if (k === "n") this.setBrush("gap");
      else if (/^[1-8]$/.test(k) && this.plan.bands[Number(k) - 1]) this.setBrush({ band: this.plan.bands[Number(k) - 1].id });
      return;
    }
    if (e.key === "Escape") { this.sel = []; this.render(); return; }
    if (mod && k === "a") { e.preventDefault(); this.sel = this.plan.items.map((it) => it.id); this.render(); return; }
    const onItem = t?.closest?.(".it");
    if ((e.key === "Enter" || e.key === " ") && onItem && this.els.svg.contains(onItem)) {
      e.preventDefault();
      const id = onItem.getAttribute("data-id")!;
      this.sel = e.shiftKey ? (this.sel.includes(id) ? this.sel.filter((x) => x !== id) : [...this.sel, id]) : [id];
      this.render();
      return;
    }
    if (!this.sel.length) return;
    if (mod && k === "d") { e.preventDefault(); this.duplicateSel(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.deleteSel(); return; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      if (Date.now() - this.lastNudge > 700) this.snapshot();
      this.lastNudge = Date.now();
      const step = e.shiftKey ? 10 : 2, [ax, ay] = arrows[e.key];
      for (const it of this.selItems()) { it.x += ax * step; it.y += ay * step; }
      keepInRoom(this.selItems());
      this.render();
      return;
    }
    if (e.key === "+" || e.key === "=") { this.changeSeats(1); return; }
    if (e.key === "-" || e.key === "_") { this.changeSeats(-1); return; }
    if (e.key === "[" || e.key === "]") this.rotateSel(e.key === "]" ? 15 : -15);
  }
}

function rectOf(a: Pt, b: Pt): Box {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}
