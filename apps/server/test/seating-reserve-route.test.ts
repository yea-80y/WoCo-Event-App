/**
 * Allocated seating S4: the seated hold behind POST .../reserve (lib/seating/seated-reserve.ts).
 * Refuses anything that could not mint (not ledger2, no registration of ours, no card
 * payments), a plan other than the pin, an unreadable chain; and answers a hold with the
 * priced view every host shows - each seat's pinned price and charge, the order total by
 * the same arithmetic checkout charges (`cardOrderAmountsMulti`).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { freezeSeatPlan } from "@woco/shared/seating/plan";
import { cardOrderAmountsMulti, COVER_FEE_RATES, type PaymentConfig } from "@woco/shared";
import type { SeatBatchRead } from "@woco/shared/seating/chain";

let mod: typeof import("../src/lib/seating/seated-reserve.js");

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-seated-reserve-"));
  mkdirSync(join(dir, ".data"));
  process.chdir(dir);
  mod = await import("../src/lib/seating/seated-reserve.js");
});

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
const DIGEST = `0x${"5c".repeat(32)}`;
const ONCHAIN = `0x${"0e".repeat(32)}`;
const seating = { bands: plan.bands.map((b, i) => ({ id: b.id, price: `${20 + 5 * i}.00` })) };
const payment = { price: "20.00", currency: "GBP", stripeEnabled: true, cryptoEnabled: false, feePassedToCustomer: true, coverFees: COVER_FEE_RATES } as PaymentConfig;
const LEDGER2 = { chainId: 42161, address: `0x${"2e".repeat(20)}`, version: "ledger2" } as const;

const chain = (seats: number[]): SeatBatchRead => ({
  block: 7n,
  event: { totalSupply: BigInt(plan.seats.length), nextSlot: 0n, manifestRef: `0x${"00".repeat(32)}`, seated: true, remaining: 20n, cancelled: false, eventEndTs: 9_999_999_999n, blockTs: 1n },
  words: new Map(seats.map((k) => [k >> 8, 0n])),
  nonces: new Map(seats.map((k) => [k, 0n])),
});

function deps(over: Partial<import("../src/lib/seating/seated-reserve.js").SeatedReserveDeps> = {}) {
  return {
    pinnedSeatPlan: async () => ({ ok: true as const, plan }),
    readSeatChain: async (_c: unknown, _id: string, seats: readonly number[]) => chain([...seats]),
    mintedSeats: () => new Set<number>(),
    lookupOnChainEventId: () => ONCHAIN,
    noteChainCancelled: () => {},
    expireSession: async () => "expired" as const,
    seatStateRead: async () => ({ status: "absent" as const }),
    ...over,
  };
}

let n = 0;
const args = (seats: number[], over: Record<string, unknown> = {}) => ({
  eventId: `e0000000-0000-4000-8000-00000000${String(++n).padStart(4, "0")}`, seriesId: "s0000000-0000-4000-8000-0000000005e5",
  seats, planDigest: DIGEST, series: { swarmManifestRef: "aa".repeat(32), seating, payment },
  contract: LEDGER2, seatCap: { sawLiveSupply: () => {}, cap: () => 30 }, clientKey: `client-${n}`, ip: "203.0.113.7",
  feedSigner: `0x${"fe".repeat(20)}`, ...over,
});

test("a hold answers with each seat's pinned price and the total checkout will charge", async () => {
  // Two bands: seat 0's band and a seat in another band.
  const other = plan.seats.findIndex((s) => s.b !== plan.seats[0].b);
  const seats = [0, other].sort((a, b) => a - b);
  const r = await mod.reserveSeated(args(seats), deps());
  assert.equal(r.status, 200);
  const view = (r.body as { data: import("@woco/shared/seating/reserve").SeatedHold }).data;
  const prices = seats.map((k) => Math.round(parseFloat(seating.bands[plan.seats[k].b].price) * 100));
  const want = cardOrderAmountsMulti(payment, prices);
  assert.deepEqual(view.seats.map((s) => s.priceMinor), prices);
  assert.deepEqual(view.seats.map((s) => s.chargeMinor), want.chargeMinor);
  assert.equal(view.amounts.totalMinor, want.totalMinor);
  assert.equal(view.amounts.orderFeeMinor, want.orderFeeMinor);
  assert.equal(view.amounts.currency, "GBP");
  assert.equal(view.checkout, false);
  assert.equal(view.planDigest, DIGEST);
});

test("holding the same seats again: the same hold while its prices stand, a fresh one at the feed's new prices or fees", async () => {
  const a = args([2]);
  const id = (r: { body: unknown }) => (r.body as { data: { reservationId: string } }).data.reservationId;
  const total = (r: { body: unknown }) => (r.body as { data: { amounts: { totalMinor: number } } }).data.amounts.totalMinor;
  const first = await mod.reserveSeated(a, deps());
  const same = await mod.reserveSeated(a, deps());
  assert.equal(id(same), id(first));
  // A re-signed feed lists its lowest band as the "from" price.
  const dearer = { bands: seating.bands.map((b) => ({ ...b, price: "40.00" })) };
  const repriced = await mod.reserveSeated({ ...a, series: { ...a.series, seating: dearer, payment: { ...payment, price: "40.00" } } }, deps());
  assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
  assert.notEqual(id(repriced), id(first), "not the hold priced the old way");
  assert.ok(total(repriced) > total(first));
  const percent = { ...payment, price: "40.00", coverFees: undefined, buyerFeePercent: 10 } as PaymentConfig;
  const refeed = await mod.reserveSeated({ ...a, series: { ...a.series, seating: dearer, payment: percent } }, deps());
  assert.notEqual(id(refeed), id(repriced), "the fee settings changed");
});

test("anything that could not mint is refused before any read", async () => {
  const noRead = { pinnedSeatPlan: async () => { throw new Error("no read"); } };
  for (const [why, a, d] of [
    ["not ledger2", args([1], { contract: { ...LEDGER2, version: "ledger" } }), deps(noRead)],
    ["no registration of ours", args([1]), deps({ ...noRead, lookupOnChainEventId: () => null })],
    ["no card payments", args([1], { series: { swarmManifestRef: "aa".repeat(32), seating, payment: { ...payment, stripeEnabled: false } } }), deps(noRead)],
  ] as const) {
    const r = await mod.reserveSeated(a as never, d as never);
    assert.equal(r.status, 409, why);
  }
});

test("a plan other than the pin says so; an unreadable chain is a 503 that holds nothing", async () => {
  const changed = await mod.reserveSeated(args([1]), deps({ pinnedSeatPlan: async () => ({ ok: false, status: 409, error: "changed" }) }));
  assert.equal(changed.status, 409);
  assert.equal((changed.body as { code?: string }).code, "PLAN_CHANGED");
  const down = await mod.reserveSeated(args([1]), deps({ readSeatChain: async () => { throw new Error("rpc down"); } }));
  assert.equal(down.status, 503);
});

test("the organiser's seat state is the hold check's: a held seat conflicts, a confirmed freed seat sells, unreadable is a 503", async () => {
  const { buildSeatState } = await import("@woco/shared/seating/state");
  const a = args([1, 2]);
  const seen: unknown[] = [];
  const state = buildSeatState({
    eventId: a.eventId, planDigest: DIGEST, seats: plan.seats.length, holds: new Map([[2, "press"]]),
    confirmed: new Map([[1, 3]]), seq: 2, updatedAt: "2026-11-04T00:00:00Z",
  });
  const freedChain = async (_c: unknown, _id: string, seats: readonly number[]) => ({ ...chain([...seats]), nonces: new Map(seats.map((k) => [k, k === 1 ? 3n : 0n])) });
  const held = await mod.reserveSeated(a, deps({
    readSeatChain: freedChain,
    seatStateRead: async (x) => { seen.push(x); return { status: "found", state }; },
  }));
  assert.equal(held.status, 409);
  assert.deepEqual((held.body as { conflicts?: number[] }).conflicts, [2], "seat 2 is a press hold; seat 1 was freed and confirmed at 3");
  assert.deepEqual(seen, [{ eventId: a.eventId, signer: a.feedSigner, planDigest: DIGEST, seats: plan.seats.length }], "read under the carrier's signer");
  const ok = await mod.reserveSeated(args([1]), deps({ readSeatChain: freedChain, seatStateRead: async () => ({ status: "found", state: { ...state, eventId: "x" } }) }));
  assert.equal(ok.status, 200, "the gate already bound the state to the event: the reserve uses what it is given");
  const unconfirmed = await mod.reserveSeated(args([1]), deps({ readSeatChain: freedChain }));
  assert.equal(unconfirmed.status, 409, "no state: a freed seat waits for the organiser");
  const down = await mod.reserveSeated(args([1]), deps({ seatStateRead: async () => ({ status: "unavailable", reason: "x" }) }));
  assert.equal(down.status, 503);
});

test("a conflict comes back with the seats to mark", async () => {
  const r = await mod.reserveSeated(args([1, 2]), deps({ mintedSeats: () => new Set([2]) }));
  assert.equal(r.status, 409);
  assert.deepEqual((r.body as { conflicts?: number[] }).conflicts, [2]);
});

test("releasing a hold that is not there is ok (idempotent; paid/unreachable: seating-holds-store.test.ts)", async () => {
  assert.equal((await mod.releaseSeated("no-such-hold", async () => "error")).status, 200);
});
