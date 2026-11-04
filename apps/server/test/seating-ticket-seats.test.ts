/**
 * Where a sold seated ticket sits NOW (lib/seating/ticket-seats.ts), for the #983
 * resend and the passport: the ledger's seatOf labelled from the pinned plan. Anything
 * it cannot read in full is "unreadable" - never a guess, never the seat at mint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_SEAT_INDEX } from "@woco/shared";
import { LAYOUT_TEMPLATES } from "@woco/shared/seating/templates";
import { freezeSeatPlan, ticketSeatOf } from "@woco/shared/seating/plan";
import type { EventContractTarget } from "../src/lib/chain/event-contract.js";
import { currentTicketSeats, type TicketSeatsDeps } from "../src/lib/seating/ticket-seats.js";

const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
const LEDGER2: EventContractTarget = { chainId: 42161, address: "0x" + "5c".repeat(20), version: "ledger2" };
const A = { eventId: "ev", seriesId: "s", onChainEventId: "0x" + "7e".repeat(32), swarmManifestRef: "b".repeat(64), slots: [0, 1] };

function deps(over: Partial<TicketSeatsDeps> = {}): TicketSeatsDeps {
  return {
    seatingFor: () => ({ planDigest: "0xabc" }),
    contractFor: () => LEDGER2,
    seatIndexes: async (_c, _id, slots) => new Map(slots.map((s) => [s, s === 1 ? NO_SEAT_INDEX : 40 + s])),
    plan: async () => ({ ok: true, plan }),
    ...over,
  };
}

test("each slot's seat now, labelled from the plan; a seatless ticket reads 'none'", async () => {
  const r = await currentTicketSeats(A, deps());
  assert.equal(r.kind, "seats");
  assert.ok(r.kind === "seats");
  assert.deepEqual(r.seats.get(0), ticketSeatOf(plan, 40));
  assert.equal(r.seats.get(1), "none");
});

test("general admission is unseated: nothing is read", async () => {
  let read = false;
  const r = await currentTicketSeats(A, deps({ seatingFor: () => null, seatIndexes: async () => { read = true; return new Map(); } }));
  assert.deepEqual(r, { kind: "unseated" });
  assert.equal(read, false);
});

test("unreadable, never a guess: no contract, an older contract, a failed read, a missing slot, no plan, a seat off the plan", async () => {
  const cases: Array<[string, Partial<TicketSeatsDeps>]> = [
    ["no contract", { contractFor: () => undefined }],
    ["older contract", { contractFor: () => ({ ...LEDGER2, version: "ledger" }) }],
    ["read throws", { seatIndexes: async () => { throw new Error("rpc"); } }],
    ["a slot missing", { seatIndexes: async () => new Map([[0, 40]]) }],
    ["plan unreadable", { plan: async () => ({ ok: false, status: 503, error: "x" }) }],
    ["plan throws", { plan: async () => { throw new Error("swarm"); } }],
    ["seat off the plan", { seatIndexes: async (_c, _i, slots) => new Map(slots.map((s) => [s, plan.seats.length + 5])) }],
  ];
  for (const [name, over] of cases) assert.deepEqual(await currentTicketSeats(A, deps(over)), { kind: "unreadable" }, name);
});
