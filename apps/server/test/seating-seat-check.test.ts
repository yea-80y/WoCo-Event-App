/**
 * Allocated seating S4: the server's per-seat checks before a hold (docs/SEATING.md
 * "Selling a seat"). The rules are the buyer map's (`seatStates`), plus what only the
 * server knows (its own minted seats) and what a money path must not guess (a seat
 * whose word or nonce did not come back in the one read refuses with 503, never sells).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { freezeSeatPlan, initialHeldSeats } from "@woco/shared/seating/plan";
import type { SeatBatchRead } from "@woco/shared/seating/chain";
import type { PaymentConfig } from "@woco/shared";
import { checkSeats } from "../src/lib/seating/seat-check.js";

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
const n = plan.seats.length;
const DIGEST = `0x${"5e".repeat(32)}`;
const held = initialHeldSeats(plan);
const free = plan.seats.map((_, k) => k).filter((k) => !held.has(k));
const priceOf = (bandIndex: number) => `${12 + 4 * bandIndex}.00`;
const seating = { bands: plan.bands.map((b, i) => ({ id: b.id, price: priceOf(i) })) };
const payment = { price: priceOf(0), currency: "GBP", stripeEnabled: true, cryptoEnabled: false } as PaymentConfig;

function read(over: { taken?: number[]; nonces?: Array<[number, bigint]>; drop?: "block" | "event" | "word" | "nonce"; event?: Partial<NonNullable<SeatBatchRead["event"]>> } = {}, seats: number[] = []): SeatBatchRead {
  const words = new Map<number, bigint>();
  for (const k of seats) words.set(k >> 8, words.get(k >> 8) ?? 0n);
  for (const k of over.taken ?? []) words.set(k >> 8, (words.get(k >> 8) ?? 0n) | (1n << BigInt(k & 255)));
  const nonces = new Map<number, bigint>(seats.map((k) => [k, 0n]));
  for (const [k, v] of over.nonces ?? []) nonces.set(k, v);
  if (over.drop === "word") words.delete(seats[0] >> 8);
  if (over.drop === "nonce") nonces.delete(seats[0]);
  return {
    block: over.drop === "block" ? null : 100n,
    event: over.drop === "event" ? null : {
      totalSupply: BigInt(n), nextSlot: 3n, manifestRef: `0x${"00".repeat(32)}`, seated: true,
      remaining: 10n, cancelled: false, eventEndTs: 2_000n, blockTs: 1_000n, ...over.event,
    },
    words,
    nonces,
  };
}

const check = (seats: number[], chain: SeatBatchRead, extra: { minted?: number[]; seating?: unknown } = {}) => checkSeats({
  plan, planDigest: DIGEST, seating: extra.seating ?? seating, payment, seats, minted: new Set(extra.minted ?? []), chain,
});

test("free seats are held with the label, band and price pinned for checkout", () => {
  const seats = [free[0], free[1]];
  const r = check(seats, read({}, seats));
  assert.ok(r.ok);
  assert.equal(r.remaining, 10);
  for (const [i, k] of seats.entries()) {
    const b = plan.seats[k].b;
    assert.equal(r.seats[i].band, plan.bands[b].id);
    assert.equal(r.seats[i].bandName, plan.bands[b].name);
    assert.equal(r.seats[i].priceMinor, Math.round(parseFloat(priceOf(b)) * 100));
    assert.match(r.seats[i].label, /seat \d+$/);
  }
});

test("a seat the chain says is taken, or our own sale minted, comes back as a conflict", () => {
  const seats = [free[0], free[1], free[2]];
  const taken = check(seats, read({ taken: [free[1]] }, seats));
  assert.ok(!taken.ok);
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.conflicts, [free[1]]);
  // The chain replica may not show our mint yet; our sale record does.
  const minted = check(seats, read({}, seats), { minted: [free[2]] });
  assert.ok(!minted.ok);
  assert.deepEqual(minted.conflicts, [free[2]]);
});

test("a seat a ticket left (nonce > 0) does not sell until the organiser confirms it (S6)", () => {
  const seats = [free[0], free[1]];
  const r = check(seats, read({ nonces: [[free[0], 1n]] }, seats));
  assert.ok(!r.ok);
  assert.deepEqual(r.conflicts, [free[0]]);
});

test("a seat the plan keeps back, or one not on the plan, is refused", () => {
  // The gala template keeps seats back; the theatre one keeps none.
  const gala = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "gala")!.make());
  const kept = [...initialHeldSeats(gala)];
  assert.ok(kept.length > 0);
  const galaSeating = { bands: gala.bands.map((b) => ({ id: b.id, price: "20.00" })) };
  const r = checkSeats({
    plan: gala, planDigest: DIGEST, seating: galaSeating, payment: { ...payment, price: "20.00" },
    seats: [kept[0]], minted: new Set(), chain: read({}, [kept[0]]),
  });
  assert.ok(!r.ok);
  assert.deepEqual(r.conflicts, [kept[0]]);

  const outside = check([free[0], n], read({}, [free[0], n]));
  assert.ok(!outside.ok);
  assert.deepEqual(outside.conflicts, [n]);
  assert.equal(outside.error, "These seats are not on the seating plan");
});

test("a read missing anything a seat needs refuses with 503, never sells", () => {
  const seats = [free[0], free[300]];
  for (const drop of ["block", "event", "word", "nonce"] as const) {
    const r = check(seats, read({ drop }, seats));
    assert.ok(!r.ok, drop);
    assert.equal(r.status, 503, drop);
  }
});

test("sale state: cancelled, closed by the chain's clock, sold out, or not a seated event", () => {
  const seats = [free[0]];
  const why = (over: Partial<NonNullable<SeatBatchRead["event"]>>) => {
    const r = check(seats, read({ event: over }, seats));
    assert.ok(!r.ok);
    return r.error;
  };
  assert.match(why({ cancelled: true }), /cancelled/);
  assert.match(why({ blockTs: 2_000n }), /closed/);
  assert.equal(why({ remaining: 0n }), "Sold out");
  assert.match(why({ seated: false }), /not currently on sale/);
});

test("feed prices that no longer cover the plan stop the sale", () => {
  const seats = [free[0]];
  const missing = { bands: seating.bands.slice(1) };
  const r = check(seats, read({}, seats), { seating: missing });
  assert.ok(!r.ok);
  assert.equal(r.status, 409);
  assert.equal(r.conflicts, undefined, "the whole series is off sale, not one seat");
  // Every band priced, but the listed "from" price is not the lowest: re-signed, refused.
  const notLowest = checkSeats({
    plan, planDigest: DIGEST, seating, payment: { ...payment, price: "99.00" }, seats, minted: new Set(), chain: read({}, seats),
  });
  assert.ok(!notLowest.ok);
  assert.match(notLowest.error, /not currently on sale/);
});
