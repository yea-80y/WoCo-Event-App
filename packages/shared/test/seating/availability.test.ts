import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_TEMPLATES } from "../../src/seating/templates.js";
import { freezeSeatPlan, initialHeldSeats } from "../../src/seating/plan.js";
import {
  SEAT_FREE, SEAT_HELD, SEAT_NO_PRICE, SEAT_ON_HOLD, SEAT_TAKEN, SEAT_UNCONFIRMED, SEAT_UNKNOWN,
  pickable, saleState, seatReason, seatStates, type ChainSeats,
} from "../../src/seating/availability.js";

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
const n = plan.seats.length;
const prices = plan.bands.map((_, i) => 1000 + 500 * i);
const none = { held: new Set<number>(), confirmed: new Map<number, number>() };

const words = (taken: number[] = []): bigint[] => {
  const w = new Array<bigint>(Math.ceil(n / 256)).fill(0n);
  for (const k of taken) w[k >> 8] |= 1n << BigInt(k & 255);
  return w;
};
const chain = (taken: number[] = [], over: Partial<ChainSeats> = {}): ChainSeats => ({
  words: words(taken), remaining: 10n, cancelled: false, eventEndTs: 2_000n, blockTs: 1_000n, ...over,
});

test("sale state: cancelled, then the cutoff by the chain's clock, then remaining", () => {
  assert.equal(saleState(null), "unknown");
  assert.equal(saleState(chain([], { cancelled: true, remaining: 5n })), "cancelled");
  assert.equal(saleState(chain([], { blockTs: 2_000n })), "closed");
  assert.equal(saleState(chain([], { remaining: 0n })), "sold-out");
  assert.equal(saleState(chain()), "on-sale");
});

test("a ticket's bit wins over everything; every seat of a set bit reads taken, top bit included", () => {
  const taken = [0, 255, 256, n - 1];
  const s = seatStates(plan, { chain: chain(taken), organiser: { held: new Set(taken), confirmed: new Map() }, onHold: taken, bandPrices: prices.map(() => null) });
  for (const k of taken) assert.equal(s.codes[k], SEAT_TAKEN, `seat ${k}`);
  assert.equal(s.codes[1], SEAT_NO_PRICE);
});

test("order of the other reasons: no price, held, unconfirmed, someone else's hold", () => {
  const p = [...prices];
  p[plan.seats[0].b] = null as unknown as number;
  const unpricedBand = plan.seats[0].b;
  const k1 = plan.seats.findIndex((s) => s.b !== unpricedBand);
  const k2 = plan.seats.findIndex((s, i) => i > k1 && s.b !== unpricedBand);
  const k3 = plan.seats.findIndex((s, i) => i > k2 && s.b !== unpricedBand);
  const k4 = plan.seats.findIndex((s, i) => i > k3 && s.b !== unpricedBand);
  const s = seatStates(plan, {
    chain: { ...chain(), nonces: new Map([[k2, 3n], [k3, 2n]]) },
    organiser: { held: new Set([k1]), confirmed: new Map([[k3, 2]]) },
    onHold: [k1, k4, -1, n, 1.5],
    bandPrices: p,
  });
  assert.equal(s.codes[0], SEAT_NO_PRICE);
  assert.equal(s.codes[k1], SEAT_HELD, "held beats a hold");
  assert.equal(s.codes[k2], SEAT_UNCONFIRMED, "freed and not confirmed");
  assert.equal(s.codes[k3], SEAT_FREE, "freed and confirmed at exactly that nonce");
  assert.equal(s.codes[k4], SEAT_ON_HOLD);
});

test("my own hold is never someone else's", () => {
  const s = seatStates(plan, { chain: chain(), organiser: none, onHold: [5, 6], mine: [6], bandPrices: prices });
  assert.equal(s.codes[5], SEAT_ON_HOLD);
  assert.equal(s.codes[6], SEAT_FREE);
});

test("a word that did not read, or the chain unread, is unknown, never free", () => {
  const w: (bigint | null)[] = words();
  w[1] = null;
  const s = seatStates(plan, { chain: { ...chain(), words: w }, organiser: none, onHold: [], bandPrices: prices });
  assert.equal(s.codes[255], SEAT_FREE);
  assert.equal(s.codes[256], SEAT_UNKNOWN);
  const short = seatStates(plan, { chain: { ...chain(), words: [] }, organiser: none, onHold: [], bandPrices: prices });
  assert.equal(short.codes[0], SEAT_UNKNOWN);
  const unread = seatStates(plan, { chain: null, organiser: none, onHold: [], bandPrices: prices });
  assert.equal(unread.sale, "unknown");
  assert.equal(unread.codes[0], SEAT_UNKNOWN);
  assert.equal(pickable(unread, 0), false);
});

test("the plan's own held flags apply until the organiser's seat state exists", () => {
  const held = initialHeldSeats(plan);
  const s = seatStates(plan, { chain: chain(), organiser: { held, confirmed: new Map() }, onHold: [], bandPrices: prices });
  for (const k of held) assert.equal(s.codes[k], SEAT_HELD);
});

test("nothing is pickable unless on sale", () => {
  for (const over of [{ remaining: 0n }, { cancelled: true }, { blockTs: 5_000n }]) {
    const s = seatStates(plan, { chain: chain([], over), organiser: none, onHold: [], bandPrices: prices });
    assert.equal(s.codes[0], SEAT_FREE);
    assert.equal(pickable(s, 0), false);
  }
  assert.equal(pickable(seatStates(plan, { chain: chain(), organiser: none, onHold: [], bandPrices: prices }), 0), true);
});

test("reasons a buyer hears", () => {
  assert.equal(seatReason(SEAT_FREE), null);
  assert.equal(seatReason(SEAT_TAKEN), "sold");
  assert.equal(seatReason(SEAT_ON_HOLD), "being bought");
  assert.equal(seatReason(SEAT_HELD), "not available");
});
