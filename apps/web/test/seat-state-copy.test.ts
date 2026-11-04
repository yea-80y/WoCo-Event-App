/**
 * Key rotation carries each seated ticket type's seat state to the new signer
 * (creator/seating/seat-state.ts, wired in keyring/rotate-live.ts copyEvents): a whole state
 * as stored (same seq), its own topic and the event's own route; a torn head replaced by
 * the newest whole state numbered above it (S6 delta check); an unreadable or
 * inconclusive read stops the removal before anything is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventFeed } from "@woco/shared";
import { buildSeatState, validateSeatState, type SeatState } from "@woco/shared/seating/state";
import { seatStateTopic } from "@woco/shared/seating/topics";
import { copySeatStates, seatedSeriesIds, SeatStateUnreadableError, type SeatStateIO } from "../src/lib/creator/seating/seat-state.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";
import type { FeedRoute } from "../src/lib/swarm/gateways.js";

const OLD = `0x${"01".repeat(20)}`;
const NEW_PK = "ab".repeat(32);
const ROUTE = { gatewayUrl: "https://example.test", store: "woco" } as unknown as FeedRoute;
const STALLS = seatStateTopic("evt-1", "stalls");

const feed = {
  eventId: "evt-1",
  gatewayUrl: "https://example.test",
  series: [
    { seriesId: "stalls", seating: { bands: [] } },
    { seriesId: "standing" },
    { seriesId: "circle", seating: { bands: [] } },
  ],
} as unknown as EventFeed;

const state = (seq: number, held: number[]) => buildSeatState({
  eventId: "evt-1", seriesId: "stalls", planDigest: `0x${"d1".repeat(32)}`, seats: 20,
  holds: new Map(held.map((k) => [k, "house" as const])), confirmed: new Map([[9, 2]]), seq, updatedAt: "2026-11-04T10:00:00Z",
});

/** `heads[topic]` is what the head read answers; `versions[topic]` what each version holds. */
function io(heads: Record<string, ContentFeedResult<unknown>>, versions: Record<string, unknown[]> = {}) {
  const reads: string[] = [];
  const writes: Array<{ topic: string; data: unknown; route: FeedRoute; signerPrivKey: string }> = [];
  const x: SeatStateIO = {
    read: async (signer, topic) => {
      assert.equal(signer, OLD);
      reads.push(topic);
      return heads[topic] ?? { status: "absent" };
    },
    readVersion: async (_s, topic, _r, v) => {
      const list = versions[topic] ?? [];
      return v < list.length ? { status: "found", value: list[v], version: v, scanClean: true } : { status: "absent" };
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

test("a whole state is copied as stored, under its own topic, on the event's route", async () => {
  const s7 = state(7, [3]);
  const f = io({ [STALLS]: { status: "found", value: s7, version: 3, scanClean: true } });
  assert.equal(await copySeatStates(f.x, feed, OLD, NEW_PK), 1);
  assert.deepEqual(f.reads, [STALLS, seatStateTopic("evt-1", "circle")], "standing is never read");
  assert.deepEqual(f.writes, [{ signerPrivKey: NEW_PK, topic: STALLS, data: s7, route: ROUTE }]);
});

test("a torn head is replaced by the newest whole state, numbered above every seq the torn versions claimed", async () => {
  const whole = state(5, [2, 4]);
  const tornLow = { ...state(6, [7]), holds: [] }; // stepped past, claims seq 6
  const tornHead = { ...state(7, [8]), confirmed: [] }; // the head, claims seq 7
  const f = io(
    { [STALLS]: { status: "found", value: tornHead, version: 2, scanClean: true } },
    { [STALLS]: [whole, tornLow, tornHead] },
  );
  assert.equal(await copySeatStates(f.x, feed, OLD, NEW_PK, () => "2026-11-04T12:00:00.000Z"), 1);
  const copied = f.writes[0]!.data as SeatState;
  assert.ok(validateSeatState(copied), "a whole state");
  assert.equal(copied.seq, 8);
  assert.deepEqual(copied.holds, whole.holds, "the last whole state's holds");
  assert.deepEqual(copied.confirmed, whole.confirmed);
});

test("an unreadable or inconclusive state stops the copy before it writes anything", async () => {
  for (const bad of [
    { status: "unavailable" } as const,
    { status: "found", value: {}, version: 1, scanClean: false } as const,
  ]) {
    const f = io({ [STALLS]: bad });
    await assert.rejects(copySeatStates(f.x, feed, OLD, NEW_PK), SeatStateUnreadableError);
    assert.equal(f.writes.length, 0);
  }
  const missed = io({ [STALLS]: { status: "found", value: { bad: 1 }, version: 2, scanClean: true } }, { [STALLS]: [state(1, [])] });
  await assert.rejects(copySeatStates(missed.x, feed, OLD, NEW_PK), SeatStateUnreadableError, "a missed version below a torn head");
  assert.equal(missed.writes.length, 0);
});
