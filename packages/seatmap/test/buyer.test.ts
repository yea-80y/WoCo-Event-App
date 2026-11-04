import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { encodeSeatPlan, freezeSeatPlan, seatPlanDigest, seatRefs } from "@woco/shared/seating/plan";
import { seatStates, type ChainSeats } from "@woco/shared/seating/availability";
import {
  bestFor, buyerPlan, formatMinor, loneSeat, neighbour, prunePicks, seatAt, sectionSummaries, spokenLabel, togglePick,
} from "../src/buyer.js";

const planOf = (id: string) => {
  const p = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === id)!.make());
  return buyerPlan(p, seatPlanDigest(encodeSeatPlan(p)));
};
const none = { held: new Set<number>(), confirmed: new Map<number, number>() };

const chain = (n: number, taken: number[] = [], over: Partial<ChainSeats> = {}): ChainSeats => {
  const words = new Array<bigint>(Math.ceil(n / 256)).fill(0n);
  for (const k of taken) words[k >> 8] |= 1n << BigInt(k & 255);
  return { words, remaining: 10n, cancelled: false, eventEndTs: 2_000n, blockTs: 1_000n, ...over };
};
const priced = (bp: ReturnType<typeof planOf>) => bp.plan.bands.map((_, i) => 1000 + i * 500);
const states = (bp: ReturnType<typeof planOf>, taken: number[] = [], over: Partial<ChainSeats> = {}) =>
  seatStates(bp.plan, { chain: chain(bp.seats, taken, over), organiser: none, onHold: [], bandPrices: priced(bp) });

test("sections are contiguous seat ranges that cover the walk exactly", () => {
  for (const t of LAYOUT_TEMPLATES.filter((t) => t.id !== "empty")) {
    const bp = planOf(t.id);
    let k = 0;
    for (const s of bp.sections) {
      assert.equal(s.first, k, t.id);
      for (let j = s.first; j < s.first + s.count; j++) assert.equal(bp.refs[j].item, s.item, `${t.id} seat ${j}`);
      k += s.count;
    }
    assert.equal(k, bp.seats, t.id);
    // seatAt inverts the walk.
    seatRefs(bp.plan.items).forEach((r, j) => assert.equal(seatAt(bp, r.item, r.row, r.pos), j));
  }
});

test("section summaries count free seats only while on sale", () => {
  const bp = planOf("comedy");
  const open = sectionSummaries(bp, states(bp, [0]), priced(bp));
  assert.equal(open[0].free, bp.sections[0].count - 1);
  for (const over of [{ remaining: 0n }, { cancelled: true }]) {
    assert.equal(sectionSummaries(bp, states(bp, [], over), priced(bp))[0].free, 0);
  }
  assert.equal(bestFor(bp, states(bp, [], { remaining: 0n }), 1), null);
});

test("toggle: add a free seat, remove a picked one even when no longer free, cap at max", () => {
  const bp = planOf("comedy");
  const s = states(bp, [5]);
  assert.deepEqual(togglePick([], 1, s, 2), [1]);
  assert.equal(togglePick([1], 5, s, 2), "not-free");
  assert.equal(togglePick([1, 2], 3, s, 2), "full");
  assert.deepEqual(togglePick([5, 1], 5, s, 2), [1], "a taken seat already picked can be put back");
  assert.deepEqual(prunePicks([1, 5, 2], s), { kept: [1, 2], lost: [5] });
});

test("best seats skip anything not free and respect the filter", () => {
  const bp = planOf("theatre");
  const best = bestFor(bp, states(bp), 2)!;
  assert.equal(best.length, 2);
  const taken = states(bp, best);
  const next = bestFor(bp, taken, 2)!;
  assert.ok(next.every((k) => !best.includes(k)));
  const band = bp.plan.seats[next[0]].b;
  const other = bestFor(bp, taken, 2, (k) => bp.plan.seats[k].b !== band);
  assert.ok(other && other.every((k) => bp.plan.seats[k].b !== band));
});

test("lone seat advice points at the seat left alone", () => {
  const bp = planOf("comedy");
  const row = bp.runs.find((r) => r.isRow && r.seats.filter((k) => k >= 0).length >= 4)!;
  const [a, b, c] = row.seats.filter((k) => k >= 0);
  const s = states(bp);
  assert.equal(loneSeat(bp, s, [b, c]), a);
  assert.equal(loneSeat(bp, s, [a, b]), null);
});

test("arrow keys walk the row on screen, skip gaps, and step between rows", () => {
  const bp = planOf("theatre");
  const row = bp.runsOf[1][0];
  const real = row.filter((k) => k >= 0);
  const it = bp.plan.items[1];
  const flipped = Math.cos((it.rot * Math.PI) / 180) < 0;
  const [first, second] = flipped ? [real[1], real[0]] : [real[0], real[1]];
  assert.equal(neighbour(bp, first, "right"), second);
  assert.equal(neighbour(bp, second, "left"), first);
  // Across an aisle gap: the seat before the gap and the seat after it are neighbours.
  const gap = row.indexOf(-1);
  if (gap > 0) assert.equal(neighbour(bp, row[gap - 1], flipped ? "left" : "right"), row[gap + 1]);
  const down = neighbour(bp, real[0], flipped ? "up" : "down")!;
  assert.equal(bp.refs[down].row, 1);
  assert.equal(neighbour(bp, real[0], flipped ? "down" : "up"), null, "nothing in front of the front row");
});

test("labels: words a screen reader can say, money as people write it", () => {
  const bp = planOf("theatre");
  // Theatre's first band is named after its section: said once.
  assert.match(spokenLabel(bp, 0, "£22"), /^Stalls, Row A, seat \d+, £22$/);
  // A band named otherwise is said: the back rows of the stalls sell as "Rear stalls".
  const rear = bp.plan.seats.findIndex((s) => bp.plan.bands[s.b].name === "Rear stalls");
  assert.match(spokenLabel(bp, rear, "£22"), /^Stalls, Row [A-Z]+, seat \d+, Rear stalls, £22$/);
  const stadium = planOf("stadium");
  const k = stadium.plan.seats.findIndex((s) => s.a);
  assert.match(spokenLabel(stadium, k, "£30"), /, seat \d+, £30, wheelchair space$/);
  assert.equal(formatMinor(2200, "GBP"), "£22");
  assert.equal(formatMinor(2250, "GBP"), "£22.50");
  assert.equal(formatMinor(2200, "XYZ"), "XYZ 22");
});
