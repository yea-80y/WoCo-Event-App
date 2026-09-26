/**
 * The cancellation notice template (#644): what the organiser starts from.
 * Owner copy rules: spaced " - ", never an em dash.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cancellationNoticeTemplate } from "../src/lib/creator/dashboard/cancellation-notice.js";

test("names the event and date, promises a full refund, and asks the organiser to add their words", () => {
  const t = cancellationNoticeTemplate({ title: "Rooftop Night", startDate: "2026-10-10T19:00:00Z" }, "en-GB");
  assert.match(t, /Rooftop Night on Saturday,? 10 October 2026 has been cancelled/);
  assert.match(t, /refunded in full, including any booking fee/);
  assert.match(t, /\[Add a few words here/);
  assert.match(t, /no longer be accepted at the door/);
});

test("owner copy: no em dash anywhere", () => {
  assert.ok(!cancellationNoticeTemplate({ title: "X", startDate: "2026-10-10T19:00:00Z" }).includes("\u2014"));
});

test("a missing or bad date leaves the date out rather than printing Invalid Date", () => {
  for (const startDate of ["", "not-a-date"]) {
    const t = cancellationNoticeTemplate({ title: "X", startDate });
    assert.match(t, /^We're very sorry - X has been cancelled\./);
  }
});
