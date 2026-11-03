import { test } from "node:test";
import assert from "node:assert/strict";
import { SEAT_LAYOUT_FORMAT, type LayoutItem, type SeatLayout } from "../../src/seating/layout.js";
import { bestSeats, loneSeatLeft, seatRuns, LONE_SEAT_PENALTY } from "../../src/seating/best.js";
import { canonicalSeats, encodeSeatPlan, freezeSeatPlan, MAX_SEAT_PLAN_BYTES, parseSeatPlan, seatPlanDigest } from "../../src/seating/plan.js";
import { planFocus, seatWorldPoints, toWorld } from "../../src/seating/geometry.js";
import { LAYOUT_TEMPLATES, rowsBlock, shape, table } from "../../src/seating/templates.js";
import { MAX_PLAN_SEATS } from "../../src/seating/layout.js";

const all = () => true;

function room(items: LayoutItem[]): SeatLayout {
  return { format: SEAT_LAYOUT_FORMAT, name: "Room", bands: [{ id: "b1", name: "All", style: 0 }], items };
}

test("best seats: the free run nearest the stage", () => {
  const l = room([shape("s", "stage", 0, 0, 100, 40, "Stage"), rowsBlock("r", "Stalls", 0, 100, 3, 6, "b1", "A", { aisle: false })]);
  // Row A is seats 0..5, B 6..11, C 12..17. Front row centre:
  assert.deepEqual(bestSeats(l.items, all, 2), [2, 3]);
  // Row A taken: the next row's centre.
  assert.deepEqual(bestSeats(l.items, (k) => k >= 6, 2), [8, 9]);
  assert.equal(bestSeats(l.items, all, 7), null, "no row has 7");
  assert.equal(bestSeats(l.items, all, 0), null);
});

test("best seats never cross a gap", () => {
  const l = room([shape("s", "stage", 0, 0, 100, 40, "Stage"), rowsBlock("r", "Stalls", 0, 100, 1, 4, "b1")]);
  // 4 seats with an aisle after the second: [0, 1, gap, 2, 3].
  assert.equal(seatRuns(l.items)[0].seats.join(), "0,1,-1,2,3");
  assert.equal(bestSeats(l.items, all, 3), null);
  assert.ok([[0, 1], [2, 3]].some((r) => JSON.stringify(r) === JSON.stringify(bestSeats(l.items, all, 2))));
});

test("best seats wrap round a round table", () => {
  const l = room([table("t", "Table 1", 0, 0, 6, "round", "b1")]);
  const free = (k: number) => k === 5 || k === 0;
  assert.deepEqual(bestSeats(l.items, free, 2), [5, 0]);
  const long = room([table("t", "Table 1", 0, 0, 6, "long", "b1")]);
  assert.equal(bestSeats(long.items, free, 2), null, "a long table's ends are not neighbours");
});

test("a run that strands one seat loses to one that does not", () => {
  const l = room([rowsBlock("r", "Stalls", 0, 0, 1, 4, "b1", "A", { aisle: false })]);
  const points = [{ x: -33, y: 0 }, { x: -11, y: 0 }, { x: 11, y: 0 }, { x: 33, y: 0 }];
  // [1,2] is nearest the focus but leaves 0 and 3 alone; [2,3] leaves 0 and 1 together.
  assert.deepEqual(bestSeats(l.items, all, 2, { points, focus: { x: 5, y: 0 } }), [2, 3]);
  assert.ok(LONE_SEAT_PENALTY > 17 - 5);
});

test("lone seat warning", () => {
  const l = room([rowsBlock("r", "Stalls", 0, 0, 1, 3, "b1", "A", { aisle: false }), table("t", "Table 1", 0, 200, 3, "round", "b1")]);
  assert.equal(loneSeatLeft(l.items, all, [1]), 0);
  assert.equal(loneSeatLeft(l.items, all, [0, 1]), 2);
  assert.equal(loneSeatLeft(l.items, all, [0]), null);
  assert.equal(loneSeatLeft(l.items, (k) => k !== 2, [0]), 1, "next to a taken seat");
  assert.equal(loneSeatLeft(l.items, all, [4]), null, "tables never warn");
});

test("geometry: one point per seat, in walk order, for every starting layout", () => {
  for (const t of LAYOUT_TEMPLATES) {
    const l = t.make();
    const pts = seatWorldPoints(l.items);
    assert.equal(pts.length, canonicalSeats(l).length, t.id);
    assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), t.id);
  }
  assert.deepEqual(toWorld({ x: 100, y: 50, rot: 180 }, 10, 0), { x: 90, y: 50 + 10 * Math.sin(Math.PI) });
  assert.deepEqual(planFocus(LAYOUT_TEMPLATES[0].make().items), { x: 650, y: 70 });
});

// The timeout, not a clock check, guards against quadratic work: ~4 s alone, slower under
// a loaded suite, hours if the walk or validation went quadratic.
test("scale: a plan at the seat ceiling fits the byte cap and stays usable", { timeout: 120_000 }, () => {
  // 200 blocks of 40 rows x 25 seats = 200,000 seats, aisle in every row.
  const items: LayoutItem[] = [shape("s", "stage", 0, -200, 400, 60, "Stage")];
  for (let b = 0; b < 200; b++) {
    items.push(rowsBlock(`r${b}`, `Block ${b + 1}`, (b % 20) * 700, Math.floor(b / 20) * 1000, 40, 25, "b1", "A", { aisle: false }));
  }
  const l = room(items);
  const plan = freezeSeatPlan(l);
  assert.equal(plan.seats.length, MAX_PLAN_SEATS);
  const bytes = encodeSeatPlan(plan);
  assert.ok(bytes.length < MAX_SEAT_PLAN_BYTES, `${bytes.length} bytes`);
  assert.ok(parseSeatPlan(bytes, seatPlanDigest(bytes)));
  assert.equal(bestSeats(plan.items, all, 4)?.length, 4);
  // One more seat is past the ceiling.
  items.push(table("t", "Table 1", 0, -400, 2, "round", "b1"));
  assert.throws(() => freezeSeatPlan(room(items)));
});
