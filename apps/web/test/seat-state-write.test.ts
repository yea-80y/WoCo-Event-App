/**
 * The dashboard's seat-state save (creator/seating/seat-state.ts writeSeatState): the
 * organiser unlock first, every time; the delta applied to the newest WHOLE state (a torn
 * head is stepped past); the exact version written read back (another device's bytes
 * there = a conflict, never "saved"); refusals for every read that could be mistaken for
 * "never written"; pacing on the relay's budget. Plus the saver retrying a conflict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSeatState, decodeHeld, type SeatHoldKind, type SeatState } from "@woco/shared/seating/state";
import { seatStateTopic } from "@woco/shared/seating/topics";
import {
  SeatStateConflictError, SeatStateUnreadableError, writeSeatState, type SeatStateWriter,
} from "../src/lib/creator/seating/seat-state.js";
import { holdDelta } from "../src/lib/creator/seating/organiser-seats.js";
import { SeatStateSaver } from "../src/lib/creator/seating/seat-state-saver.js";
import { isRelayBusy, pacedSend } from "../src/lib/swarm/relay-pacing.js";
import type { ContentFeedResult } from "../src/lib/swarm/content-feed.js";
import type { FeedRoute } from "../src/lib/swarm/gateways.js";

const FEED = { eventId: "evt-1", gatewayUrl: "https://example.test" };
const SERIES = "stalls";
const TOPIC = seatStateTopic(FEED.eventId, SERIES);
const DIGEST = `0x${"d1".repeat(32)}`;
const PLAN = { digest: DIGEST, seats: 20, planHolds: new Map<number, SeatHoldKind>([[0, "house"], [1, "house"]]) };
const SIGNER = { privKey: `0x${"ab".repeat(32)}`, address: `0x${"5a".repeat(20)}` };

const existing = (seq: number, holds: [number, SeatHoldKind][], confirmed: [number, number][] = []) =>
  buildSeatState({ eventId: FEED.eventId, seriesId: SERIES, planDigest: DIGEST, seats: 20, holds: new Map(holds), confirmed: new Map(confirmed), seq, updatedAt: "2026-11-04T11:00:00Z" });

/**
 * A versioned feed: `versions[v]` is what version v holds. A write lands at the next
 * version unless `occupied` says another device got there first (its bytes stay).
 */
function writer(opts: {
  versions?: unknown[];
  head?: () => ContentFeedResult<unknown>;
  readVersion?: (v: number) => ContentFeedResult<unknown>;
  hint?: boolean;
  unlock?: () => Promise<void>;
  occupied?: unknown;
  lagging?: boolean;
} = {}) {
  const log: string[] = [];
  const versions = [...(opts.versions ?? [])];
  const writes: SeatState[] = [];
  const at = (v: number): ContentFeedResult<unknown> =>
    v < versions.length ? { status: "found", value: versions[v], version: v, scanClean: true } : { status: "absent" };
  const w: SeatStateWriter = {
    read: async (signer, topic) => {
      log.push("read");
      assert.equal(signer, SIGNER.address);
      assert.equal(topic, TOPIC);
      return opts.head ? opts.head() : versions.length ? at(versions.length - 1) : { status: "absent" };
    },
    readVersion: async (_s, _t, _r, v) => {
      log.push(`readVersion ${v}`);
      if (opts.lagging && v === versions.length - 1 && writes.length) return { status: "absent" };
      return opts.readVersion ? opts.readVersion(v) : at(v);
    },
    write: async (a) => {
      log.push("write");
      assert.equal(a.signerPrivKey, SIGNER.privKey);
      writes.push(a.data as SeatState);
      versions.push(opts.occupied ?? a.data);
      return versions.length - 1;
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
  return { w, log, writes, versions };
}

const heldOf = (s: SeatState) => {
  const m = new Map<number, string>();
  for (const h of s.holds) for (const k of decodeHeld(h.held, s.seats)) m.set(k, h.kind);
  return m;
};

test("the organiser unlock comes first, and a declined unlock writes nothing", async () => {
  const ok = writer();
  await writeSeatState(ok.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) });
  assert.deepEqual(ok.log.slice(0, 2), ["unlock", "signer"]);
  const declined = writer({ unlock: async () => { throw new Error("declined"); } });
  await assert.rejects(writeSeatState(declined.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) }), /declined/);
  assert.deepEqual(declined.log, [], "no read, no signer, no write");
});

test("never written: starts from the plan's own holds at seq 0, and reads back the version it wrote", async () => {
  const f = writer();
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]), release: [1] });
  assert.equal(r.state.seq, 0);
  assert.deepEqual([...heldOf(r.state)], [[0, "house"], [5, "press"]]);
  assert.equal(r.settled, true);
  assert.ok(f.log.includes("readVersion 0"));
});

test("the delta lands on the state read now: another device's hold survives this one's release", async () => {
  const f = writer({ versions: [existing(4, [[2, "guest"], [3, "house"]], [[9, 1]])] });
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { release: [3], confirm: new Map([[11, 2]]) });
  assert.equal(r.state.seq, 5);
  assert.deepEqual([...heldOf(r.state)], [[2, "guest"]]);
  assert.deepEqual(r.state.confirmed, [[9, 1], [11, 2]]);
  const moved = writer({ versions: [existing(4, [[2, "guest"]])] });
  const m = await writeSeatState(moved.w, FEED, SERIES, PLAN, { hold: new Map([[2, "press"]]) });
  assert.deepEqual([...heldOf(m.state)], [[2, "press"]], "a held seat moves to the new kind");
});

test("F1: a torn head is stepped past - the save starts from the last whole version and lands after it", async () => {
  const whole = existing(6, [[2, "guest"]]);
  const torn = { ...existing(7, [[3, "press"]]), holds: whole.holds }; // pages from two saves: the digest no longer matches
  const f = writer({ versions: [existing(5, []), whole, torn] });
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) });
  assert.equal(r.state.seq, 8, "on top of seq 6's holds, above the torn head's own seq 7");
  assert.deepEqual([...heldOf(r.state)].sort((x, y) => x[0] - y[0]), [[2, "guest"], [4, "house"]]);
  assert.equal(f.versions.length, 4, "landed after the torn version");
  const unusable = writer({ versions: [whole], head: () => ({ status: "unavailable", unusableAt: 1 }) });
  const u = await writeSeatState(unusable.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) });
  assert.equal(u.state.seq, 7, "a version that can never be read is stepped past too");
});

test("F1: a torn FIRST save starts from the plan; nothing whole within reach refuses", async () => {
  const f = writer({ versions: [{ ...existing(0, [[3, "press"]]), seq: 1 }] });
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) });
  assert.deepEqual([...heldOf(r.state)], [[0, "house"], [1, "house"], [4, "house"]]);
  const deep = writer({ versions: Array.from({ length: 12 }, () => ({ format: "woco.seatstate.v1" })) });
  await assert.rejects(writeSeatState(deep.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) }), SeatStateUnreadableError);
  assert.equal(deep.writes.length, 0);
  const flaky = writer({ versions: [existing(1, []), { bad: 1 }], readVersion: () => ({ status: "unavailable" }) });
  await assert.rejects(writeSeatState(flaky.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) }), SeatStateUnreadableError, "an unreadable older version is not skipped");
});

test("F2: another device's bytes at the version written are a conflict, never 'saved'", async () => {
  const theirs = existing(5, [[9, "press"]]);
  const f = writer({ versions: [existing(4, [])], occupied: theirs });
  await assert.rejects(writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[2, "guest"]]) }), SeatStateConflictError);
  const slow = writer({ versions: [existing(4, [])], lagging: true });
  const r = await writeSeatState(slow.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) });
  assert.equal(r.settled, false, "written, not read back yet");
});

test("review: a missed read below an existing head is unreadable, never stepped past (no rollback)", async () => {
  const f = writer({
    versions: [existing(5, [[2, "guest"]]), existing(6, [[3, "press"]]), { bad: 1 }],
    readVersion: (v) => (v === 1 ? { status: "absent" } : { status: "found", value: existing(5, [[2, "guest"]]), version: v, scanClean: true }),
  });
  await assert.rejects(writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) }), SeatStateUnreadableError);
  assert.equal(f.writes.length, 0);
});

test("review: the new seq goes above a stepped-past head's own seq", async () => {
  const torn = { ...existing(9, [[3, "press"]]), holds: [] }; // claims seq 9, does not validate
  const f = writer({ versions: [existing(6, [[2, "guest"]]), torn] });
  const r = await writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[4, "house"]]) });
  assert.equal(r.state.seq, 10);
});

test("review: a read-back torn under our own digest field is a conflict, not 'saved'", async () => {
  const f = writer({ versions: [existing(4, [])] });
  const origWrite = f.w.write;
  f.w.write = async (a) => {
    const v = await origWrite(a);
    const mine = a.data as SeatState;
    f.versions[v] = { ...mine, holds: [] }; // earlier pages from another save, our last page (and digest field)
    return v;
  };
  await assert.rejects(writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[2, "guest"]]) }), SeatStateConflictError);
});

test("refused, nothing written: unreadable, inconclusive, absent on a device that has seen it, another plan's", async () => {
  const otherPlan = buildSeatState({
    eventId: FEED.eventId, seriesId: SERIES, planDigest: `0x${"00".repeat(32)}`, seats: 20, holds: new Map(), confirmed: new Map(), seq: 1, updatedAt: "2026-11-04T11:00:00Z",
  });
  const cases: Array<[string, Parameters<typeof writer>[0]]> = [
    ["unavailable", { head: () => ({ status: "unavailable" }) }],
    ["inconclusive", { head: () => ({ status: "found", value: existing(1, []), version: 1, scanClean: false }) }],
    ["absent with a version hint", { hint: true }],
    ["another plan", { versions: [otherPlan] }],
  ];
  for (const [label, o] of cases) {
    const f = writer(o);
    await assert.rejects(writeSeatState(f.w, FEED, SERIES, PLAN, { hold: new Map([[5, "press"]]) }), SeatStateUnreadableError, label);
    assert.equal(f.writes.length, 0, label);
  }
});

test("the saver sends a conflicted save again on top of the other device's state, then gives up", async () => {
  let calls = 0;
  const timers: Array<() => void> = [];
  const s = new SeatStateSaver(
    {
      save: async () => {
        calls++;
        if (calls <= 2) throw new SeatStateConflictError();
        return { state: existing(9, []), settled: true };
      },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    },
    () => {},
    () => {},
  );
  s.add(holdDelta([1], "house"));
  timers.splice(0).forEach((f) => f());
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(calls, 3);
  assert.deepEqual(s.status, { phase: "saved", settled: true });
  let n = 0;
  const stuck = new SeatStateSaver(
    { save: async () => { n++; throw new SeatStateConflictError(); }, setTimeout: (fn) => { timers.push(fn); return 1; }, clearTimeout: () => {} },
    () => {},
    () => {},
  );
  stuck.add(holdDelta([1], "house"));
  timers.splice(0).forEach((f) => f());
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  assert.equal(n, 4, "the first try and three more");
  assert.equal(stuck.status.phase, "failed");
  assert.ok(stuck.pending.hold?.has(1), "kept for Try again");
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

test("the seat-state writer, and only an opted-in writer, paces on the relay's budget", () => {
  const src = readFileSync(new URL("../src/lib/creator/seating/seat-state.ts", import.meta.url), "utf8");
  assert.match(src, /writeContentFeed\(\{ \.\.\.args, paceWhenBusy: true \}\)/);
  const feed = readFileSync(new URL("../src/lib/swarm/content-feed.ts", import.meta.url), "utf8");
  assert.match(feed, /args\.paceWhenBusy \? \(body\) => pace\.pacedSend/);
});

test("the relay's busy wording is what the client paces on", () => {
  const src = readFileSync(new URL("../../server/src/lib/swarm/soc-relay-limits.ts", import.meta.url), "utf8");
  const reasons = [...src.matchAll(/const REASON_(?:CALLER|GLOBAL) = "([^"]+)";/g)].map((m) => m[1]);
  assert.equal(reasons.length, 2);
  for (const r of reasons) assert.ok(isRelayBusy(new Error(r)), r);
});
