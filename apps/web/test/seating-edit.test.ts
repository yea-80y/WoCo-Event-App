/**
 * The seating builder's edits keep a layout inside the format (docs/SEATING.md):
 * whatever an organiser does, `validateSeatLayout` accepts the result after tidyLayout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateSeatLayout, type RowsItem, type TableItem } from "@woco/shared/seating/layout";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { seatPlanProblems } from "@woco/shared/seating/plan";
import {
  addBand, applyBrush, cloneItem, counts, freshId, keepInRoom, lineUp, makeItem, planNotes, resizeRows,
  rotateItems, seatsInRect, setRowCount, setTableSeats, spread, tidyLayout, type AddKind,
} from "../src/lib/creator/seating/edit.js";

const fresh = (id = "theatre") => LAYOUT_TEMPLATES.find((t) => t.id === id)!.make();

test("every kind of thing can be added and the layout stays valid", () => {
  const l = fresh("empty");
  for (const kind of ["rows", "round", "long", "head", "stage", "ring", "pitch", "bar", "floor", "label"] as AddKind[]) {
    l.items.push(makeItem(l, kind, 400, 300));
  }
  assert.ok(validateSeatLayout(l));
  assert.equal(new Set(l.items.map((i) => i.id)).size, l.items.length, "fresh ids");
  assert.deepEqual(l.items.filter((i) => i.kind === "table").map((t) => (t as TableItem).name), ["Table 1", "Table 2", "Top table"]);
});

test("resizing rows keeps an aisle in the middle and never leaves a gap at an end", () => {
  const l = fresh();
  const stalls = l.items[1] as RowsItem;
  const before = structuredClone(stalls.rows);
  resizeRows(stalls, before, 4, l.bands[0].id);
  assert.ok(stalls.rows.every((r) => !("g" in r.seats[0]) && !("g" in r.seats[r.seats.length - 1])));
  resizeRows(stalls, before, -30, l.bands[0].id);
  assert.ok(stalls.rows.every((r) => r.seats.some((s) => !("g" in s))), "at least one seat left in every row");
  assert.ok(validateSeatLayout(l));
});

test("rows added copy the last row's shape with fresh letters", () => {
  const l = fresh();
  const stalls = l.items[1] as RowsItem;
  setRowCount(stalls, stalls.rows, 14);
  assert.equal(stalls.rows.length, 14);
  assert.equal(new Set(stalls.rows.map((r) => r.label)).size, 14);
  assert.deepEqual(stalls.rows.slice(12).map((r) => r.label), ["N", "P"], "after M: no I or O");
  assert.ok(validateSeatLayout(l));
  setRowCount(stalls, stalls.rows, 0);
  assert.equal(stalls.rows.length, 1);
});

test("table seats stay within the shape's limit", () => {
  const l = fresh("cabaret");
  const t = l.items[1] as TableItem;
  setTableSeats(t, 99, l.bands[0].id);
  assert.equal(t.seats.length, 16);
  setTableSeats(t, 0, l.bands[0].id);
  assert.equal(t.seats.length, 2);
  assert.ok(validateSeatLayout(l));
});

test("painting: a price puts a held seat back on sale and keeps a wheelchair space; gaps at ends are tidied", () => {
  const l = fresh();
  const row = (l.items[1] as RowsItem).rows[11].seats;
  applyBrush(row, 0, "held", l.bands[0].id);
  assert.deepEqual(row[0], { b: l.bands[1].id, a: true, h: true });
  applyBrush(row, 0, { band: l.bands[0].id }, l.bands[0].id);
  assert.deepEqual(row[0], { b: l.bands[0].id, a: true });
  applyBrush(row, 1, "companion", l.bands[0].id);
  assert.deepEqual(row[1], { b: l.bands[1].id, c: true });
  applyBrush(row, 0, "gap", l.bands[0].id);
  assert.equal(validateSeatLayout(l), false, "a gap at a row end is not in the format");
  assert.equal(tidyLayout(l), 0);
  assert.ok(validateSeatLayout(l), "tidied");
  // Paint a whole row out: tidy removes it.
  const r0 = (l.items[1] as RowsItem).rows[0].seats;
  for (let i = 0; i < r0.length; i++) applyBrush(r0, i, "gap", l.bands[0].id);
  assert.equal(tidyLayout(l), 1);
  assert.equal((l.items[1] as RowsItem).rows.length, 11);
  assert.ok(validateSeatLayout(l));
});

test("copies get fresh ids and non-clashing names; turning stays 0..359", () => {
  const l = fresh("cabaret");
  const c = cloneItem(l, l.items[1], { x: 140, y: 0 });
  l.items.push(c);
  assert.equal((c as TableItem).name, "Table 14");
  assert.notEqual(c.id, l.items[1].id);
  rotateItems([c], -15);
  assert.equal(c.rot, 345);
  assert.ok(validateSeatLayout(l));
  assert.deepEqual(seatPlanProblems(l), []);
});

test("line up, space evenly and keep-in-room write whole numbers", () => {
  const l = fresh("cabaret");
  const tables = l.items.slice(1, 5);
  tables[1].y += 17;
  lineUp(tables);
  assert.equal(new Set(tables.map((t) => t.y)).size, 1);
  tables[2].x += 33;
  spread(tables);
  const xs = tables.map((t) => t.x).sort((a, b) => a - b);
  assert.ok(Math.abs((xs[1] - xs[0]) - (xs[2] - xs[1])) <= 1);
  tables[0].x = -500;
  keepInRoom([tables[0]]);
  assert.ok(l.items.every((it) => Number.isInteger(it.x) && Number.isInteger(it.y)));
  assert.ok(validateSeatLayout(l));
});

test("bands: up to eight, each its own fill", () => {
  const l = fresh("empty");
  while (addBand(l)) { /* fill */ }
  assert.equal(l.bands.length, 8);
  assert.equal(new Set(l.bands.map((b) => b.style)).size, 8);
  assert.equal(addBand(l), null);
  assert.equal(freshId(l, "b"), "b9");
});

test("counts, box selection and the second-look notes", () => {
  const l = fresh("gala");
  const c = counts(l);
  assert.equal(c.held, 12);
  assert.equal(c.forSale, 100);
  assert.equal(c.tables, 11);
  assert.ok(seatsInRect(l.items, { x0: 0, y0: 0, x1: 2000, y1: 2000 }).length >= 112);
  const notes = planNotes(l).map((n) => n.text);
  assert.ok(notes.some((t) => /no wheelchair spaces/.test(t)));
  assert.ok(notes.some((t) => /12 held seats stay off sale/.test(t)));
  // Two tables dropped on top of each other are flagged.
  l.items.push({ ...structuredClone(l.items[3]), id: "i99", name: "Table 99" } as TableItem);
  assert.ok(planNotes(l).some((n) => n.warn && /on top of each other/.test(n.text)));
});
