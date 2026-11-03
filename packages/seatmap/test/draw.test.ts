import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, fakeSvg, type FakeEl } from "./fake-dom.js";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { canonicalSeats } from "@woco/shared/seating/plan";
import { seatRuns } from "@woco/shared/seating/best";
import { APP_PALETTE, bandStyle, type SeatmapPalette } from "../src/palette.js";
import { drawDefs, drawItem, drawOrder, drawThumb, swatchSvg } from "../src/draw.js";

installFakeDom();

const seatShapes = (svg: FakeEl) => [...svg.all()].filter((e) => e.getAttribute("class") === "seat-shape");

test("a thumbnail draws one seat per seat of every starting layout, with finite coordinates", () => {
  for (const t of LAYOUT_TEMPLATES) {
    const l = t.make();
    const svg = fakeSvg(`tpl-${t.id}`);
    drawThumb(svg, l, APP_PALETTE);
    assert.equal(seatShapes(svg).length, canonicalSeats(l).length, t.id);
    for (const e of svg.all()) {
      for (const [k, v] of e.attrs) {
        if (["x", "y", "cx", "cy", "r", "width", "height"].includes(k)) assert.ok(Number.isFinite(Number(v)), `${t.id} ${k}=${v}`);
        assert.ok(!/NaN|undefined/.test(v), `${t.id} ${k}=${v}`);
      }
    }
  }
});

test("every colour comes from the palette", () => {
  const p: SeatmapPalette = {
    bg: "#000001", surface: "#000002", elevated: "#000003", line: "#000004", lineStrong: "#000005", text: "#000006",
    text2: "#000007", muted: "#000008", dim: "#000009", accent: "#00000a", accentInk: "#00000b", fontUi: "UiFont", fontMono: "MonoFont",
  };
  const allowed = new Set([...Object.values(p), "none", "transparent"]);
  const l = LAYOUT_TEMPLATES.find((t) => t.id === "stadium")!.make();
  const svg = fakeSvg("pal");
  drawDefs(svg, p);
  l.items.forEach((it, i) => drawItem(svg, it, { mode: "seats", svgId: "pal", palette: p, bands: l.bands, itemIndex: i }));
  for (const e of svg.all()) {
    for (const k of ["fill", "stroke"]) {
      const v = e.getAttribute(k);
      if (v === null || v.startsWith("url(#pal-")) continue;
      assert.ok(allowed.has(v), `${e.tagName} ${k}=${v}`);
    }
    const f = e.getAttribute("font-family");
    if (f !== null) assert.ok(f === "UiFont" || f === "MonoFont", f);
  }
});

test("paint mode addresses seats as item:row:pos and rows by their letter", () => {
  const l = LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make();
  const svg = fakeSvg("p");
  drawItem(svg, l.items[1], { mode: "seats", svgId: "p", palette: APP_PALETTE, bands: l.bands, itemIndex: 1 });
  const keys = [...svg.all()].map((e) => e.getAttribute("data-key")).filter(Boolean);
  assert.ok(keys.includes("1:0:0") && keys.includes("1:11:22"), "row 12 of 22 seats with an aisle has positions 0..22");
  assert.ok([...svg.all()].some((e) => e.getAttribute("data-rowlab") === "1:0"));
});

test("buyer mode: free seats are buttons with a spoken label; taken seats are not; a pick is the accent", () => {
  const l = LAYOUT_TEMPLATES.find((t) => t.id === "comedy")!.make();
  const runs = seatRuns(l.items);
  const seatAt = (item: number, row: number, pos: number) => runs.find((r) => r.item === item && r.row === row)?.seats[pos] ?? -1;
  const svg = fakeSvg("b");
  drawDefs(svg, APP_PALETTE);
  for (const i of drawOrder(l.items)) {
    drawItem(svg, l.items[i], {
      mode: "buy", svgId: "b", palette: APP_PALETTE, bands: l.bands, itemIndex: i,
      buyer: { seatAt, free: (k) => k % 2 === 0, picked: (k) => k === 4, label: (k) => `Seat ${k}`, number: (k) => k + 1, locked: false },
    });
  }
  const seats = [...svg.all()].filter((e) => e.getAttribute("data-seat") !== null);
  assert.equal(seats.length, canonicalSeats(l).length);
  for (const s of seats) {
    const k = Number(s.getAttribute("data-seat"));
    const button = s.getAttribute("role") === "button";
    assert.equal(button, k % 2 === 0, `seat ${k}`);
    if (button) assert.equal(s.getAttribute("aria-label"), `Seat ${k}`);
  }
  const picked = seats.find((s) => s.getAttribute("data-seat") === "4")!;
  assert.equal(picked.getAttribute("aria-pressed"), "true");
  assert.ok([...picked.all()].some((e) => e.getAttribute("fill") === APP_PALETTE.accent));
});

test("drawing order: floors and pitches under seats, labels on top", () => {
  const l = LAYOUT_TEMPLATES.find((t) => t.id === "stadium")!.make();
  const order = drawOrder(l.items).map((i) => l.items[i].kind);
  assert.equal(order[0], "pitch");
  assert.ok(order.indexOf("rows") > order.indexOf("pitch"));
});

test("eight distinct band fills, and swatches for each", () => {
  const seen = new Set<string>();
  for (let k = 0; k < 8; k++) {
    const st = bandStyle(APP_PALETTE, k);
    seen.add(`${st.kind}:${st.tone}`);
    assert.match(swatchSvg(APP_PALETTE, k), /^<svg .*<\/svg>$/);
  }
  assert.equal(seen.size, 8);
});
