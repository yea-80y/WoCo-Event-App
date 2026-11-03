/**
 * The seat walk is FROZEN: seat index k on the ledger is entry k of this list for
 * every seated event ever published. These vectors are written out by hand, not
 * derived, so a change to the walk fails here before it renumbers anyone's seat.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEAT_LAYOUT_FORMAT, validateSeatLayout, type SeatLayout,
} from "../../src/seating/layout.js";
import {
  SEAT_PLAN_FORMAT, canonicalSeats, encodeSeatPlan, formatSeatLabel, freezeSeatPlan, initialHeldSeats,
  layoutOfPlan, MAX_SEAT_PLAN_BYTES, parseSeatPlan, seatLabel, seatPlanDigest, seatPlanProblems, validateSeatPlan,
} from "../../src/seating/plan.js";
import { LAYOUT_TEMPLATES } from "../../src/seating/templates.js";
import { isJsonSafeStatementValue } from "../../src/statement/discipline.js";

function golden(): SeatLayout {
  return {
    format: SEAT_LAYOUT_FORMAT,
    name: "Golden room",
    bands: [{ id: "b1", name: "Front", style: 0 }, { id: "b2", name: "Back", style: 1 }, { id: "b3", name: "Unused", style: 2 }],
    items: [
      { id: "i1", kind: "stage", x: 0, y: 0, w: 100, h: 40, rot: 0, text: "Stage" },
      {
        id: "i2", kind: "rows", name: "Stalls", x: 0, y: 100, rot: 0, curve: 0, numberFrom: "left",
        rows: [
          { label: "A", seats: [{ b: "b1" }, { b: "b1", a: true }, { g: true }, { b: "b1", c: true }] },
          { label: "B", seats: [{ b: "b2" }, { b: "b2", h: true }] },
        ],
      },
      {
        id: "i3", kind: "rows", name: "Side", x: 300, y: 100, rot: 90, curve: 20, numberFrom: "right", numberStart: 11,
        rows: [{ label: "A", seats: [{ b: "b2" }, { b: "b2" }, { b: "b2" }] }],
      },
      { id: "i4", kind: "table", shape: "round", name: "Table 1", x: 0, y: 300, rot: 0, seats: [{ b: "b1" }, { b: "b1" }, { b: "b1" }] },
    ],
  };
}

const GOLDEN_SEATS = [
  { i: 1, r: "A", n: 1, b: 0 },
  { i: 1, r: "A", n: 2, b: 0, a: true },
  { i: 1, r: "A", n: 3, b: 0, c: true },
  { i: 1, r: "B", n: 1, b: 1 },
  { i: 1, r: "B", n: 2, b: 1 },
  { i: 2, r: "A", n: 13, b: 1 },
  { i: 2, r: "A", n: 12, b: 1 },
  { i: 2, r: "A", n: 11, b: 1 },
  { i: 3, n: 1, b: 0 },
  { i: 3, n: 2, b: 0 },
  { i: 3, n: 3, b: 0 },
];

/** keccak256 of the golden plan's exact bytes. A change here is a format change. */
const GOLDEN_DIGEST = "0xbd12d1445fd8f4ba782f34c9e47742e645a8534d2b89421faac7943803602ddd";

test("the walk: items in order, rows in order, gaps skipped, numbering per row", () => {
  const plan = freezeSeatPlan(golden());
  assert.deepEqual(plan.seats, GOLDEN_SEATS);
  assert.deepEqual(canonicalSeats(golden()).map((s) => s.n), [1, 2, 3, 1, 2, 13, 12, 11, 1, 2, 3]);
});

test("freezing drops unused bands and keeps their order", () => {
  const plan = freezeSeatPlan(golden(), "lib-1");
  assert.equal(plan.format, SEAT_PLAN_FORMAT);
  assert.deepEqual(plan.bands.map((b) => b.id), ["b1", "b2"]);
  assert.equal(plan.source, "lib-1");
  assert.ok(validateSeatPlan(plan));
});

test("golden bytes and digest", () => {
  const bytes = encodeSeatPlan(freezeSeatPlan(golden()));
  assert.equal(seatPlanDigest(bytes), GOLDEN_DIGEST);
  // Same plan built with keys in another order encodes to the same bytes.
  const shuffled = JSON.parse(JSON.stringify(freezeSeatPlan(golden())), (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v);
  assert.equal(seatPlanDigest(encodeSeatPlan(shuffled)), GOLDEN_DIGEST);
});

test("labels", () => {
  const plan = freezeSeatPlan(golden());
  assert.equal(formatSeatLabel(seatLabel(plan, 1)!), "Stalls, Row A, seat 2");
  assert.equal(formatSeatLabel(seatLabel(plan, 5)!), "Side, Row A, seat 13");
  assert.equal(formatSeatLabel(seatLabel(plan, 9)!), "Table 1, seat 2");
  assert.equal(seatLabel(plan, 11), null);
});

test("held at publish comes from the layout, not the seat list", () => {
  assert.deepEqual([...initialHeldSeats(freezeSeatPlan(golden()))], [4]);
});

test("a frozen plan is statement-safe JSON", () => {
  assert.ok(isJsonSafeStatementValue(freezeSeatPlan(golden())));
});

test("parse: digest must match the exact bytes", () => {
  const plan = freezeSeatPlan(golden());
  const bytes = encodeSeatPlan(plan);
  assert.deepEqual(parseSeatPlan(bytes, seatPlanDigest(bytes)), plan);
  assert.equal(parseSeatPlan(bytes, `0x${"00".repeat(32)}`), null);
  const notJson = new TextEncoder().encode("{not json");
  assert.equal(parseSeatPlan(notJson, seatPlanDigest(notJson)), null);
  const badUtf8 = new Uint8Array([0xff, 0xfe]);
  assert.equal(parseSeatPlan(badUtf8, seatPlanDigest(badUtf8)), null);
});

test("parse: a blob past the size cap is refused, even a valid one", () => {
  const plan = encodeSeatPlan(freezeSeatPlan(golden()));
  // Trailing whitespace keeps it valid JSON, so only the cap can refuse it.
  const big = new Uint8Array(MAX_SEAT_PLAN_BYTES + 1).fill(0x20);
  big.set(plan);
  assert.equal(parseSeatPlan(big, seatPlanDigest(big)), null);
});

test("a plan whose seat list does not match its items is refused", () => {
  const plan = freezeSeatPlan(golden());
  const tamper = (f: (p: any) => void) => { const p = structuredClone(plan) as any; f(p); return validateSeatPlan(p); };
  assert.equal(tamper((p) => { p.seats[5].n = 99; }), false);
  assert.equal(tamper((p) => { p.seats.pop(); }), false);
  assert.equal(tamper((p) => { p.seats.push({ i: 3, n: 4, b: 0 }); }), false);
  assert.equal(tamper((p) => { p.items.reverse(); }), false);
  assert.equal(tamper((p) => { p.seats[0].a = false; }), false);
  assert.equal(tamper((p) => { p.seats[1].a = undefined; }), false);
  assert.equal(tamper((p) => { p.seats[0].x = 1; }), false);
  assert.equal(tamper((p) => { p.extra = 1; }), false);
  assert.equal(tamper((p) => { p.source = "has space"; }), false);
  assert.equal(tamper((p) => { p.bands.push({ id: "b9", name: "Unused", style: 5 }); }), false);
  assert.equal(tamper((p) => { p.format = SEAT_LAYOUT_FORMAT; }), false);
});

test("two seats that would print the same label stop publishing", () => {
  const l = golden();
  l.items.push({ id: "i5", kind: "table", shape: "round", name: "Table 1", x: 200, y: 300, rot: 0, seats: [{ b: "b1" }, { b: "b1" }] });
  const problems = seatPlanProblems(l);
  assert.deepEqual(problems, [
    { kind: "duplicate-label", label: "Table 1, seat 1", seats: [8, 11] },
    { kind: "duplicate-label", label: "Table 1, seat 2", seats: [9, 12] },
  ]);
  assert.throws(() => freezeSeatPlan(l));
});

test("odd/even houses: numbers go up in twos from the start, either direction", () => {
  const l = golden();
  const side = l.items[2] as Extract<SeatLayout["items"][number], { kind: "rows" }>;
  side.numberStep = 2;
  side.numberStart = 2;
  assert.deepEqual(freezeSeatPlan(l).seats.slice(5, 8).map((s) => s.n), [6, 4, 2], "right to left: evens");
  side.numberFrom = "left";
  side.numberStart = 1;
  assert.deepEqual(freezeSeatPlan(l).seats.slice(5, 8).map((s) => s.n), [1, 3, 5], "left to right: odds");
  assert.ok(validateSeatLayout(l));
  (side as { numberStep?: number }).numberStep = 1;
  assert.equal(validateSeatLayout(l), false, "consecutive is spelled by leaving it out");
});

test("labels that print alike are the same label: case, spacing and invisible characters", () => {
  const l = golden();
  l.items.push({ id: "i5", kind: "table", shape: "round", name: "table 1", x: 200, y: 300, rot: 0, seats: [{ b: "b1" }, { b: "b1" }] });
  assert.ok(seatPlanProblems(l).some((p) => p.kind === "duplicate-label"), "Table 1 vs table 1");
  const bad = (name: string) => { const x = golden(); (x.items[3] as { name: string }).name = name; return validateSeatLayout(x); };
  assert.equal(bad("Table 1 "), false, "trailing space");
  assert.equal(bad(" Table 1"), false, "leading space");
  assert.equal(bad("Table​1"), false, "zero-width space");
  assert.equal(bad("Table‮1"), false, "direction override");
  assert.equal(bad("Table 1"), true);
  const rows = golden();
  (rows.items[1] as Extract<SeatLayout["items"][number], { kind: "rows" }>).rows[1].label = "a";
  assert.equal(validateSeatLayout(rows), false, "rows A and a in one block");
});

test("a layout with no seats cannot be published", () => {
  const empty = LAYOUT_TEMPLATES.find((t) => t.id === "empty")!.make();
  assert.ok(validateSeatLayout(empty));
  assert.deepEqual(seatPlanProblems(empty), [{ kind: "no-seats" }]);
});

test("layout validation refuses, never normalises", () => {
  const bad = (f: (l: any) => void) => { const l = golden() as any; f(l); return validateSeatLayout(l); };
  assert.ok(validateSeatLayout(golden()));
  assert.equal(bad((l) => { l.items[1].x = 1.5; }), false, "float");
  assert.equal(bad((l) => { l.items[1].curve = null; }), false, "null");
  assert.equal(bad((l) => { l.items[1].zoom = 2; }), false, "unknown key");
  assert.equal(bad((l) => { l.items[1].rows[0].seats.push({ g: true }); }), false, "gap at row end");
  assert.equal(bad((l) => { l.items[1].rows[0].seats.unshift({ g: true }); }), false, "gap at row start");
  assert.equal(bad((l) => { l.items[1].rows[0].seats[0].b = "nope"; }), false, "unknown band");
  assert.equal(bad((l) => { l.items[2].id = "i2"; }), false, "duplicate item id");
  assert.equal(bad((l) => { l.bands[1].style = 0; }), false, "duplicate fill");
  assert.equal(bad((l) => { l.items[2].rot = 360; }), false, "rotation range");
  assert.equal(bad((l) => { l.items[2].curve = 101; }), false, "curve range");
  assert.equal(bad((l) => { l.items[1].rows[0].seats[0].a = true; l.items[1].rows[0].seats[0].c = true; }), false, "space and companion");
  assert.equal(bad((l) => { l.items[1].rows[0].seats[0].h = false; }), false, "flag false");
  assert.equal(bad((l) => { l.items[1].rows[1].label = "A"; }), false, "duplicate row label");
  assert.equal(bad((l) => { l.items[1].rows[0].seats = []; }), false, "empty row");
  assert.equal(bad((l) => { l.items[1].name = "   "; }), false, "blank name");
  assert.equal(bad((l) => { l.items[1].name = "Sta\nlls"; }), false, "control character");
  assert.equal(bad((l) => { l.bands = Array.from({ length: 9 }, (_, i) => ({ id: `b${i + 1}`, name: "x", style: i % 8 })); }), false, "too many bands");
  assert.equal(bad((l) => { l.items[3].shape = "square"; }), false, "table shape");
  assert.equal(bad((l) => { l.items[0].kind = "screen"; }), false, "shape kind");
});

test("every starting layout is valid; the seated ones publish", () => {
  const counts: Record<string, number> = {};
  for (const t of LAYOUT_TEMPLATES) {
    const l = t.make();
    assert.ok(validateSeatLayout(l), t.id);
    if (t.id === "empty") continue;
    const plan = freezeSeatPlan(l, t.id);
    assert.ok(validateSeatPlan(plan), t.id);
    assert.deepEqual(freezeSeatPlan(layoutOfPlan(plan), t.id), plan, `${t.id} round trip`);
    counts[t.id] = plan.seats.length;
  }
  assert.deepEqual(counts, { theatre: 394, cabaret: 78, comedy: 132, gala: 112, stadium: 680, boxing: 144 });
});
