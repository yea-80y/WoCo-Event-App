/**
 * A listing overlay file that is there and cannot be understood is never
 * overwritten, what people change while it is broken outlives the repair, and a
 * listing that did not load never shrinks the public directory.
 *
 * The file used to load as an empty overlay. The next listing change, or the
 * directory builder's reseed, then wrote a fresh file over it, and every
 * unlisted and deleted event's row went with it: no snapshot holds those.
 * Three things have to hold together:
 *  - the file is left alone;
 *  - a cancel, takedown, unlist or delete made while it is broken goes to a side
 *    file, or the repaired file's older rows would list that event again;
 *  - memory is INCOMPLETE until the builder has restored the last snapshot's
 *    events, whatever rows it already holds. Asking "are there no rows?" was
 *    answered "no" by one change (or by the side file), and the next rebuild
 *    then published a directory of that one event;
 *  - the file on disk is never a partial one. A file that is not there is
 *    incomplete too, and a change written to it before the restore loaded as
 *    the whole listing after a restart. Until the restore, changes go to the
 *    side file, and the restore writes the file.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventsSnapshot, SnapshotCard } from "@woco/shared";

type LS = typeof import("../src/lib/event/listing-state.js");
type Snap = typeof import("../src/lib/event/directory-snapshot.js");
let ls: LS;
let snap: Snap;
let feeds: typeof import("../src/lib/swarm/feeds.js");
let DATA: string;
let FILE: string;
let PENDING: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-listing-unreadable-"));
  process.chdir(dir);
  DATA = join(dir, ".data");
  mkdirSync(DATA);
  FILE = join(DATA, "event-listing-state.json");
  PENDING = join(DATA, "event-listing-state.pending.json");
  ls = await import("../src/lib/event/listing-state.js");
  snap = await import("../src/lib/event/directory-snapshot.js");
  feeds = await import("../src/lib/swarm/feeds.js");
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
const BROKEN = "{ not json";
/** A restart: memory forgotten, the files read again. */
const restart = () => ls.__resetListingStateForTest();
const pendingIds = () => Object.keys(JSON.parse(readFileSync(PENDING, "utf-8"))).sort();

/**
 * One rebuild by the real directory builder, against a last snapshot that lists
 * `listed`, or one bee cannot read ("unreadable"). Every listed event resolves,
 * nothing is registered. Returns the ids the rebuild published, or null when it
 * found nothing to change.
 */
async function rebuildAgainst(listed: string[] | "unreadable"): Promise<string[] | null> {
  const REF = "ab".repeat(32);
  const cards = listed === "unreadable" ? [] : listed.map((id) => card(id));
  const last: EventsSnapshot = { v: 1, builtAt: AT, registrationCount: 0, cards, resolution: [] };
  let published: string[] | null = null;
  snap._setSnapshotIoForTest({
    readPointer: async () => listed === "unreadable"
      ? { status: "error", error: new Error("bee could not read the feed") }
      : { status: "ok", data: feeds.encodeJsonFeed({ v: 1, snapshotRef: REF, builtAt: AT, count: listed.length }) },
    readBlob: async () => JSON.stringify(last),
    writeBlob: async (json) => {
      published = (JSON.parse(json) as EventsSnapshot).cards.map((c) => c.eventId).sort();
      return REF as never;
    },
    writePointer: async () => undefined,
    resolveCard: async (entry) => card(entry.wocoEventId),
    registrations: () => [],
    activeChainId: () => 42161,
  });
  try {
    await snap.rebuildSnapshot({ full: true });
    return published;
  } finally {
    snap._setSnapshotIoForTest(null);
  }
}

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
    assert.equal(ls.needsRestoreFromSnapshot(), true);

    // Everything that writes the overlay: a listing, an unlist, a delete, and the builder's restore.
    ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
    ls.setListed("new2", true, card("new2"));
    ls.setListed("new2", false);
    ls.setTombstoned("gone1");
    assert.equal(ls.restoreFromSnapshot([card("snap1")]), 1);
    assert.equal(readFileSync(FILE, "utf-8"), bytes, "the bytes an operator needs for the repair are untouched");

    // The server carries on from memory.
    assert.equal(ls.isExplicitlyListed("new1"), true);
    assert.equal(ls.isListedForSnapshot("new2"), false);
    assert.deepEqual(ls.listedEventIds().sort(), ["new1", "snap1"]);
    assert.equal(ls.listingStateHealth().ok, false, "red until the file is repaired and the server restarted");
  });
}

test("while the file is unreadable, what people change is kept in the side file; restored rows are not", () => {
  writeFileSync(FILE, BROKEN);
  ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
  ls.setListed("new2", false);
  ls.setTombstoned("gone1");
  ls.restoreFromSnapshot([card("snap1")]);
  assert.deepEqual(pendingIds(), ["gone1", "new1", "new2"]);
  assert.equal(ls.listingStateHealth().pending, 3);
});

test("the restore never writes over a row that is there", () => {
  writeFileSync(FILE, BROKEN);
  ls.setListed("unlisted", false);
  ls.setTombstoned("deleted");
  assert.equal(ls.restoreFromSnapshot([card("unlisted"), card("deleted"), card("s1")]), 1, "only the event with no row");
  assert.equal(ls.isListedForSnapshot("unlisted"), false);
  assert.equal(ls.isListedForSnapshot("deleted"), false);
  assert.equal(ls.isExplicitlyListed("s1"), true);
  assert.equal(ls.needsRestoreFromSnapshot(), false);
});

test("a restart while the file is still unreadable keeps those changes, and still needs the restore", () => {
  writeFileSync(FILE, BROKEN);
  ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
  ls.setTombstoned("gone1");
  ls.restoreFromSnapshot([card("s1")]);
  restart();
  assert.deepEqual(ls.listingStateHealth(), { ok: false, unreadable: true, rows: 2, pending: 2 });
  assert.equal(ls.needsRestoreFromSnapshot(), true, "rows from the side file are not the whole listing");
  assert.equal(ls.isExplicitlyListed("new1"), true);
  ls.setListed("gone1", true, card("gone1"), { explicitlyListed: true });
  assert.equal(ls.isListedForSnapshot("gone1"), false, "the delete still holds");
  assert.equal(readFileSync(FILE, "utf-8"), BROKEN);
});

test("the builder: a change made before the first rebuild, then a restart, does not shrink the directory", async () => {
  // The reported failure: file unreadable, one event created, a restart before the repair.
  writeFileSync(FILE, BROKEN);
  ls.setListed("created", true, card("created"), { explicitlyListed: true });
  ls.setListed("s2", false); // and one event taken down while it is broken
  restart();

  const published = await rebuildAgainst(["s1", "s2", "s3"]);
  assert.deepEqual(published, ["created", "s1", "s3"], "every listed event is kept, the takedown holds, the new event is added");
  assert.equal(readFileSync(FILE, "utf-8"), BROKEN);
  assert.deepEqual(pendingIds(), ["created", "s2"], "restored rows are not changes: the repaired file knows better");
});

test("the builder: with the file unreadable and nothing changed, the directory keeps its events and nothing is published", async () => {
  writeFileSync(FILE, BROKEN);
  assert.equal(await rebuildAgainst(["s1", "s2"]), null);
  assert.deepEqual(ls.listedEventIds().sort(), ["s1", "s2"]);
  assert.equal(readFileSync(FILE, "utf-8"), BROKEN);
  assert.equal(existsSync(PENDING), false);
});

test("the builder: a lost file is restored even when a change came before the first rebuild", async () => {
  // On main one change made `hasAnyRows()` true, the reseed was skipped and the directory shrank to that event.
  assert.equal(existsSync(FILE), false);
  ls.setListed("created", true, card("created"), { explicitlyListed: true });
  const published = await rebuildAgainst(["s1", "s2"]);
  assert.deepEqual(published, ["created", "s1", "s2"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))).sort(), ["created", "s1", "s2"], "and the lost file is rebuilt");
  assert.equal(existsSync(PENDING), false, "the change waited beside the file and is in it now");
  assert.equal(ls.listingStateHealth().pending, 0);
  restart();
  assert.equal(ls.needsRestoreFromSnapshot(), false, "the file on disk is the whole listing");
});

test("the builder: a lost file, a change, then a restart before the first rebuild, does not shrink the directory", async () => {
  // The change used to be written straight to a new file: one row, read after the restart as the whole listing.
  ls.setListed("created", true, card("created"), { explicitlyListed: true });
  restart();
  assert.equal(ls.needsRestoreFromSnapshot(), true, "one change is not the whole listing, across a restart too");
  assert.deepEqual(await rebuildAgainst(["s1", "s2"]), ["created", "s1", "s2"]);
});

test("the builder: a broken file removed instead of repaired, then two restarts, does not shrink the directory", async () => {
  writeFileSync(FILE, BROKEN);
  ls.setListed("s2", false); // taken down while it was broken
  rmSync(FILE);              // the operator has no good copy and removes it
  restart();
  assert.equal(ls.needsRestoreFromSnapshot(), true);
  assert.equal(existsSync(FILE), false, "the takedown alone is not written as the listing");
  assert.deepEqual(pendingIds(), ["s2"]);
  restart();
  assert.equal(ls.needsRestoreFromSnapshot(), true, "and a second start still knows the listing is not whole");
  assert.deepEqual(await rebuildAgainst(["s1", "s2", "s3"]), ["s1", "s3"], "every other event is kept and the takedown holds");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))).sort(), ["s1", "s2", "s3"]);
  assert.equal(existsSync(PENDING), false);
});

test("the builder: a lost file and a snapshot bee cannot read stay refused across a restart, whatever was changed", async () => {
  ls.setListed("created", true, card("created"), { explicitlyListed: true });
  await assert.rejects(rebuildAgainst("unreadable"), /listing overlay is incomplete/);
  restart();
  await assert.rejects(rebuildAgainst("unreadable"), /listing overlay is incomplete/, "not a directory of the one event that changed");
  assert.equal(existsSync(FILE), false);
  assert.equal(ls.isExplicitlyListed("created"), true, "the change itself is kept");
});

test("after the repair, a restart applies those changes over the repaired file and removes the side file", () => {
  writeFileSync(FILE, BROKEN);
  ls.setListed("cancelled", false);               // cancelled, taken down or unlisted while the file was broken
  ls.setTombstoned("deleted");                    // deleted while it was broken
  ls.setListed("created", true, card("created")); // created while it was broken
  ls.restoreFromSnapshot([card("restored")]);

  // The operator restores an older copy: both removed events are still listed in it.
  writeFileSync(FILE, JSON.stringify({
    cancelled: { listed: true, explicitlyListed: true, updatedAt: AT },
    deleted: { listed: true, explicitlyListed: true, updatedAt: AT },
    restored: { listed: true, updatedAt: AT },
    untouched: { listed: false, tombstoned: true, updatedAt: AT },
  }));
  restart();

  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 5, pending: 0 });
  assert.equal(ls.needsRestoreFromSnapshot(), false, "the file loaded: the listing is whole");
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

test("a side file the start-up rewrite could not apply is removed by the next write that lands", { skip: process.getuid?.() === 0 }, () => {
  writeFileSync(FILE, BROKEN);
  ls.setListed("cancelled", false);
  writeFileSync(FILE, JSON.stringify({ cancelled: { listed: true, updatedAt: AT } }));
  chmodSync(DATA, 0o500); // the repaired file is readable, and nothing can be written beside it
  try {
    restart();
    assert.equal(ls.isListedForSnapshot("cancelled"), false, "the change is in effect all the same");
    assert.equal(existsSync(PENDING), true, "and still on disk: the file does not hold it yet");
  } finally {
    chmodSync(DATA, 0o700);
  }
  ls.setListed("cancelled", true, card("cancelled"), { explicitlyListed: true });
  assert.equal(existsSync(PENDING), false, "the file holds everything now");
  restart();
  assert.equal(ls.isListedForSnapshot("cancelled"), true, "so the older change is not applied again over the newer one");
});

test("a side file that cannot be understood is not applied, not overwritten, and is an alarm", () => {
  writeFileSync(FILE, JSON.stringify({ live: { listed: true, updatedAt: AT } }));
  writeFileSync(PENDING, BROKEN);
  assert.deepEqual(ls.listingStateHealth(), { ok: false, unreadable: false, rows: 1, pending: 0 });
  assert.equal(ls.isListedForSnapshot("live"), true);
  assert.equal(readFileSync(PENDING, "utf-8"), BROKEN);

  // With the main file broken as well, changes cannot be kept: the side file still is not written over.
  restart();
  writeFileSync(FILE, BROKEN);
  ls.setListed("new1", true, card("new1"));
  assert.equal(readFileSync(PENDING, "utf-8"), BROKEN);
});

test("a file that is not there has no rows and needs the restore; a change waits beside it until then", () => {
  assert.equal(existsSync(FILE), false);
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 0, pending: 0 });
  assert.equal(ls.needsRestoreFromSnapshot(), true, "it may have been lost: only the last snapshot can say what was listed");

  ls.setListed("e1", true, card("e1"));
  assert.equal(existsSync(FILE), false, "one row is not the whole listing, and a file holding it would load as whole");
  assert.deepEqual(pendingIds(), ["e1"]);
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 1, pending: 1 });

  restart();
  assert.equal(ls.isListedForSnapshot("e1"), true, "the change is kept across the restart");
  assert.equal(existsSync(FILE), false, "and the start does not write the file from the side file");
  assert.equal(ls.needsRestoreFromSnapshot(), true);

  assert.equal(ls.restoreFromSnapshot([card("s1")]), 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))).sort(), ["e1", "s1"], "written once memory is whole");
  assert.equal(existsSync(PENDING), false);
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 2, pending: 0 });

  ls.setListed("e2", true, card("e2"));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))).sort(), ["e1", "e2", "s1"], "and changes go to the file from then on");
  assert.equal(existsSync(PENDING), false);
});

test("a file that is not there, with a change and nothing to restore, is still written by the restore", () => {
  // A new server: no snapshot has ever listed anything.
  ls.setListed("e1", true, card("e1"));
  assert.equal(ls.restoreFromSnapshot([]), 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))), ["e1"]);
  assert.equal(existsSync(PENDING), false);
  restart();
  assert.equal(ls.needsRestoreFromSnapshot(), false);
  assert.equal(ls.isListedForSnapshot("e1"), true);
});

test("a file that is not there, with nothing changed and nothing to restore, is not written", () => {
  assert.equal(ls.restoreFromSnapshot([]), 0);
  assert.equal(existsSync(FILE), false);
  assert.equal(existsSync(PENDING), false);
});

test("a readable file loads whole, and a change is written back with the rows it already held", () => {
  const rows = {
    kept: { listed: false, tombstoned: true, updatedAt: AT },
    live: { listed: true, explicitlyListed: true, updatedAt: AT },
  };
  writeFileSync(FILE, JSON.stringify(rows));
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 2, pending: 0 });
  assert.equal(ls.needsRestoreFromSnapshot(), false);
  assert.equal(ls.isExplicitlyListed("live"), true);
  ls.setListed("e2", true, card("e2"));
  const written = JSON.parse(readFileSync(FILE, "utf-8"));
  assert.deepEqual(Object.keys(written).sort(), ["e2", "kept", "live"]);
  assert.equal(written.kept.tombstoned, true);
});

test("an empty listing file is whole: nothing is listed, and nothing is restored", async () => {
  writeFileSync(FILE, "{}");
  assert.equal(ls.needsRestoreFromSnapshot(), false);
  assert.deepEqual(await rebuildAgainst(["s1", "s2"]), [], "the operator's way to say \"start from nothing listed\"");
});
