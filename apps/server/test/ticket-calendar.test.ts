/**
 * "Add to calendar" and "Get directions" in the ticket email (lib/ticket/calendar.ts).
 *
 * MUTATION: drop the RFC 5545 escaping or line folding, give the calendar an end
 * before its start, or emit a link without a valid start, and a case goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { googleCalendarUrl, directionsUrl, eventIcs } = await import("../src/lib/ticket/calendar.ts");

const ev = {
  eventId: "abc123",
  title: "Night Market Live",
  startIso: "2026-11-14T22:00:00.000Z",
  endIso: "2026-11-15T04:00:00.000Z",
  location: "The Old Depot, Manchester",
};

test("Google Calendar link carries the title, UTC times and place", () => {
  const u = new URL(googleCalendarUrl(ev)!);
  assert.equal(u.origin + u.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(u.searchParams.get("action"), "TEMPLATE");
  assert.equal(u.searchParams.get("text"), "Night Market Live");
  assert.equal(u.searchParams.get("dates"), "20261114T220000Z/20261115T040000Z");
  assert.equal(u.searchParams.get("location"), "The Old Depot, Manchester");
});

test("no end, or an end before the start: the entry ends when it starts", () => {
  assert.match(googleCalendarUrl({ ...ev, endIso: undefined })!, /dates=20261114T220000Z%2F20261114T220000Z/);
  assert.match(googleCalendarUrl({ ...ev, endIso: "2026-11-14T20:00:00Z" })!, /dates=20261114T220000Z%2F20261114T220000Z/);
});

test("no valid start: no calendar link and no .ics", () => {
  assert.equal(googleCalendarUrl({ ...ev, startIso: undefined }), null);
  assert.equal(googleCalendarUrl({ ...ev, startIso: "soon" }), null);
  assert.equal(eventIcs({ ...ev, startIso: undefined }), null);
});

test("directions search the venue as typed; none without one", () => {
  assert.equal(directionsUrl(ev.location), "https://www.google.com/maps/search/?api=1&query=The%20Old%20Depot%2C%20Manchester");
  assert.equal(directionsUrl("  "), null);
  assert.equal(directionsUrl(undefined), null);
});

test(".ics: one VEVENT, UTC times, escaped text, CRLF, folded at 75 octets", () => {
  const ics = eventIcs(
    { ...ev, title: "Gig; with, commas\nand a newline", location: "Ünïcödé Hall, " + "x".repeat(120) },
    new Date("2026-10-07T12:00:00Z"),
  )!;
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /\r\nUID:abc123@woco-net\.com\r\n/);
  assert.match(ics, /\r\nDTSTAMP:20261007T120000Z\r\n/);
  assert.match(ics, /\r\nDTSTART:20261114T220000Z\r\nDTEND:20261115T040000Z\r\n/);
  assert.match(ics, /SUMMARY:Gig\\; with\\, commas\\nand a newline/);
  for (const line of ics.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `unfolded line: ${line.slice(0, 30)}`);
  }
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, new RegExp(`LOCATION:Ünïcödé Hall\\\\, x{120}`));
});

test("no field can start a line of its own in the .ics (CR, LF or CRLF, title, place or id)", () => {
  const ics = eventIcs({
    ...ev,
    eventId: "abc\r\nATTENDEE:mailto:x@example.com",
    title: "A\rORGANIZER:evil",
    location: "B\nDESCRIPTION:evil\r\nX",
  })!;
  const lines = ics.split("\r\n");
  for (const bad of ["ATTENDEE", "ORGANIZER", "DESCRIPTION", "X"]) {
    assert.ok(!lines.some((l) => l.startsWith(bad)), `${bad} became its own line`);
  }
  assert.ok(!/\r(?!\n)/.test(ics) && !/(?<!\r)\n/.test(ics), "only CRLF line breaks");
  assert.match(ics, /\r\nUID:abcATTENDEEmailtoxexample\.com@woco-net\.com\r\n/);
});
