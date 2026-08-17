/**
 * Per-series sale-window gate (#295).
 *
 * The properties pinned: an absent window never blocks (most series have no
 * window at all); a future saleStart holds sales back; a lapsed saleEnd closes
 * them; and a PRESENT-but-unparseable date refuses — the money path refuses
 * what it cannot verify rather than defaulting to allow (#241's stance).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSeriesSaleWindow, seriesSaleMessage } from "../src/lib/event/series-window.js";

const NOW = new Date("2026-08-17T12:00:00Z").getTime();
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

test("no window fields — open (the common case must never block)", () => {
  assert.deepEqual(checkSeriesSaleWindow({}, NOW), { open: true });
  assert.deepEqual(checkSeriesSaleWindow({ saleStart: "", saleEnd: "" }, NOW), { open: true });
});

test("future saleStart holds sales back; a started one does not", () => {
  assert.deepEqual(checkSeriesSaleWindow({ saleStart: iso(NOW + HOUR) }, NOW), {
    open: false,
    reason: "not-yet",
  });
  assert.deepEqual(checkSeriesSaleWindow({ saleStart: iso(NOW - HOUR) }, NOW), { open: true });
  // Boundary: sales open AT saleStart, not a tick after.
  assert.deepEqual(checkSeriesSaleWindow({ saleStart: iso(NOW) }, NOW), { open: true });
});

test("lapsed saleEnd closes sales; a future one does not", () => {
  assert.deepEqual(checkSeriesSaleWindow({ saleEnd: iso(NOW - HOUR) }, NOW), {
    open: false,
    reason: "closed",
  });
  assert.deepEqual(checkSeriesSaleWindow({ saleEnd: iso(NOW + HOUR) }, NOW), { open: true });
  // Boundary: closed AT saleEnd — the instant named is no longer sellable.
  assert.deepEqual(checkSeriesSaleWindow({ saleEnd: iso(NOW) }, NOW), {
    open: false,
    reason: "closed",
  });
});

test("inside a full window is open; either bound violated refuses with its own reason", () => {
  const win = { saleStart: iso(NOW - HOUR), saleEnd: iso(NOW + HOUR) };
  assert.deepEqual(checkSeriesSaleWindow(win, NOW), { open: true });
  assert.equal(checkSeriesSaleWindow(win, NOW - 2 * HOUR).open, false);
  assert.equal(checkSeriesSaleWindow(win, NOW + 2 * HOUR).open, false);
});

test("a present-but-unparseable date refuses — never defaults to allow", () => {
  assert.deepEqual(checkSeriesSaleWindow({ saleStart: "not-a-date" }, NOW), {
    open: false,
    reason: "unparseable",
  });
  assert.deepEqual(checkSeriesSaleWindow({ saleEnd: "soonish" }, NOW), {
    open: false,
    reason: "unparseable",
  });
});

test("every reason has buyer-facing copy", () => {
  for (const reason of ["not-yet", "closed", "unparseable"] as const) {
    assert.ok(seriesSaleMessage(reason).length > 10);
  }
});
