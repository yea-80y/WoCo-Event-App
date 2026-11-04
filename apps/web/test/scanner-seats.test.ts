/**
 * The door and allocated seating (docs/SEATING.md "Door + tickets").
 *
 * Order of checks is the property, as for refunds: owner and signature FIRST, then
 * the refund list, then the seat. A forged QR for a seatless slot reads invalid; a
 * refunded seat reads refunded (the money fact is the useful one); a genuine ticket
 * with no seat now is refused as "no seat" and consumes no check-in. The seat decides,
 * its label is display: a missing label never refuses. A list that could not read a
 * ticket (owner or seat), or has no seats for a seated type, is never red.
 *
 * Real signatures from real burner keys, verified by the real verifier.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildTicketCanonicalMessage, NO_SEAT_INDEX, type CheckinPack, type CheckinSeries } from "@woco/shared";
import type { TicketSeat } from "@woco/shared/seating/ticket-seat";
import { doorSeat, SEATS_MISSING_REASON, UNREAD_REASON, verifyTicket } from "../src/lib/scanner/verify.js";
import { resolveMiss } from "../src/lib/scanner/pack-refresh.js";

const EVENT_ID = "evt-seated-door";
const SERIES_ID = "ser-seated";
const ON_CHAIN_EVENT_ID = ("0x" + "cd".repeat(32)) as `0x${string}`;
const burners = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
const stranger = privateKeyToAccount(generatePrivateKey());
const D7: TicketSeat = { area: "Stalls", row: "D", seat: 7 };
const W1: TicketSeat = { area: "Stalls", row: "A", seat: 1, wheelchair: true };

async function qr(edition: number, signer = burners[edition - 1]): Promise<string> {
  const sig = await signer.signMessage({
    message: buildTicketCanonicalMessage({ onChainEventId: ON_CHAIN_EVENT_ID, seriesId: SERIES_ID, edition }),
  });
  return `woco://t/${EVENT_ID}/${SERIES_ID}/${edition}/${sig}`;
}

/** Slots: 1 = D7, 2 = no seat, 3 = seat unread, 4 = W1 with no label. */
function series(over: Partial<CheckinSeries> = {}): CheckinSeries {
  return {
    seriesId: SERIES_ID,
    name: "Reserved",
    totalSupply: 10,
    onChainEventId: ON_CHAIN_EVENT_ID,
    slotOwners: burners.map((b) => b.address.toLowerCase()),
    seated: true,
    seats: [12, NO_SEAT_INDEX, null, 0],
    seatLabels: [D7, null, null, null],
    ...over,
  };
}
const pack = (s: CheckinSeries): CheckinPack => ({
  v: 2, eventId: EVENT_ID, eventTitle: "Seated door", series: [s], checkins: [], generatedAt: "2026-11-04T00:00:00.000Z",
});

test("a seated ticket in its seat admits, carrying the seat as printed", async () => {
  const v = await verifyTicket(await qr(1), pack(series()));
  assert.equal(v.status, "valid");
  assert.deepEqual(v.status === "valid" && v.seat, D7);
});

test("a genuine ticket the ledger shows with no seat reads no-seat, not valid", async () => {
  const v = await verifyTicket(await qr(2), pack(series()));
  assert.equal(v.status, "no-seat");
});

test("a FORGED ticket for a seatless slot reads invalid, never no-seat", async () => {
  const v = await verifyTicket(await qr(2, stranger), pack(series()));
  assert.equal(v.status, "invalid");
  assert.equal(v.status === "invalid" && v.code, undefined, "a bad signature is no list miss");
});

test("refunded wins over no seat", async () => {
  const v = await verifyTicket(await qr(2), pack(series({ voidSlots: [1] })));
  assert.equal(v.status, "refunded");
});

test("a seat the list could not read is an unread miss, never valid or red", async () => {
  const v = await verifyTicket(await qr(3), pack(series()));
  assert.equal(v.status, "invalid");
  assert.equal(v.status === "invalid" && v.code, "unread");
  assert.equal(v.status === "invalid" && v.reason, UNREAD_REASON);
});

test("a seated type with no seats in the list (out of date, or disagreeing) admits nothing", async () => {
  const v = await verifyTicket(await qr(1), pack(series({ seats: undefined, seatLabels: undefined })));
  assert.equal(v.status === "invalid" && v.code, "unread");
  assert.equal(v.status === "invalid" && v.reason, SEATS_MISSING_REASON);
});

test("a missing label never refuses: the seat decides, the label is null", async () => {
  const v = await verifyTicket(await qr(4), pack(series()));
  assert.equal(v.status, "valid");
  assert.equal(v.status === "valid" && v.seat, null);
});

test("an owner the list could not read is an unread miss, before any signature work", async () => {
  const owners = burners.map((b) => b.address.toLowerCase()) as (string | null)[];
  owners[0] = null;
  const v = await verifyTicket(await qr(1, stranger), pack(series({ slotOwners: owners })));
  assert.equal(v.status === "invalid" && v.code, "unread");
});

test("general admission is untouched: no seat field on the verdict", async () => {
  const v = await verifyTicket(await qr(1), pack(series({ seated: undefined, seats: undefined, seatLabels: undefined })));
  assert.equal(v.status, "valid");
  assert.equal(v.status === "valid" && "seat" in v, false);
});

test("doorSeat: the rule the roster's manual check-in shares", () => {
  assert.deepEqual(doorSeat(series(), 1), { kind: "seat", seat: D7 });
  assert.deepEqual(doorSeat(series(), 2), { kind: "no-seat" });
  assert.deepEqual(doorSeat(series(), 3), { kind: "unread", reason: UNREAD_REASON });
  assert.deepEqual(doorSeat(series(), 9), { kind: "unread", reason: UNREAD_REASON }, "past the list's end");
  assert.deepEqual(doorSeat(series({ seats: undefined }), 1), { kind: "unread", reason: SEATS_MISSING_REASON });
  assert.deepEqual(doorSeat(series({ seated: undefined }), 2), { kind: "unseated" });
  assert.deepEqual(doorSeat(series({ seatLabels: [W1] }), 1), { kind: "seat", seat: W1 });
});

test("an unread miss is 'couldn't confirm' after the re-check, whether or not the list refreshed, never red", async () => {
  const unread = await verifyTicket(await qr(3), pack(series()));
  for (const step of [{ kind: "refreshed" as const }, { kind: "failed" as const }, { kind: "settled" as const }]) {
    const out = await resolveMiss(unread, {
      key: "k",
      firstSeen: new Map([["k", 0]]),
      now: () => 1_000_000,
      recheck: async () => step,
      reverify: async () => unread,
      packAsOf: () => 1_000_000,
    });
    assert.equal(out.kind, "cant-confirm", step.kind);
  }
});

test("an unread miss that a fresher list resolves takes that list's verdict", async () => {
  const unread = await verifyTicket(await qr(3), pack(series()));
  const fresh = await verifyTicket(await qr(3), pack(series({ seats: [12, NO_SEAT_INDEX, 40, 0] })));
  const out = await resolveMiss(unread, {
    key: "k", firstSeen: new Map(), now: () => 1, recheck: async () => ({ kind: "refreshed" }), reverify: async () => fresh, packAsOf: () => 1,
  });
  assert.equal(out.kind === "verdict" && out.verdict.status, "valid");
});
