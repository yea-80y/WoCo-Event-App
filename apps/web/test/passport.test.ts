/**
 * The passport's ticket rules: linked tickets joined to their events, split
 * into upcoming (soonest first) and past (newest first); a ticket whose event
 * is unknown is kept, never dropped; a ticket linked twice appears once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysUntil,
  eventsIndex,
  passportTickets,
  whenLabel,
  type PassportEvent,
} from "../src/lib/attendee/passport/passport.js";

// Local-time dates, so the calendar-day maths holds in any time zone.
const NOW = new Date(2026, 8, 14, 23, 30).getTime();
const at = (month: number, day: number, hour = 22) => new Date(2026, month, day, hour).toISOString();

const event = (title: string, startDate: string): PassportEvent => ({ title, startDate, location: "Leeds" });
const binding = (eventId: string, edition: number, seriesId = `${eventId}-s`) => ({
  eventId,
  seriesId,
  edition,
  boundAt: at(8, 1),
});

test("tickets split into upcoming soonest first and past newest first", () => {
  const events = {
    late: event("Late", at(9, 3)),
    soon: event("Soon", at(8, 19)),
    old: event("Old", at(7, 1)),
    older: event("Older", at(6, 1)),
  };
  const result = passportTickets(
    [binding("late", 1), binding("older", 2), binding("soon", 3), binding("old", 4)],
    events,
    NOW,
  );
  assert.deepEqual(result.upcoming.map((t) => t.eventId), ["soon", "late"]);
  assert.deepEqual(result.past.map((t) => t.eventId), ["old", "older"]);
  assert.deepEqual(result.unknown, []);
});

test("a ticket whose event is not known is kept, not dropped", () => {
  const result = passportTickets([binding("missing", 7)], {}, NOW);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].edition, 7);
  assert.equal(result.unknown[0].event, null);
});

test("an event with an unreadable start date is treated as unknown", () => {
  const result = passportTickets([binding("broken", 1)], { broken: event("Broken", "not a date") }, NOW);
  assert.deepEqual(result.upcoming, []);
  assert.equal(result.unknown.length, 1);
});

test("the same ticket linked twice appears once", () => {
  const events = { soon: event("Soon", at(8, 19)) };
  const result = passportTickets([binding("soon", 3), binding("soon", 3)], events, NOW);
  assert.equal(result.upcoming.length, 1);
});

test("two tickets for the same event are both kept", () => {
  const events = { soon: event("Soon", at(8, 19)) };
  const result = passportTickets([binding("soon", 3), binding("soon", 4)], events, NOW);
  assert.equal(result.upcoming.length, 2);
});

test("event details come from the directory first, then an event's own record", () => {
  const listed = { eventId: "a", title: "From the directory", startDate: at(8, 19), location: "Leeds" };
  const ownRecordA = { eventId: "a", title: "From its record", startDate: at(8, 19), location: "Leeds" };
  const unlisted = { eventId: "b", title: "Unlisted", startDate: at(9, 1), location: "York" };
  const index = eventsIndex(["a", "b"], [listed], [ownRecordA, null, unlisted]);
  assert.equal(index.a.title, "From the directory");
  assert.equal(index.b.title, "Unlisted");
});

test("details for events the member holds no ticket for are left out", () => {
  const other = { eventId: "z", title: "Someone else's", startDate: at(8, 19), location: "Hull" };
  assert.deepEqual(eventsIndex(["a"], [other], [other]), {});
});

test("days until counts calendar days, not 24-hour blocks", () => {
  // 23:30 today to 01:00 tomorrow is ninety minutes but one calendar day.
  assert.equal(daysUntil(new Date(2026, 8, 15, 1, 0).toISOString(), NOW), 1);
  assert.equal(daysUntil(new Date(2026, 8, 14, 23, 59).toISOString(), NOW), 0);
  assert.equal(daysUntil(at(8, 19), NOW), 5);
  assert.equal(daysUntil(at(8, 10), NOW), -4);
  assert.equal(daysUntil("not a date", NOW), null);
});

test("the when label reads as a person would say it", () => {
  assert.equal(whenLabel(0), "Today");
  assert.equal(whenLabel(1), "Tomorrow");
  assert.equal(whenLabel(5), "In 5 days");
  assert.equal(whenLabel(-1), null);
  assert.equal(whenLabel(null), null);
});
