/**
 * #426 — a feed must identify as the event it was read under.
 *
 * An event feed is fetched at a topic derived from `eventId`, but nothing
 * compared the decoded body's own `eventId` field against it. For a Phase B
 * event that body is the CREATOR's client-signed SOC, so the field is untrusted
 * input, and a creator could mislabel their own feed.
 *
 * Why it matters: `applyOnChainEventIds` keys BOTH its "strip an id the server's
 * record contradicts" check and its tier-3 record write on `feed.eventId`
 * (lib/event/onchain-registry.ts). A mislabelled feed misses the lookup, so an
 * id the server knows to be wrong survives into every consumer that is not the
 * checkout — the order counter behind delete-safety, the door scanner's pack,
 * reservations and orders.
 *
 * The comparison is EXACT on purpose. The record lookup is a `Map.get` on
 * `${eventId}|${seriesId}` and so is case-sensitive: a feed self-describing in a
 * different case would pass a case-insensitive check here and still miss the
 * strip, which would leave the defect open while looking fixed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeEventFeed } from "../src/lib/event/service.js";
import { encodeJsonFeed } from "../src/lib/swarm/feeds.js";

const EVENT_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER_ID = "f9e8d7c6-b5a4-4f9e-8d7c-6b5a4f9e8d7c";

/** A feed page as the reader receives it — real encoder, so this is a round trip. */
function page(body: Record<string, unknown>): Uint8Array {
  return encodeJsonFeed(body);
}

test("a feed that identifies as the event it was read under is returned", () => {
  const out = decodeEventFeed(page({ v: 1, eventId: EVENT_ID, title: "Test Night" }), EVENT_ID);
  assert.equal(out?.eventId, EVENT_ID);
  assert.equal(out?.title, "Test Night");
});

test("ANCHOR: a feed naming ANOTHER event is rejected as not-found", () => {
  // The mislabelling itself. Read under EVENT_ID, the SOC says it is OTHER_ID —
  // which is what made the strip in applyOnChainEventIds miss.
  const out = decodeEventFeed(page({ v: 1, eventId: OTHER_ID, title: "Test Night" }), EVENT_ID);
  assert.equal(out, null);
});

test("a feed with NO eventId at all is rejected", () => {
  // `eventId` is required by the EventFeed schema; absent is malformed, and
  // `undefined !== EVENT_ID` must not be read as "nothing to check".
  assert.equal(decodeEventFeed(page({ v: 1, title: "Test Night" }), EVENT_ID), null);
});

test("the comparison is EXACT — a case-differing id is rejected, not tolerated", () => {
  // Load-bearing. `byEventSeries` is a case-SENSITIVE Map, so accepting this
  // would leave the strip missing while the check appeared to pass. Nothing
  // legitimate can reach here: ids are lowercase UUIDs and `topicEvent`'s
  // component gate rejects uppercase, so a case-varied id addresses a different
  // feed in the first place.
  const upper = EVENT_ID.toUpperCase();
  assert.equal(decodeEventFeed(page({ v: 1, eventId: upper, title: "T" }), EVENT_ID), null);
  assert.equal(decodeEventFeed(page({ v: 1, eventId: EVENT_ID, title: "T" }), upper), null);
});

test("an undecodable page is still null — the check adds a reason, it does not remove one", () => {
  assert.equal(decodeEventFeed(new Uint8Array(0), EVENT_ID), null);
  assert.equal(decodeEventFeed(new Uint8Array([1, 2, 3]), EVENT_ID), null);
});
