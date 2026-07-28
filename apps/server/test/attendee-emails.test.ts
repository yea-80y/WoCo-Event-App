/**
 * Attendee membership for event broadcasts.
 *
 * The property under test is a security boundary, not a convenience: if this
 * set is ever wider than "people who actually hold a ticket", /broadcast becomes
 * a send-to-anyone path that skips the marketing consent warranty entirely.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimersFeed, EventFeed } from "@woco/shared";
import { getAttendeeEmailHashes, type ClaimersReader } from "../src/lib/event/attendee-emails.js";

const hash = (n: number) => n.toString(16).padStart(64, "0");

function eventWith(series: Array<Record<string, unknown>>): EventFeed {
  return { series } as unknown as EventFeed;
}

function feed(claimers: Array<Record<string, unknown>>): ClaimersFeed {
  return { v: 1, seriesId: "s", claimers, updatedAt: "" } as unknown as ClaimersFeed;
}

const readerFor = (byId: Record<string, ClaimersFeed | null>): ClaimersReader =>
  async (seriesId) => byId[seriesId] ?? null;

test("collects email-handle claimers across every series", async () => {
  const result = await getAttendeeEmailHashes(
    eventWith([{ seriesId: "a" }, { seriesId: "b" }]),
    readerFor({
      a: feed([{ edition: 1, claimerAddress: `email:${hash(1)}` }]),
      b: feed([{ edition: 1, claimerAddress: `email:${hash(2)}` }]),
    }),
  );

  assert.deepEqual([...result.hashes].sort(), [hash(1), hash(2)].sort());
  assert.equal(result.unverifiableSeries, 0);
});

test("wallet buyers who paid by card are reachable via their secondary email", async () => {
  const result = await getAttendeeEmailHashes(
    eventWith([{ seriesId: "a" }]),
    readerFor({
      a: feed([
        { edition: 1, claimerAddress: "0xabc", secondaryEmailHash: hash(7) },
        // Wallet claim with no email at all — contributes nothing, and must not
        // add the address itself to a set that is compared against email hashes.
        { edition: 2, claimerAddress: "0xdef" },
      ]),
    }),
  );

  assert.deepEqual([...result.hashes], [hash(7)]);
});

test("a missing or unreadable feed grants no membership", async () => {
  const result = await getAttendeeEmailHashes(
    eventWith([{ seriesId: "gone" }, { seriesId: "broken" }]),
    async (seriesId) => {
      if (seriesId === "broken") throw new Error("bee down");
      return null;
    },
  );

  assert.equal(result.hashes.size, 0);
  assert.equal(result.unverifiableSeries, 0);
});

test("on-chain series are reported as unverifiable, not as empty", async () => {
  // Reporting these as "no attendees" would reject every legitimate recipient;
  // silently allowing them would reopen the hole. The route needs to see the
  // distinction, so the count has to come back separately from the hash set.
  const result = await getAttendeeEmailHashes(
    eventWith([
      { seriesId: "v1" },
      { seriesId: "v2", swarmManifestRef: "ab".repeat(32), onChainEventId: "12" },
    ]),
    readerFor({ v1: feed([{ edition: 1, claimerAddress: `email:${hash(3)}` }]) }),
  );

  assert.deepEqual([...result.hashes], [hash(3)]);
  assert.equal(result.unverifiableSeries, 1);
});

test("a series with a manifest but no on-chain id is still v1", async () => {
  // Every series created today gets a swarmManifestRef. Only the pair
  // (manifest + onChainEventId) means the on-chain rail, so keying off the
  // manifest alone would make every event unverifiable.
  const result = await getAttendeeEmailHashes(
    eventWith([{ seriesId: "a", swarmManifestRef: "cd".repeat(32) }]),
    readerFor({ a: feed([{ edition: 1, claimerAddress: `email:${hash(4)}` }]) }),
  );

  assert.equal(result.unverifiableSeries, 0);
  assert.deepEqual([...result.hashes], [hash(4)]);
});

test("hash comparison is case-insensitive on both sides", async () => {
  const result = await getAttendeeEmailHashes(
    eventWith([{ seriesId: "a" }]),
    readerFor({
      a: feed([
        { edition: 1, claimerAddress: `email:${hash(0xabc).toUpperCase()}` },
        { edition: 2, claimerAddress: "0x1", secondaryEmailHash: hash(0xdef).toUpperCase() },
      ]),
    }),
  );

  assert.ok(result.hashes.has(hash(0xabc)));
  assert.ok(result.hashes.has(hash(0xdef)));
});
