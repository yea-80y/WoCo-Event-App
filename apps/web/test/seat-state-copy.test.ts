/**
 * Key rotation carries each seated ticket type's seat state to the new signer
 * (creator/seating/seat-state.ts, wired in keyring/rotate-live.ts copyEvents): as stored,
 * same seq, its own topic and the event's own route; an unreadable or inconclusive read
 * stops the removal before anything is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import { seatStateTopic } from "@woco/shared/seating/topics";
import { copySeatStates, seatedSeriesIds, SeatStateUnreadableError, type SeatStateIO } from "../src/lib/creator/seating/seat-state.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";
import type { FeedRoute } from "../src/lib/swarm/gateways.js";

const OLD = `0x${"01".repeat(20)}`;
const NEW_PK = "ab".repeat(32);
const ROUTE = { gatewayUrl: "https://example.test", store: "woco" } as unknown as FeedRoute;

const feed = {
  eventId: "evt-1",
  gatewayUrl: "https://example.test",
  series: [
    { seriesId: "stalls", seating: { bands: [] } },
    { seriesId: "standing" },
    { seriesId: "circle", seating: { bands: [] } },
  ],
} as unknown as EventFeed;

function io(answers: Record<string, ContentFeedResult<unknown>>) {
  const reads: string[] = [];
  const writes: Array<{ topic: string; data: unknown; route: FeedRoute; signerPrivKey: string }> = [];
  const x: SeatStateIO = {
    read: async (signer, topic) => {
      assert.equal(signer, OLD);
      reads.push(topic);
      return answers[topic] ?? { status: "absent" };
    },
    write: async (a) => {
      writes.push(a);
      return 0;
    },
    route: () => ROUTE,
  };
  return { x, reads, writes };
}

test("only seated ticket types have a state", () => {
  assert.deepEqual(seatedSeriesIds(feed), ["stalls", "circle"]);
});

test("each stored state is copied as stored, under its own topic, on the event's route", async () => {
  const state = { format: "woco.seatstate.v1", eventId: "evt-1", seriesId: "stalls", seq: 7 };
  const f = io({ [seatStateTopic("evt-1", "stalls")]: { status: "found", value: state, version: 3, scanClean: true } });
  assert.equal(await copySeatStates(f.x, feed, OLD, NEW_PK), 1);
  assert.deepEqual(f.reads, [seatStateTopic("evt-1", "stalls"), seatStateTopic("evt-1", "circle")], "standing is never read");
  assert.deepEqual(f.writes, [{ signerPrivKey: NEW_PK, topic: seatStateTopic("evt-1", "stalls"), data: state, route: ROUTE }]);
});

test("an unreadable or inconclusive state stops the copy before it writes anything", async () => {
  for (const bad of [
    { status: "unavailable" } as const,
    { status: "found", value: {}, version: 1, scanClean: false } as const,
  ]) {
    const f = io({ [seatStateTopic("evt-1", "stalls")]: bad });
    await assert.rejects(copySeatStates(f.x, feed, OLD, NEW_PK), SeatStateUnreadableError);
    assert.equal(f.writes.length, 0);
  }
});
