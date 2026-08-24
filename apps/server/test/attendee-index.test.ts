/**
 * The attendee index is the only server-visible proof that an email holds a
 * ticket. #82 item 3 was fixed once and then silently un-fixed when #207
 * deleted the data source it read, while every test stayed green — so these
 * tests assert the two PROPERTIES that flipped, not the shape of a function.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store resolves `.data` from cwd at import time, so redirect before import.
const dir = mkdtempSync(join(tmpdir(), "woco-attendee-"));
process.chdir(dir);

const { recordAttendeeEmail, attendeeEmailHashes, _resetAttendeeIndexForTests } = await import(
  "../src/lib/event/attendee-index.js"
);
const { getAttendeeEmailHashes } = await import("../src/lib/event/attendee-emails.js");

const T = "2026-08-24T12:00:00.000Z";

/**
 * Each test uses its own event id. `_resetAttendeeIndexForTests` drops the
 * in-memory maps and forces a RELOAD FROM DISK — which is the point (the
 * restart test depends on it), but means it is not a truncation. Sharing an
 * event id across tests would leak state through the file.
 */
let n = 0;
const nextEvent = () => `evt_${++n}`;

beforeEach(() => _resetAttendeeIndexForTests());

test("a recorded attendee is provable; an unrecorded one is not", () => {
  const e = nextEvent();
  recordAttendeeEmail(e, "hash_alice", T);
  const set = attendeeEmailHashes(e);
  assert.equal(set.has("hash_alice"), true);
  assert.equal(set.has("hash_stranger"), false, "a stranger must never be provable");
});

test("the index is scoped per event — a ticket to one event proves nothing about another", () => {
  const a = nextEvent();
  const b = nextEvent();
  recordAttendeeEmail(a, "hash_alice", T);
  assert.equal(attendeeEmailHashes(b).has("hash_alice"), false);
  assert.equal(attendeeEmailHashes(b).size, 0);
});

test("recording is idempotent, so a retried webhook neither duplicates nor rewrites", () => {
  const e = nextEvent();
  assert.equal(recordAttendeeEmail(e, "hash_alice", T), true);
  assert.equal(recordAttendeeEmail(e, "hash_alice", T), false, "second call is a no-op");
  assert.equal(attendeeEmailHashes(e).size, 1);
});

test("the returned set is a copy — a caller cannot mutate the store through it", () => {
  const e = nextEvent();
  recordAttendeeEmail(e, "hash_alice", T);
  attendeeEmailHashes(e).add("hash_injected");
  assert.equal(attendeeEmailHashes(e).has("hash_injected"), false);
});

test("it survives a restart, because losing it cannot be re-derived from anywhere", async () => {
  const e = nextEvent();
  recordAttendeeEmail(e, "hash_alice", T);
  _resetAttendeeIndexForTests(); // drops memory; next read reloads from disk
  assert.equal(attendeeEmailHashes(e).has("hash_alice"), true);
});

// --- the two properties that flipped when #207 hollowed out the old source ---
//
// COVERAGE NOTE, recorded rather than glossed: only the FIRST of these bites at
// this layer. Reverting `getAttendeeEmailHashes` to the empty set fails the
// "proven attendee is a member" test and nothing else, because the STRANGER
// half of the bug never lived here — it lived in the route, where
// `allowUnproven` short-circuited `memberTest` to `() => true`. That branch is
// deleted, and its absence is pinned in `broadcast-drain-e2e.test.ts`
// ("allowUnproven is gone"). A test driving `/jobs` + `/chunk` end to end would
// pin both halves in one place; `memberTest` is module-private and this suite
// has no route harness, so that is NOT covered here. The stranger test below is
// kept as a guard against a future implementation that returns everything.

const eventWith = (eventId: string, onChain: boolean) =>
  ({
    eventId,
    series: [onChain ? { swarmManifestRef: "ref", onChainEventId: "1" } : {}],
  }) as never;

test("PROPERTY: a proven attendee is a member — an unverified organiser can still say 'cancelled'", () => {
  const e = nextEvent();
  recordAttendeeEmail(e, "hash_alice", T);
  const { hashes } = getAttendeeEmailHashes(eventWith(e, true));
  assert.equal(
    hashes.has("hash_alice"),
    true,
    "with an empty set this was false for everyone, so no unverified organiser could reach any attendee",
  );
});

test("PROPERTY: a stranger is NOT a member, whatever the event's on-chain state", () => {
  const e = nextEvent();
  recordAttendeeEmail(e, "hash_alice", T);
  for (const onChain of [true, false]) {
    const { hashes } = getAttendeeEmailHashes(eventWith(e, onChain));
    assert.equal(
      hashes.has("hash_stranger"),
      false,
      "allowUnproven made this true for every verified organiser",
    );
  }
});

test("unverifiableSeries still counts on-chain series, but is a diagnostic and grants nothing", () => {
  const { hashes, unverifiableSeries } = getAttendeeEmailHashes(eventWith(nextEvent(), true));
  assert.equal(unverifiableSeries, 1);
  assert.equal(hashes.size, 0, "an unverifiable series must not widen the proven set");
});
