/**
 * Attendee membership for event broadcasts.
 *
 * The property under test is a security boundary, not a convenience: if this
 * set is ever wider than "people who PROVABLY hold a ticket", /broadcast
 * becomes a send-to-anyone path that skips the marketing consent warranty.
 * Since the v1 claimers feeds went with the v1 rail, nothing is provable
 * server-side — so the contract is: the proven set is ALWAYS empty, and every
 * on-chain series is reported unverifiable (routing the broadcast through the
 * verified-organiser abuse gate, never silently through).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import { getAttendeeEmailHashes } from "../src/lib/event/attendee-emails.js";

function eventWith(series: Array<Record<string, unknown>>): EventFeed {
  return { series } as unknown as EventFeed;
}

test("the proven set is always empty — membership is never manufactured", () => {
  const result = getAttendeeEmailHashes(
    eventWith([
      { seriesId: "a", swarmManifestRef: "ref", onChainEventId: "0x1" },
      { seriesId: "b" },
    ]),
  );
  assert.equal(result.hashes.size, 0);
});

test("every registered on-chain series counts as unverifiable", () => {
  const result = getAttendeeEmailHashes(
    eventWith([
      { seriesId: "a", swarmManifestRef: "ref", onChainEventId: "0x1" },
      { seriesId: "b", swarmManifestRef: "ref", onChainEventId: "0x2" },
    ]),
  );
  assert.equal(result.unverifiableSeries, 2);
});

test("an unregistered series is neither proof nor unverifiability", () => {
  // No on-chain record ⇒ nothing was ever mintable ⇒ no attendees exist.
  // Reporting it unverifiable would hand an event with zero possible
  // attendees the verified-organiser send path.
  const result = getAttendeeEmailHashes(
    eventWith([{ seriesId: "a" }, { seriesId: "b", swarmManifestRef: "ref" }]),
  );
  assert.equal(result.unverifiableSeries, 0);
  assert.equal(result.hashes.size, 0);
});
