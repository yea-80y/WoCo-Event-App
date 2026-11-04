/**
 * A ticket's seat as printed (seating/ticket-seat.ts): parts, one sentence form, the
 * labelled fields every surface lays out, and the validator for seats from links and
 * packs. `ticketSeatOf` reads the plan's own label and flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTicketSeat, ticketSeatFields, ticketSeatNote, ticketSeatPlace, ticketSeatText, type TicketSeat,
} from "../../src/seating/ticket-seat.js";
import { formatSeatLabel, freezeSeatPlan, seatLabel, ticketSeatOf } from "../../src/seating/plan.js";
import { LAYOUT_TEMPLATES } from "../../src/seating/templates.js";

const D7: TicketSeat = { area: "Stalls", row: "D", seat: 7 };

test("one sentence, and the place without the number", () => {
  assert.equal(ticketSeatText(D7), "Stalls, Row D, seat 7");
  assert.equal(ticketSeatText({ area: "Table 3", seat: 5, table: true }), "Table 3, seat 5");
  assert.equal(ticketSeatPlace(D7), "Stalls, Row D");
  assert.equal(ticketSeatPlace({ area: "Table 3", seat: 5, table: true }), "Table 3");
});

test("labelled fields in reading order; a table named 'Table N' shows as N", () => {
  assert.deepEqual(ticketSeatFields(D7), [
    { label: "Section", value: "Stalls" }, { label: "Row", value: "D" }, { label: "Seat", value: "7" },
  ]);
  assert.deepEqual(ticketSeatFields({ area: "Table 3", seat: 5, table: true }), [
    { label: "Table", value: "3" }, { label: "Seat", value: "5" },
  ]);
  assert.deepEqual(ticketSeatFields({ area: "table 12", seat: 1, table: true })[0], { label: "Table", value: "12" });
  assert.deepEqual(ticketSeatFields({ area: "Top table", seat: 12, table: true })[0], { label: "Table", value: "Top table" });
  assert.deepEqual(ticketSeatFields({ area: "Table", seat: 1, table: true })[0], { label: "Table", value: "Table" });
  assert.deepEqual(ticketSeatFields({ area: "Box A", seat: 2 }), [{ label: "Section", value: "Box A" }, { label: "Seat", value: "2" }]);
});

test("wheelchair and companion notes; none for an ordinary seat", () => {
  assert.equal(ticketSeatNote({ ...D7, wheelchair: true }), "Wheelchair space");
  assert.equal(ticketSeatNote({ ...D7, companion: true }), "Companion seat");
  assert.equal(ticketSeatNote(D7), null);
});

test("the validator takes exactly a seat and nothing else", () => {
  assert.equal(isTicketSeat(D7), true);
  assert.equal(isTicketSeat({ area: "Table 3", seat: 5, table: true, wheelchair: true, companion: true }), true);
  for (const bad of [
    null, "Stalls, Row D, seat 7", { area: "Stalls" }, { seat: 7 }, { ...D7, extra: 1 }, { ...D7, seat: 0 },
    { ...D7, seat: 1.5 }, { ...D7, seat: 1_000_000 }, { ...D7, area: "" }, { ...D7, area: " Stalls" },
    { ...D7, area: "a".repeat(81) }, { ...D7, row: "ROWLABELTOOLONG" }, { ...D7, table: false }, { ...D7, wheelchair: "yes" },
    { ...D7, area: "St​alls" },
  ]) assert.equal(isTicketSeat(bad), false, JSON.stringify(bad));
});

test("ticketSeatOf reads the plan's label and its flags; formatSeatLabel is unchanged", () => {
  const plan = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "theatre")!.make());
  for (let k = 0; k < plan.seats.length; k += 37) {
    const s = ticketSeatOf(plan, k)!;
    assert.ok(isTicketSeat(s), `seat ${k}`);
    assert.equal(ticketSeatText(s), formatSeatLabel(seatLabel(plan, k)!));
    assert.equal(!!s.wheelchair, !!plan.seats[k].a);
    assert.equal(!!s.companion, !!plan.seats[k].c);
  }
  const wheel = plan.seats.findIndex((s) => s.a);
  if (wheel >= 0) assert.equal(ticketSeatOf(plan, wheel)!.wheelchair, true);
  assert.equal(ticketSeatOf(plan, plan.seats.length), null);
  const cabaret = freezeSeatPlan(LAYOUT_TEMPLATES.find((t) => t.id === "cabaret")!.make());
  const atTable = ticketSeatOf(cabaret, 0)!;
  assert.equal(atTable.table, true);
  assert.equal(atTable.row, undefined);
  assert.equal(formatSeatLabel({ area: "Stalls", row: "D", seat: 7, atTable: false }), "Stalls, Row D, seat 7");
});
