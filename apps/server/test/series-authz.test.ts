/**
 * Approve/reject carry two identifiers and only ever checked one (#178).
 *
 * The endpoints proved the caller owned the EVENT in the URL, then acted on the
 * SERIES in the URL. Nothing joined them, so an organiser could authorise
 * against an event of their own — free to create — and approve or reject pending
 * claims on anybody else's. Series ids are public: they are in the event feed
 * and in claim URLs.
 *
 * The crossed-identifier case is the third test here. The rest exist because the
 * obvious fix has two ways to be silently wrong: naming a field that does not
 * exist (fails every request — an outage, not a weaker guard), and returning 404
 * for the crossed case (turns the endpoint into an existence oracle for other
 * organisers' series ids).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";

import { authorizeSeriesAction } from "../src/lib/event/series-authz.js";

const ORGANISER = "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA";
const OTHER_ORGANISER = "0xbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBb";

/** Only the fields the decision reads; the rest of EventFeed is irrelevant. */
function eventWith(creator: string, seriesIds: string[]): EventFeed {
  return {
    creatorAddress: creator,
    series: seriesIds.map((seriesId) => ({ seriesId })),
  } as unknown as EventFeed;
}

test("the organiser may act on a series that belongs to their own event", () => {
  const event = eventWith(ORGANISER, ["series-own-1", "series-own-2"]);
  assert.deepEqual(authorizeSeriesAction(event, "series-own-2", ORGANISER, "approve"), { ok: true });
});

test("address comparison is case-insensitive, so checksummed input still passes", () => {
  // getEventForOwner returns the feed's checksummed creatorAddress while
  // parentAddress arrives lowercased from the auth middleware.
  const event = eventWith(ORGANISER, ["series-own-1"]);
  const res = authorizeSeriesAction(event, "series-own-1", ORGANISER.toLowerCase(), "approve");
  assert.deepEqual(res, { ok: true });
});

test("an event you own does not authorise a series you do not own", () => {
  // A second organiser publishes an event of their own — costs nothing, and
  // they genuinely own it, so the creatorAddress check passes. They then name a
  // seriesId belonging to someone else.
  const ownEvent = eventWith(OTHER_ORGANISER, ["own-series"]);
  const res = authorizeSeriesAction(ownEvent, "other-series", OTHER_ORGANISER, "approve");

  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.status, 403);
  assert.match(res.ok === false ? res.error : "", /does not belong to this event/);
});

test("the crossed case is 403, never 404 — it must not be an existence oracle", () => {
  // 404 would distinguish "this series id is real but not yours" from other
  // failures, letting a caller enumerate other organisers' series ids.
  const event = eventWith(OTHER_ORGANISER, ["own-series"]);
  const real = authorizeSeriesAction(event, "other-real-series", OTHER_ORGANISER, "reject");
  const fake = authorizeSeriesAction(event, "no-such-series-anywhere", OTHER_ORGANISER, "reject");

  assert.equal(real.ok === false && real.status, 403);
  assert.equal(fake.ok === false && fake.status, 403);
  assert.deepEqual(real, fake, "the two cases must be indistinguishable to the caller");
});

test("a non-owner is refused even when the series does belong to the event", () => {
  const otherEvent = eventWith(ORGANISER, ["other-series"]);
  const res = authorizeSeriesAction(otherEvent, "other-series", OTHER_ORGANISER, "approve");

  assert.equal(res.ok === false && res.status, 403);
  assert.match(res.ok === false ? res.error : "", /Only the event organizer/);
});

test("an unresolvable event is 404 and never reaches the series check", () => {
  const res = authorizeSeriesAction(null, "any-series", OTHER_ORGANISER, "approve");
  assert.equal(res.ok === false && res.status, 404);
  assert.match(res.ok === false ? res.error : "", /Event not found/);
});

test("the guard reads `series`, the field EventFeed actually has", () => {
  // The fix proposed in #178 used `event.ticketSeries?.some(...)`. EventFeed has
  // no such field, so that expression is undefined -> falsy -> the guard fires on
  // EVERY request and no approval can ever succeed. This pins the real field: a
  // valid, owned series must be allowed through.
  const event = eventWith(ORGANISER, ["series-own-1"]);
  assert.equal("series" in event, true);
  assert.equal("ticketSeries" in event, false);
  assert.deepEqual(authorizeSeriesAction(event, "series-own-1", ORGANISER, "approve"), { ok: true });
});

test("the action name reaches the message, so approve and reject read correctly", () => {
  const event = eventWith(ORGANISER, ["series-own-1"]);
  const approve = authorizeSeriesAction(event, "series-own-1", OTHER_ORGANISER, "approve");
  const reject = authorizeSeriesAction(event, "series-own-1", OTHER_ORGANISER, "reject");

  assert.match(approve.ok === false ? approve.error : "", /can approve claims/);
  assert.match(reject.ok === false ? reject.error : "", /can reject claims/);
});
