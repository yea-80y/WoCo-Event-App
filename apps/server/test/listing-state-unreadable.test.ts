/**
 * A listing overlay file that is there and cannot be understood is never
 * overwritten, and what people change while it is broken outlives the repair.
 *
 * It used to load as an empty overlay. The next listing change, or the
 * directory builder's reseed, then wrote a fresh file over it, and every
 * unlisted and deleted event's row went with it: no snapshot holds those.
 * Leaving the file alone is half of it. The other half: a cancel, takedown,
 * unlist or delete made while it is broken goes to a side file, or the repaired
 * file's older rows would list that event again.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotCard } from "@woco/shared";

type LS = typeof import("../src/lib/event/listing-state.js");
let ls: LS;
let FILE: string;
let PENDING: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-listing-unreadable-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  FILE = join(dir, ".data", "event-listing-state.json");
  PENDING = join(dir, ".data", "event-listing-state.pending.json");
  ls = await import("../src/lib/event/listing-state.js");
});

beforeEach(() => {
  rmSync(FILE, { force: true });
  rmSync(PENDING, { force: true });
  ls.__resetListingStateForTest();
});

function card(eventId: string): SnapshotCard {
  return {
    eventId, title: eventId, imageHash: ("00".repeat(32)) as SnapshotCard["imageHash"],
    startDate: "2999-01-01", location: "", creatorAddress: ("0x" + "11".repeat(20)) as SnapshotCard["creatorAddress"],
    seriesCount: 1, totalTickets: 10, createdAt: "2026-01-01T00:00:00Z", tags: [],
  };
}

const AT = "2026-01-01T00:00:00Z";
/** A restart: memory forgotten, the files read again. */
const restart = () => ls.__resetListingStateForTest();
const pendingIds = () => Object.keys(JSON.parse(readFileSync(PENDING, "utf-8"))).sort();

const UNREADABLE: Array<[string, string]> = [
  ["cut off mid-write", `{"e1":{"listed":true,"updatedAt":"${AT}"`],
  ["empty", ""],
  ["a list, not rows by event", "[]"],
  ["null", "null"],
  ["holding a row that is null", `{"e1":{"listed":true,"updatedAt":"${AT}"},"e2":null}`],
  ["holding a row that is a string", `{"e1":"listed"}`],
  ["holding a row with no listed flag", `{"e1":{"updatedAt":"${AT}"}}`],
];

for (const [what, bytes] of UNREADABLE) {
  test(`a file that is ${what} is left exactly as it is`, () => {
    writeFileSync(FILE, bytes);
    assert.deepEqual(ls.listingStateHealth(), { ok: false, unreadable: true, rows: 0, pending: 0 });
    assert.equal(ls.hasAnyRows(), false);

    // Everything that writes the overlay: a listing, an unlist, a delete, and the builder's reseed.
    ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
    ls.setListed("new2", true, card("new2"));
    ls.setListed("new2", false);
    ls.setTombstoned("gone1");
    ls.setListed("snap1", true, card("snap1"), { explicitlyListed: true, fromSnapshot: true });
    assert.equal(readFileSync(FILE, "utf-8"), bytes, "the bytes an operator needs for the repair are untouched");

    // The server carries on from memory.
    assert.equal(ls.isExplicitlyListed("new1"), true);
    assert.equal(ls.isListedForSnapshot("new2"), false);
    assert.deepEqual(ls.listedEventIds().sort(), ["new1", "snap1"]);
    assert.equal(ls.listingStateHealth().ok, false, "red until the file is repaired and the server restarted");
  });
}

test("while the file is unreadable, what people change is kept in the side file; restored rows are not", () => {
  writeFileSync(FILE, "{ not json");
  ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
  ls.setListed("new2", false);
  ls.setTombstoned("gone1");
  ls.setListed("snap1", true, card("snap1"), { explicitlyListed: true, fromSnapshot: true });
  assert.deepEqual(pendingIds(), ["gone1", "new1", "new2"]);
  assert.equal(ls.listingStateHealth().pending, 3);
});

test("a restart while the file is still unreadable keeps those changes", () => {
  writeFileSync(FILE, "{ not json");
  ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
  ls.setTombstoned("gone1");
  restart();
  assert.deepEqual(ls.listingStateHealth(), { ok: false, unreadable: true, rows: 2, pending: 2 });
  assert.equal(ls.isExplicitlyListed("new1"), true);
  ls.setListed("gone1", true, card("gone1"), { explicitlyListed: true });
  assert.equal(ls.isListedForSnapshot("gone1"), false, "the delete still holds");
  assert.equal(readFileSync(FILE, "utf-8"), "{ not json");
});

test("after the repair, a restart applies those changes over the repaired file and removes the side file", () => {
  writeFileSync(FILE, "{ not json");
  ls.setListed("cancelled", false);            // cancelled, taken down or unlisted while the file was broken
  ls.setTombstoned("deleted");                 // deleted while it was broken
  ls.setListed("created", true, card("created")); // created while it was broken
  ls.setListed("restored", true, card("restored"), { explicitlyListed: true, fromSnapshot: true });

  // The operator restores an older copy: both removed events are still listed in it.
  writeFileSync(FILE, JSON.stringify({
    cancelled: { listed: true, explicitlyListed: true, updatedAt: AT },
    deleted: { listed: true, explicitlyListed: true, updatedAt: AT },
    restored: { listed: true, updatedAt: AT },
    untouched: { listed: false, tombstoned: true, updatedAt: AT },
  }));
  restart();

  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 5, pending: 0 });
  assert.equal(ls.isListedForSnapshot("cancelled"), false, "stays out of the directory");
  assert.equal(ls.isListedForSnapshot("deleted"), false);
  ls.setListed("deleted", true, card("deleted"), { explicitlyListed: true });
  assert.equal(ls.isListedForSnapshot("deleted"), false, "and stays deleted");
  assert.equal(ls.isListedForSnapshot("created"), true);
  assert.equal(ls.isExplicitlyListed("restored"), false, "a row the builder restored never overrides the repaired file");
  assert.equal(existsSync(PENDING), false, "applied once, then gone");

  const written = JSON.parse(readFileSync(FILE, "utf-8"));
  assert.deepEqual(Object.keys(written).sort(), ["cancelled", "created", "deleted", "restored", "untouched"]);
  assert.equal(written.cancelled.listed, false);
  assert.equal(written.deleted.tombstoned, true);
  assert.equal(written.untouched.tombstoned, true, "what the file already held is kept");

  restart();
  assert.equal(ls.isListedForSnapshot("cancelled"), false, "and it holds across the next restart, from the file alone");
});

test("a side file that cannot be understood is not applied, not overwritten, and is an alarm", () => {
  writeFileSync(FILE, JSON.stringify({ live: { listed: true, updatedAt: AT } }));
  writeFileSync(PENDING, "{ not json");
  assert.deepEqual(ls.listingStateHealth(), { ok: false, unreadable: false, rows: 1, pending: 0 });
  assert.equal(ls.isListedForSnapshot("live"), true);
  assert.equal(readFileSync(PENDING, "utf-8"), "{ not json");

  // With the main file broken as well, changes cannot be kept: the side file still is not written over.
  restart();
  writeFileSync(FILE, "{ not json");
  ls.setListed("new1", true, card("new1"));
  assert.equal(readFileSync(PENDING, "utf-8"), "{ not json");
});

test("the directory builder's reseed, run while the file is unreadable, restores the listing and keeps nothing as a change", async () => {
  const snap = await import("../src/lib/event/directory-snapshot.js");
  const feeds = await import("../src/lib/swarm/feeds.js");
  const REF = "ab".repeat(32);
  const last = { v: 1, builtAt: AT, registrationCount: 0, cards: [card("s1"), card("s2")], resolution: [] };
  let written = 0;
  snap._setSnapshotIoForTest({
    readPointer: async () => ({ status: "ok", data: feeds.encodeJsonFeed({ v: 1, snapshotRef: REF, builtAt: AT, count: 2 }) }),
    readBlob: async () => JSON.stringify(last),
    writeBlob: async () => { written++; return REF as never; },
    writePointer: async () => { written++; },
    resolveCard: async (entry) => card(entry.wocoEventId),
    registrations: () => [],
    activeChainId: () => 42161,
  });
  try {
    writeFileSync(FILE, "{ not json");
    await snap.rebuildSnapshot({ full: true });
    assert.deepEqual(ls.listedEventIds().sort(), ["s1", "s2"], "the directory keeps its events");
    assert.equal(written, 0, "and nothing had to be published");
    assert.equal(readFileSync(FILE, "utf-8"), "{ not json");
    assert.equal(existsSync(PENDING), false, "restored rows are not changes: the repaired file knows better");
  } finally {
    snap._setSnapshotIoForTest(null);
  }
});

test("a file that is not there is an empty overlay, and the first change writes it", () => {
  assert.equal(existsSync(FILE), false);
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 0, pending: 0 });
  ls.setListed("e1", true, card("e1"));
  ls.setListed("snap1", true, card("snap1"), { explicitlyListed: true, fromSnapshot: true });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))).sort(), ["e1", "snap1"], "a lost file is rebuilt from changes and from the reseed alike");
  assert.equal(existsSync(PENDING), false, "the side file is only for a file that is there and broken");
});

test("a readable file loads, and a change is written back with the rows it already held", () => {
  const rows = {
    kept: { listed: false, tombstoned: true, updatedAt: AT },
    live: { listed: true, explicitlyListed: true, updatedAt: AT },
  };
  writeFileSync(FILE, JSON.stringify(rows));
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 2, pending: 0 });
  assert.equal(ls.isExplicitlyListed("live"), true);
  ls.setListed("e2", true, card("e2"));
  const written = JSON.parse(readFileSync(FILE, "utf-8"));
  assert.deepEqual(Object.keys(written).sort(), ["e2", "kept", "live"]);
  assert.equal(written.kept.tombstoned, true);
});
