/**
 * One ticket type in the door pack (pack-series.ts). Seated is decided by the
 * registration record AND the ledger's isSeated together; a disagreement sends the
 * type as seated with no seats, which the scanner refuses, and turns health red.
 * Seats decide admission; labels are display and may be missing.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NO_SEAT_INDEX } from "@woco/shared";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { freezeSeatPlan, ticketSeatOf } from "@woco/shared/seating/plan";
import type { EventContractTarget } from "../src/lib/chain/event-contract.js";
import { clearDoorSeatsHealth, doorSeatsHealth, packSeries, type PackSeriesDeps } from "../src/lib/checkin/pack-series.js";
import type { SlotStates } from "../src/lib/checkin/slot-state.js";

beforeEach(() => clearDoorSeatsHealth());

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
const LEDGER2: EventContractTarget = { chainId: 42161, address: "0x" + "5c".repeat(20), version: "ledger2" };
const OLD: EventContractTarget = { chainId: 42161, address: "0x" + "11".repeat(20), version: "ledger" };
const A = "0x" + "aa".repeat(20);
const SERIES = { seriesId: "s1", name: "Reserved", totalSupply: 4, onChainEventId: "0x" + "7e".repeat(32), swarmManifestRef: "b".repeat(64) };

function deps(over: Partial<PackSeriesDeps> & { states?: Partial<SlotStates>; pin?: boolean } = {}) {
  const asked: Array<{ seats: boolean }> = [];
  const d: PackSeriesDeps = {
    contractFor: () => LEDGER2,
    seatingFor: () => (over.pin === false ? null : { planDigest: "0xabc" }),
    nextSlot: async () => 3,
    slotStates: async (_c, _id, _n, opts) => {
      asked.push({ seats: opts.seats });
      return { owners: [A, A, A], seats: opts.seats ? [0, NO_SEAT_INDEX, null] : [], seated: true, ...over.states };
    },
    slotOwners: async () => [A, A, A],
    voidedSlots: () => [],
    plan: async () => ({ ok: true, plan }),
    ...over,
  };
  return { d, asked };
}

test("seated on both sides: seats per slot and labels from the registered plan", async () => {
  const { d, asked } = deps();
  const s = await packSeries("ev", SERIES, d);
  assert.equal(s.seated, true);
  assert.deepEqual(s.seats, [0, NO_SEAT_INDEX, null]);
  assert.deepEqual(s.seatLabels, [ticketSeatOf(plan, 0), null, null]);
  assert.deepEqual(asked, [{ seats: true }]);
  assert.equal(doorSeatsHealth().ok, true);
});

test("general admission on both sides: no seat fields, no seat reads", async () => {
  const { d, asked } = deps({ pin: false, states: { seated: false } });
  const s = await packSeries("ev", SERIES, d);
  assert.equal(s.seated, undefined);
  assert.equal(s.seats, undefined);
  assert.deepEqual(asked, [{ seats: false }]);
});

test("ledger seated, record not (an older build dropped the fields): seated with NO seats, health red", async () => {
  const { d } = deps({ pin: false, states: { seated: true } });
  const s = await packSeries("ev", SERIES, d);
  assert.equal(s.seated, true);
  assert.equal(s.seats, undefined, "a scanner refuses a seated type with no seats");
  assert.equal(doorSeatsHealth().ok, false);
  assert.equal(doorSeatsHealth().disagreements, 1);
});

test("record seated, ledger not: refused the same way", async () => {
  const { d } = deps({ states: { seated: false } });
  const s = await packSeries("ev", SERIES, d);
  assert.equal(s.seated, true);
  assert.equal(s.seats, undefined);
  assert.equal(doorSeatsHealth().ok, false);
});

test("a repaired record clears the alarm on the next pack", async () => {
  await packSeries("ev", SERIES, deps({ states: { seated: false } }).d);
  assert.equal(doorSeatsHealth().ok, false);
  await packSeries("ev", SERIES, deps().d);
  assert.equal(doorSeatsHealth().ok, true);
});

test("isSeated unreadable: the record decides", async () => {
  const seated = await packSeries("ev", SERIES, deps({ states: { seated: null } }).d);
  assert.deepEqual(seated.seats, [0, NO_SEAT_INDEX, null]);
  const ga = await packSeries("ev", SERIES, deps({ pin: false, states: { seated: null } }).d);
  assert.equal(ga.seated, undefined);
  assert.equal(doorSeatsHealth().ok, true);
});

test("a plan that cannot be read leaves labels out; seats still decide", async () => {
  const s = await packSeries("ev", SERIES, deps({ plan: async () => ({ ok: false, status: 503, error: "x" }) }).d);
  assert.deepEqual(s.seats, [0, NO_SEAT_INDEX, null]);
  assert.equal(s.seatLabels, undefined);
  const thrown = await packSeries("ev", SERIES, deps({ plan: async () => { throw new Error("down"); } }).d);
  assert.equal(thrown.seatLabels, undefined);
});

test("a seated record on a contract with no seats is refused, never read as general admission", async () => {
  const s = await packSeries("ev", SERIES, deps({ contractFor: () => OLD }).d);
  assert.equal(s.seated, true);
  assert.equal(s.seats, undefined);
  assert.equal(doorSeatsHealth().ok, false);
});

test("older contracts keep the owner reader; refunds listed on every path", async () => {
  const s = await packSeries("ev", SERIES, deps({ contractFor: () => OLD, pin: false, voidedSlots: () => [1] }).d);
  assert.deepEqual(s.slotOwners, [A, A, A]);
  assert.deepEqual(s.voidSlots, [1]);
  const seated = await packSeries("ev", SERIES, deps({ voidedSlots: () => [2] }).d);
  assert.deepEqual(seated.voidSlots, [2]);
});

test("an event that could not be read hands the readers no slot count", async () => {
  let seen: number | null | undefined;
  const { d } = deps({ nextSlot: async () => { throw new Error("rpc"); }, slotStates: async (_c, _i, n) => { seen = n; return { owners: [], seats: [], seated: true }; } });
  await packSeries("ev", SERIES, d);
  assert.equal(seen, null);
});

test("a type not registered on chain carries nothing to verify with", async () => {
  const s = await packSeries("ev", { ...SERIES, onChainEventId: undefined }, deps().d);
  assert.deepEqual(s, { seriesId: "s1", name: "Reserved", totalSupply: 4 });
});
