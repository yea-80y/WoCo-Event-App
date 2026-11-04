/**
 * The organiser's seat state on the money path (seat-state-gate.ts): what is served, for
 * how long, and every way an old or wrong state is refused rather than sold from.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { VersionedFeedRead } from "@woco/shared";
import { buildSeatState } from "@woco/shared/seating/state";
import { eventSeatStateTopic } from "@woco/shared/seating/topics";
import {
  __setSeatStateGateForTests, seatStateRead, seatStateRelayed, seatStateWritten, SEAT_STATE_FRESH_MS, SEAT_STATE_SIGNAL_MS,
} from "../src/lib/seating/seat-state-gate.js";

const EVENT = "evt-seats-1";
const SIGNER = `0x${"5a".repeat(20)}`;
const DIGEST = `0x${"d1".repeat(32)}`;
const X = { eventId: EVENT, signer: SIGNER, planDigest: DIGEST, seats: 10 };

let t = 1_000_000;
let reads: Array<{ owner: string; topic: string }> = [];
let next: () => Promise<VersionedFeedRead>;

beforeEach(() => {
  t = 1_000_000;
  reads = [];
  __setSeatStateGateForTests({
    now: () => t,
    reader: async (owner, topic) => {
      reads.push({ owner, topic });
      return next();
    },
  });
});

const stateAt = (seq: number, over: Record<string, unknown> = {}) =>
  buildSeatState({ eventId: EVENT, planDigest: DIGEST, seats: 10, holds: new Map([[3, "house"]]), confirmed: new Map(), seq, updatedAt: "2026-11-04T00:00:00Z", ...over });
const found = (v: unknown): VersionedFeedRead => ({ status: "found", bytes: new TextEncoder().encode(JSON.stringify(v)), version: 1, scanClean: true });
const serve = (r: VersionedFeedRead) => { next = async () => r; };

test("never written: absent (the plan's flags), read under the carrier's signer and topic, kept 30 s", async () => {
  serve({ status: "absent" });
  assert.deepEqual(await seatStateRead(X), { status: "absent" });
  assert.deepEqual(reads, [{ owner: "5a".repeat(20), topic: eventSeatStateTopic(EVENT) }]);
  t += SEAT_STATE_FRESH_MS - 1;
  await seatStateRead(X);
  assert.equal(reads.length, 1, "from memory inside the window");
  t += 1;
  await seatStateRead(X);
  assert.equal(reads.length, 2, "read again after it");
});

test("found: served, and another signer (a rotation) is a fresh read", async () => {
  serve(found(stateAt(4)));
  const r = await seatStateRead(X);
  assert.equal(r.status, "found");
  assert.equal(r.status === "found" && r.state.seq, 4);
  await seatStateRead({ ...X, signer: `0x${"77".repeat(20)}` });
  assert.equal(reads.length, 2);
});

test("unreadable, unparseable, invalid or another event's / plan's state is unavailable, and never kept", async () => {
  serve({ status: "unavailable", reason: "gateway" });
  assert.equal((await seatStateRead(X)).status, "unavailable");
  next = async () => { throw new Error("boom"); };
  assert.equal((await seatStateRead(X)).status, "unavailable");
  serve({ status: "found", bytes: new TextEncoder().encode("{not json"), version: 1, scanClean: true });
  assert.equal((await seatStateRead(X)).status, "unavailable");
  serve(found({ ...stateAt(1), extra: 1 }));
  assert.equal((await seatStateRead(X)).status, "unavailable");
  serve(found(stateAt(1, { eventId: "evt-other" })));
  assert.equal((await seatStateRead(X)).status, "unavailable", "another event's state");
  serve(found(stateAt(1, { planDigest: `0x${"00".repeat(32)}` })));
  assert.equal((await seatStateRead(X)).status, "unavailable", "another plan's state is not the plan's flags");
  assert.equal(reads.length, 6, "nothing unavailable was kept");
});

test("once found, a later absent or older read is unavailable: a hold never rolls back", async () => {
  serve(found(stateAt(5)));
  await seatStateRead(X);
  t += SEAT_STATE_FRESH_MS;
  serve({ status: "absent" });
  assert.equal((await seatStateRead(X)).status, "unavailable", "absent after found");
  serve(found(stateAt(4)));
  assert.equal((await seatStateRead(X)).status, "unavailable", "a replica behind");
  serve(found(stateAt(5)));
  assert.equal((await seatStateRead(X)).status, "found", "the same seq again is fine");
});

test("a write signal drops the memory and refuses anything older until it reads back", async () => {
  serve(found(stateAt(2)));
  await seatStateRead(X);
  seatStateWritten(EVENT, 3);
  assert.equal((await seatStateRead(X)).status, "unavailable", "the old state is not served from memory");
  assert.equal(reads.length, 2);
  serve(found(stateAt(3)));
  const r = await seatStateRead(X);
  assert.equal(r.status === "found" && r.state.seq, 3);
  await seatStateRead(X);
  assert.equal(reads.length, 3, "kept again once the announced seq read back");
});

test("a signal that never reads back lapses: the latest readable state is trusted again", async () => {
  serve(found(stateAt(2)));
  seatStateWritten(EVENT, 9);
  assert.equal((await seatStateRead(X)).status, "unavailable");
  t += SEAT_STATE_SIGNAL_MS;
  assert.equal((await seatStateRead(X)).status, "found");
});

test("a signal before the first write: absent is unavailable until the state is there", async () => {
  serve({ status: "absent" });
  seatStateWritten(EVENT, 0);
  assert.equal((await seatStateRead(X)).status, "unavailable");
  serve(found(stateAt(0)));
  assert.equal((await seatStateRead(X)).status, "found");
});

test("a signal is only ever stricter: a lower seq does not lower the bar", async () => {
  serve(found(stateAt(5)));
  seatStateWritten(EVENT, 6);
  seatStateWritten(EVENT, 3);
  assert.equal((await seatStateRead(X)).status, "unavailable");
});

test("only the event's recorded organiser's chunk is a signal: anyone else's pauses nothing", async () => {
  const creator = `0x${"c0".repeat(20)}`;
  const recorded = (id: string) => (id === EVENT ? creator : null);
  serve(found(stateAt(2)));
  assert.equal(seatStateRelayed({ eventId: EVENT, seq: 3 }, `0x${"ee".repeat(20)}`, "11".repeat(20), recorded), false, "another account");
  assert.equal(seatStateRelayed({ eventId: "evt-unknown", seq: 3 }, creator, "11".repeat(20), recorded), false, "no record");
  assert.equal((await seatStateRead(X)).status, "found", "nothing paused");
  t += SEAT_STATE_FRESH_MS;
  assert.equal(seatStateRelayed({ eventId: EVENT, seq: 3 }, creator.toUpperCase().replace("0X", "0x"), "11".repeat(20), recorded), true);
  assert.equal((await seatStateRead(X)).status, "unavailable", "the organiser's own write is awaited");
});

test("a signal that lands while a read is in flight: the older answer is never served from memory", async () => {
  let release!: () => void;
  next = () => new Promise((res) => { release = () => res(found(stateAt(1))); });
  const first = seatStateRead(X);
  const second = seatStateRead(X);
  await new Promise((r) => setImmediate(r));
  assert.equal(reads.length, 1, "single flight");
  seatStateWritten(EVENT, 2);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "unavailable", "the read came back below the announced seq");
  assert.equal(b.status, "unavailable");
  serve(found(stateAt(1)));
  assert.equal((await seatStateRead(X)).status, "unavailable");
});
