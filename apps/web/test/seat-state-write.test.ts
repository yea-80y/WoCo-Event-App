/**
 * The dashboard's seat-state save (creator/seating/seat-state.ts writeSeatState): the
 * organiser unlock first, every time; the delta applied to a fresh read; refusals for
 * every read that could be mistaken for "never written"; pacing on the relay's budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSeatState, decodeHeld, type SeatHoldKind, type SeatState } from "@woco/shared/seating/state";
import { seatStateTopic } from "@woco/shared/seating/topics";
import {
  isRelayBusy, pacedSend, SeatStateUnreadableError, writeSeatState, type SeatStateWriter,
} from "../src/lib/creator/seating/seat-state.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";
import type { FeedRoute } from "../src/lib/swarm/gateways.js";

const FEED = { eventId: "evt-1", gatewayUrl: "https://example.test" };
const SERIES = "stalls";
const TOPIC = seatStateTopic(FEED.eventId, SERIES);
const DIGEST = `0x${"d1".repeat(32)}`;
const PLAN = { digest: DIGEST, seats: 20, planHolds: new Map<number, SeatHoldKind>([[0, "house"], [1, "house"]]) };
const SIGNER = { privKey: `0x${"ab".repeat(32)}`, address: `0x${"5a".repeat(20)}` };

function writer(opts: { stored?: unknown; read?: () => ContentFeedResult<unknown>; hint?: boolean; unlock?: () => Promise<void>; lagging?: boolean } = {}) {
  const log: string[] = [];
  let stored: unknown = opts.stored;
  const writes: SeatState[] = [];
  const w: SeatStateWriter = {
    read: async (signer, topic) => {
      log.push("read");
      assert.equal(signer, SIGNER.address);
      assert.equal(topic, TOPIC);
      if (opts.read) return opts.read();
      if (opts.lagging && writes.length > 0) return { status: "found", value: opts.stored, version: 1, scanClean: true };
      return stored === undefined ? { status: "absent" } : { status: "found", value: stored, version: 1, scanClean: true };
    },
    write: async (a) => {
      log.push("write");
      assert.equal(a.signerPrivKey, SIGNER.privKey);
      stored = a.data;
      writes.push(a.data as SeatState);
      return 1;
    },
    route: () => ({}) as FeedRoute,
    unlock: opts.unlock ?? (async () => void log.push("unlock")),
    signer: async () => {
      log.push("signer");
      return SIGNER;
    },
    hadVersion: () => opts.hint ?? false,
    now: () => "2026-11-04T12:00:00.000Z",
  };
  return { w, log, writes };
}

const heldOf = (s: SeatState) => {
  const m = new Map<number, string>();
  for (const h of s.holds) for (const k of decodeHeld(h.held, s.seats)) m.set(k, h.kind);
  return m;
};

const existing = (seq: number, holds: [number, SeatHoldKind][], confirmed: [number, number][] = []) =>
  buildSeatState({ eventId: FEED.eventId, seriesId: SERIES, planDigest: DIGEST, seats: 20, holds: new Map(holds), confirmed: new Map(confirmed), seq, updatedAt: "2026-11-04T11:00:00Z" });

test("the organiser unlock comes first, and a declined unlock writes nothing", async () => {
  const ok = writer();
  await writeSeatState(ok.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) });
  assert.deepEqual(ok.log.slice(0, 2), ["unlock", "signer"]);
  const declined = writer({ unlock: async () => { throw new Error("declined"); } });
  await assert.rejects(writeSeatState(declined.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) }), /declined/);
  assert.deepEqual(declined.log, [], "no read, no signer, no write");
});

test("never written: starts from the plan's own holds at seq 0", async () => {
  const f = writer();
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]), release: [1] });
  assert.equal(r.state.seq, 0);
  assert.deepEqual([...heldOf(r.state)], [[0, "house"], [5, "press"]]);
  assert.equal(r.settled, true);
});

test("the delta lands on the state read now: another device's hold survives this one's release", async () => {
  const f = writer({ stored: existing(4, [[2, "guest"], [3, "house"]], [[9, 1]]) });
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { release: [3], confirm: new Map([[11, 2]]) });
  assert.equal(r.state.seq, 5);
  assert.deepEqual([...heldOf(r.state)], [[2, "guest"]]);
  assert.deepEqual(r.state.confirmed, [[9, 1], [11, 2]]);
  const moved = writer({ stored: existing(4, [[2, "guest"]]) });
  const m = await writeSeatState(moved.w, FEED, SERIES, PLAN, { hold: new Map([[2, "press"]]) });
  assert.deepEqual([...heldOf(m.state)], [[2, "press"]], "a held seat moves to the new kind");
});

test("refused, nothing written: unreadable, inconclusive, absent on a device that has seen it, another plan's", async () => {
  const cases: Array<[string, Parameters<typeof writer>[0]]> = [
    ["unavailable", { read: () => ({ status: "unavailable" }) }],
    ["inconclusive", { read: () => ({ status: "found", value: existing(1, []), version: 1, scanClean: false }) }],
    ["absent with a version hint", { hint: true }],
    ["another plan", { stored: { ...existing(1, []), planDigest: `0x${"00".repeat(32)}` } }],
    ["another ticket type", { stored: { ...existing(1, []), seriesId: "circle" } }],
    ["malformed", { stored: { format: "woco.seatstate.v1" } }],
  ];
  for (const [label, o] of cases) {
    const f = writer(o);
    await assert.rejects(writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) }), SeatStateUnreadableError, label);
    assert.equal(f.writes.length, 0, label);
  }
});

test("written but not read back yet: settled false", async () => {
  const f = writer({ stored: existing(4, []), lagging: true });
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) });
  assert.equal(r.settled, false);
  assert.equal(f.writes.length, 1);
});

test("pacing: waits out the relay's budget, and only that", async () => {
  const waits: number[] = [];
  let n = 0;
  const v = await pacedSend(async () => {
    if (n++ < 2) throw new Error("Too many writes — slow down.");
    return "ok";
  }, async (ms) => void waits.push(ms));
  assert.equal(v, "ok");
  assert.deepEqual(waits, [5_000, 15_000]);
  await assert.rejects(pacedSend(async () => { throw new Error("ticket_required"); }, async () => assert.fail("no wait")), /ticket_required/);
  let busy = 0;
  await assert.rejects(pacedSend(async () => { busy++; throw new Error("The write relay is busy — try again shortly."); }, async () => {}));
  assert.equal(busy, 5, "four waits, then it gives up");
});

test("the relay's busy wording is what the client paces on", () => {
  const src = readFileSync(new URL("../../server/src/lib/swarm/soc-relay-limits.ts", import.meta.url), "utf8");
  const reasons = [...src.matchAll(/const REASON_(?:CALLER|GLOBAL) = "([^"]+)";/g)].map((m) => m[1]);
  assert.equal(reasons.length, 2);
  for (const r of reasons) assert.ok(isRelayBusy(new Error(r)), r);
});
