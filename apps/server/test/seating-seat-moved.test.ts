/**
 * "Your seat has changed" (lib/seating/seat-moved.ts, routes/tickets.ts
 * sendSeatChangedEmail): only that sale's buyer, never an erased one, only the event's
 * recorded organiser, the seat the ledger has now, no ticket or code in the email.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TicketSeat } from "@woco/shared/seating/ticket-seat";
import { seatMoved, seatMovedState, type SeatMovedDeps } from "../src/lib/seating/seat-moved.js";

const ORG = "0x00000000000000000000000000000000000000c0";
const ID = `0x${"0a".repeat(32)}`;
const D7: TicketSeat = { area: "Stalls", row: "D", seat: 7 };
const D8: TicketSeat = { area: "Stalls", row: "D", seat: 8 };

function deps(over: Partial<SeatMovedDeps> = {}) {
  const mails: Array<{ to: string; seats: unknown }> = [];
  let seats = new Map<number, TicketSeat | "none">([[0, D7], [1, D8], [2, "none"]]);
  const d: SeatMovedDeps = {
    recordedCreator: () => ORG,
    seatedAllowed: () => true,
    event: async () => ({ title: "Gig", series: [{ seriesId: "stalls", onChainEventId: ID }] }),
    saleOf: (_e, _s, _id, slot) =>
      slot === 0 || slot === 1 || slot === 2 ? { sessionId: "cs_1", orderRef: "ref1" }
      : slot === 3 ? { sessionId: "cs_2", orderRef: "ref2" }
      : slot === 4 ? { sessionId: "cs_3", orderRef: "ref3", resends: [{ toHash: "h:new@example.com", accepted: true }] }
      : null,
    order: (ref) => (ref === "ref1" ? { emailHash: "h:buyer@example.com", erased: false } : ref === "ref2" ? { emailHash: "h:buyer@example.com", erased: true } : { emailHash: "h:typo@example.con", erased: false }),
    hashEmail: (e) => `h:${e.toLowerCase()}`,
    currentSeats: async (a) => ({ kind: "seats", seats: new Map(a.slots.map((s) => [s, seats.get(s) ?? D7])) }),
    send: async (a) => void mails.push({ to: a.to, seats: a.seats }),
    now: () => 1_000_000,
    ...over,
  };
  return { d, mails, setSeats: (m: Map<number, TicketSeat | "none">) => (seats = m) };
}
const body = (slots: number[], to = "buyer@example.com") => ({ seriesId: "stalls", slots, to });

test("off with the flag, and only for the event's recorded organiser", async () => {
  const { d } = deps({ seatedAllowed: () => false });
  assert.equal((await seatMoved(d, seatMovedState(), "e1", ORG, body([0]))).status, 404);
  const other = deps();
  assert.equal((await seatMoved(other.d, seatMovedState(), "e1", "0x00000000000000000000000000000000000000ee", body([0]))).status, 403);
  assert.equal((await seatMoved(deps({ recordedCreator: () => null }).d, seatMovedState(), "e1", ORG, body([0]))).status, 403);
});

test("bad requests", async () => {
  const { d } = deps();
  for (const b of [body([]), body([0, 0]), body([-1]), { ...body([0]), seriesId: "a/b" }, body([0], "not an email")]) {
    assert.equal((await seatMoved(d, seatMovedState(), "e1", ORG, b)).status, 400, JSON.stringify(b));
  }
});

test("only that sale's buyer, never an erased order; a resend's address counts", async () => {
  const { d, mails } = deps();
  const r = await seatMoved(d, seatMovedState(), "e1", ORG, body([0, 1, 2, 3, 9]));
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.data.slots, [
    { slot: 0, outcome: "sent" }, { slot: 1, outcome: "sent" }, { slot: 2, outcome: "no_seat" },
    { slot: 3, outcome: "erased" }, { slot: 9, outcome: "not_sold" },
  ]);
  assert.deepEqual(mails, [{ to: "buyer@example.com", seats: [{ edition: 1, seat: D7 }, { edition: 2, seat: D8 }] }], "one email, the seats now");
  const someoneElse = await seatMoved(d, seatMovedState(), "e1", ORG, body([0], "other@example.com"));
  assert.deepEqual(someoneElse.ok && someoneElse.data.slots, [{ slot: 0, outcome: "not_this_buyer" }]);
  const resent = await seatMoved(d, seatMovedState(), "e1", ORG, body([4], "new@example.com"));
  assert.deepEqual(resent.ok && resent.data.slots, [{ slot: 4, outcome: "sent" }]);
});

test("once per ticket and seat a day; a seat changed again is mailed again", async () => {
  const h = deps();
  const st = seatMovedState();
  await seatMoved(h.d, st, "e1", ORG, body([0]));
  const again = await seatMoved(h.d, st, "e1", ORG, body([0]));
  assert.deepEqual(again.ok && again.data.slots, [{ slot: 0, outcome: "already_sent" }]);
  h.setSeats(new Map([[0, D8]]));
  const moved = await seatMoved(h.d, st, "e1", ORG, body([0]));
  assert.deepEqual(moved.ok && moved.data.slots, [{ slot: 0, outcome: "sent" }]);
  assert.equal(h.mails.length, 2);
});

test("seats unreadable is a 503 that sends nothing; a failed send is not remembered", async () => {
  const down = deps({ currentSeats: async () => ({ kind: "unreadable" }) });
  assert.equal((await seatMoved(down.d, seatMovedState(), "e1", ORG, body([0]))).status, 503);
  assert.equal(down.mails.length, 0);
  let fail = true;
  const flaky = deps({ send: async () => { if (fail) throw new Error("ses"); } });
  const st = seatMovedState();
  assert.equal((await seatMoved(flaky.d, st, "e1", ORG, body([0]))).status, 502);
  fail = false;
  const r = await seatMoved(flaky.d, st, "e1", ORG, body([0]));
  assert.deepEqual(r.ok && r.data.slots, [{ slot: 0, outcome: "sent" }]);
});

test("per-account barrier", async () => {
  const st = seatMovedState();
  let n = 0;
  const h = deps({ currentSeats: async (a) => ({ kind: "seats", seats: new Map(a.slots.map((s) => [s, { area: "Stalls", row: "A", seat: ++n }])) }) });
  for (let i = 0; i < 60; i++) assert.equal((await seatMoved(h.d, st, "e1", ORG, body([0]))).status, 200);
  assert.equal((await seatMoved(h.d, st, "e1", ORG, body([0]))).status, 429);
});

test("the email: the new seat, the ticket unchanged, nothing that is a ticket", async () => {
  process.env.EMAIL_FROM_ADDRESS ??= "tickets@example.com";
  const { sendSeatChangedEmail } = await import("../src/routes/tickets.js");
  const sent: Array<Record<string, unknown>> = [];
  await sendSeatChangedEmail(
    { to: "buyer@example.com", eventTitle: "Gig <b>", seats: [{ edition: 3, seat: { ...D7, wheelchair: true } as TicketSeat }] },
    (async (m: Record<string, unknown>, o: Record<string, unknown>) => { sent.push({ ...m, ...o }); }) as never,
  );
  const m = sent[0]!;
  assert.equal(m.subject, "Your seat has changed - Gig <b>");
  assert.match(String(m.text), /Ticket 3: Stalls, Row D, seat 7/);
  assert.match(String(m.text), /unchanged/);
  assert.equal(m.attachments, undefined, "no ticket image");
  assert.doesNotMatch(String(m.html), /<b>/, "escaped");
  assert.doesNotMatch(String(m.html) + String(m.text), /\/t[#?]|qr/i, "no ticket link or code");
  assert.equal(m.priority, "transactional");
});
