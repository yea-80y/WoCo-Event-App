import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { encodeSeatPlan, freezeSeatPlan, seatPlanDigest } from "@woco/shared/seating/plan";
import { seatStates } from "@woco/shared/seating/availability";
import { buyerPlan } from "@woco/seatmap/buyer";
import {
  companionBeside, mapNotice, picksStorageKey, picksTotal, priceRange, readPicks, seatsText, totalLine, writePicks,
} from "../src/lib/seating/picker-model.js";

const planOf = (id: string) => {
  const p = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === id)!.make());
  return buyerPlan(p, seatPlanDigest(encodeSeatPlan(p)));
};
const none = { held: new Set<number>(), confirmed: new Map<number, number>() };

test("notices: a problem first, then the sale state, then our server; none when all is well", () => {
  assert.equal(mapNotice({ problem: "mismatch", sale: "on-sale" })?.retry, false);
  assert.equal(mapNotice({ problem: "publishing" })?.retry, true);
  assert.match(mapNotice({ sale: "sold-out" })!.text, /Sold out/);
  assert.match(mapNotice({ sale: "closed" })!.text, /closed/);
  assert.match(mapNotice({ sale: "cancelled" })!.text, /cancelled/);
  assert.equal(mapNotice({ sale: "unknown" })?.retry, true);
  assert.equal(mapNotice({ sale: "on-sale", serverOk: false })?.retry, true);
  assert.equal(mapNotice({ sale: "on-sale", serverOk: true }), null);
});

test("seats in words: one row reads as a range, mixed rows each", () => {
  const bp = planOf("theatre");
  const row = bp.runsOf[1][0].filter((k) => k >= 0);
  assert.match(seatsText(bp, [row[1], row[0]]), /^Stalls, Row A, seats \d+-\d+$/);
  const other = bp.runsOf[1][1].find((k) => k >= 0)!;
  assert.match(seatsText(bp, [row[0], other]), /; /);
  assert.equal(seatsText(bp, []), "");
});

test("totals and price ranges", () => {
  const bp = planOf("theatre");
  const prices = bp.plan.bands.map((_, i) => 2800 - 600 * i);
  const picks = [0, 1];
  assert.equal(picksTotal(bp, prices, picks), 5600);
  assert.equal(totalLine(bp, prices, picks, "GBP"), "2 seats · £56");
  assert.equal(totalLine(bp, prices, [0], "GBP"), "1 seat · £28");
  assert.equal(priceRange(2200, 2800, "GBP"), "£22-28");
  assert.equal(priceRange(2200, 2200, "GBP"), "£22");
  assert.equal(priceRange(null, null, "GBP"), "");
});

test("a wheelchair space suggests the free companion seat beside it, never one already taken or picked", () => {
  const bp = planOf("stadium");
  const k = bp.plan.seats.findIndex((s) => s.a);
  // Give the stadium a companion seat beside its first wheelchair space.
  const ref = bp.refs[k];
  const j = bp.runsOf[ref.item][ref.row][ref.pos + 1];
  bp.plan.seats[j] = { ...bp.plan.seats[j], c: true };
  const prices = bp.plan.bands.map(() => 1000);
  const free = seatStates(bp.plan, { chain: null, organiser: none, onHold: [], bandPrices: prices });
  // Chain unread: nothing reads free, so nothing is suggested.
  assert.equal(companionBeside(bp, free, k, []), null);
  const words = new Array<bigint>(Math.ceil(bp.seats / 256)).fill(0n);
  const open = seatStates(bp.plan, { chain: { words, remaining: 9n, cancelled: false, eventEndTs: 9n, blockTs: 1n }, organiser: none, onHold: [], bandPrices: prices });
  assert.equal(companionBeside(bp, open, k, []), j);
  assert.equal(companionBeside(bp, open, k, [j]), null);
  assert.equal(companionBeside(bp, open, j, []), null, "only a wheelchair space suggests");
});

test("picks survive a reload per plan, cleaned on the way in", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const key = picksStorageKey("e", "s", "0xabc");
  assert.notEqual(key, picksStorageKey("e", "s", "0xdef"));
  writePicks(store, key, [3, 4]);
  assert.deepEqual(readPicks(store, key, 10, 10), [3, 4]);
  mem.set(key, JSON.stringify([3, 3, 99, -1, 1.5, "2", 5]));
  assert.deepEqual(readPicks(store, key, 10, 10), [3, 5]);
  assert.deepEqual(readPicks(store, key, 10, 1), [3]);
  mem.set(key, "{oops");
  assert.deepEqual(readPicks(store, key, 10, 10), []);
  writePicks(store, key, []);
  assert.equal(mem.has(key), false);
  assert.deepEqual(readPicks(null, key, 10, 10), []);
});
