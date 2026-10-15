/**
 * A ticket type's sale window is the organiser's wall-clock time, stored as one
 * instant (UTC).
 *
 * The picker gives "2026-10-20T20:30" with no zone. It used to go to the server
 * as-is, where a UTC clock read it an hour late for a UK organiser in summer.
 * `localInputToIso` reads it in the organiser's own zone; PublishButton sends
 * that, exactly as it already did for the event's start and end.
 *
 * TZ is set per test: Node re-reads it on change, so one run covers London
 * across both of its 2026 clock changes and New York.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importedSaleBound, localInputToIso, saleWindowError, toLocalInput } from "../src/lib/creator/events/date.ts";

function inZone<T>(tz: string, run: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test("a London summer close is an hour earlier in UTC; a winter one is not", () => {
  inZone("Europe/London", () => {
    assert.equal(localInputToIso("2026-10-20T20:30"), "2026-10-20T19:30:00.000Z");
    assert.equal(localInputToIso("2026-11-20T20:30"), "2026-11-20T20:30:00.000Z");
  });
});

test("New York reads the same wall-clock five or four hours later in UTC", () => {
  inZone("America/New_York", () => {
    assert.equal(localInputToIso("2026-10-20T20:30"), "2026-10-21T00:30:00.000Z");
    assert.equal(localInputToIso("2026-12-20T20:30"), "2026-12-21T01:30:00.000Z");
  });
});

test("local -> UTC -> local round-trips on both sides of each London clock change", () => {
  inZone("Europe/London", () => {
    for (const v of [
      "2026-03-28T23:30", "2026-03-29T00:30", "2026-03-29T03:00", // spring forward 01:00 -> 02:00
      "2026-10-24T23:30", "2026-10-25T00:30", "2026-10-25T03:00", // fall back 02:00 -> 01:00
    ]) {
      const iso = localInputToIso(v);
      assert.ok(iso, v);
      assert.equal(toLocalInput(new Date(iso)), v, v);
    }
  });
});

test("a date-only value is local midnight, not UTC midnight", () => {
  inZone("America/New_York", () => {
    assert.equal(localInputToIso("2026-10-20"), "2026-10-20T04:00:00.000Z");
  });
});

test("impossible dates and times are refused rather than rolled over", () => {
  for (const v of ["2026-02-30T10:00", "2026-10-20T24:00", "2026-10-20T20:60", "20:30", "", "soon"]) {
    assert.equal(localInputToIso(v), null, v);
  }
});

test("imported date-only bounds cover the whole day; timed ones are kept", () => {
  assert.equal(importedSaleBound("2026-10-20", "start"), "2026-10-20T00:00");
  assert.equal(importedSaleBound("2026-10-20", "end"), "2026-10-20T23:59");
  assert.equal(importedSaleBound("2026-10-20T18:00", "end"), "2026-10-20T18:00");
  assert.equal(importedSaleBound(undefined, "start"), "");
});

// ---------------------------------------------------------------------------
// What the organiser is told
// ---------------------------------------------------------------------------

const EVENT_END = "2026-10-20T22:00";

test("no window, or one inside the event, is fine", () => {
  assert.equal(saleWindowError({}, EVENT_END), null);
  assert.equal(saleWindowError({ saleStart: "", saleEnd: "" }, EVENT_END), null);
  assert.equal(saleWindowError({ saleEnd: "2026-10-20T20:30" }, EVENT_END), null);
  assert.equal(saleWindowError({ saleEnd: EVENT_END }, EVENT_END), null, "closing AT the end is allowed");
  assert.equal(saleWindowError({ saleStart: "2026-10-01T09:00", saleEnd: "2026-10-20T20:30" }, EVENT_END), null);
});

test("a close after the event's end is refused, and says why", () => {
  assert.equal(
    saleWindowError({ saleEnd: "2026-10-20T22:01" }, EVENT_END),
    "Sales can't close after the event ends - ticket sales stop when the event ends anyway.",
  );
});

test("a close at or before the open is refused", () => {
  for (const saleEnd of ["2026-10-01T09:00", "2026-09-30T09:00"]) {
    assert.equal(
      saleWindowError({ saleStart: "2026-10-01T09:00", saleEnd }, EVENT_END),
      "Sales must close after they open.",
      saleEnd,
    );
  }
});

test("an open at or after the event's end is refused", () => {
  assert.equal(saleWindowError({ saleStart: EVENT_END }, EVENT_END), "Sales must open before the event ends.");
});

test("an unreadable bound is named", () => {
  assert.match(saleWindowError({ saleStart: "2026-02-30T10:00" }, EVENT_END) ?? "", /time for sales to open/);
  assert.match(saleWindowError({ saleEnd: "garbage" }, EVENT_END) ?? "", /time for sales to close/);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const PUBLISH = readFileSync(new URL("../src/lib/creator/events/PublishButton.svelte", import.meta.url), "utf8");
const EDITOR = readFileSync(new URL("../src/lib/creator/events/TicketSeriesEditor.svelte", import.meta.url), "utf8");
const EVENT_EDITOR = readFileSync(new URL("../src/lib/creator/events/EventEditor.svelte", import.meta.url), "utf8");

test("publish sends each bound converted, never the picker value", () => {
  assert.match(PUBLISH, /saleStart: saleBound\(s\.saleStart\)/);
  assert.match(PUBLISH, /saleEnd: saleBound\(s\.saleEnd\)/);
  assert.doesNotMatch(PUBLISH, /saleStart: s\.saleStart\b/);
  assert.doesNotMatch(PUBLISH, /saleEnd: s\.saleEnd\b/);
  assert.match(PUBLISH, /const iso = localInputToIso\(value\)/);
});

test("publish is blocked by a bad window, and the editor shows it against the event's end", () => {
  assert.match(PUBLISH, /saleWindowError\(s, endDate\)/);
  assert.match(EDITOR, /saleWindowError\(wave, endDate\)/);
  assert.match(EVENT_EDITOR, /<TicketSeriesEditor[^>]*\{endDate\}/);
});
