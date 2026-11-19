/**
 * A listing overlay file that is there and cannot be understood is never
 * overwritten.
 *
 * It used to load as an empty overlay. The next listing change, or the
 * directory builder's reseed, then wrote a fresh file over it, and every
 * unlisted and deleted event's row went with it: no snapshot holds those.
 * A file that is simply not there is still an empty overlay, and still written.
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

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-listing-unreadable-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));
  FILE = join(dir, ".data", "event-listing-state.json");
  ls = await import("../src/lib/event/listing-state.js");
});

beforeEach(() => {
  rmSync(FILE, { force: true });
  ls.__resetListingStateForTest();
});

function card(eventId: string): SnapshotCard {
  return {
    eventId, title: eventId, imageHash: ("00".repeat(32)) as SnapshotCard["imageHash"],
    startDate: "2999-01-01", location: "", creatorAddress: ("0x" + "11".repeat(20)) as SnapshotCard["creatorAddress"],
    seriesCount: 1, totalTickets: 10, createdAt: "2026-01-01T00:00:00Z", tags: [],
  };
}

const UNREADABLE: Array<[string, string]> = [
  ["cut off mid-write", '{"e1":{"listed":true,"updatedAt":"2026-01-01T00:00:00Z"'],
  ["empty", ""],
  ["a list, not rows by event", "[]"],
  ["null", "null"],
];

for (const [what, bytes] of UNREADABLE) {
  test(`a file that is ${what} is left exactly as it is`, () => {
    writeFileSync(FILE, bytes);
    assert.deepEqual(ls.listingStateHealth(), { ok: false, unreadable: true, rows: 0 });
    assert.equal(ls.hasAnyRows(), false);

    // Everything that writes the overlay: a listing, the builder's reseed, an unlist, a delete.
    ls.setListed("new1", true, card("new1"), { explicitlyListed: true });
    ls.setListed("new2", true, card("new2"));
    ls.setListed("new2", false);
    ls.setTombstoned("gone1");
    assert.equal(readFileSync(FILE, "utf-8"), bytes, "the bytes an operator needs for the repair are untouched");

    // The server carries on from memory.
    assert.equal(ls.isExplicitlyListed("new1"), true);
    assert.equal(ls.isListedForSnapshot("new2"), false);
    assert.deepEqual(ls.listedEventIds(), ["new1"]);
    assert.equal(ls.listingStateHealth().ok, false, "red until the file is repaired and the server restarted");
  });
}

test("a file that is not there is an empty overlay, and the first change writes it", () => {
  assert.equal(existsSync(FILE), false);
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 0 });
  ls.setListed("e1", true, card("e1"));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf-8"))), ["e1"]);
});

test("a readable file loads, and a change is written back with the rows it already held", () => {
  const rows = {
    kept: { listed: false, tombstoned: true, updatedAt: "2026-01-01T00:00:00Z" },
    live: { listed: true, explicitlyListed: true, updatedAt: "2026-01-01T00:00:00Z" },
  };
  writeFileSync(FILE, JSON.stringify(rows));
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 2 });
  assert.equal(ls.isExplicitlyListed("live"), true);
  ls.setListed("e2", true, card("e2"));
  const written = JSON.parse(readFileSync(FILE, "utf-8"));
  assert.deepEqual(Object.keys(written).sort(), ["e2", "kept", "live"]);
  assert.equal(written.kept.tombstoned, true);
});

test("after the repair, a restart reads the file again", () => {
  writeFileSync(FILE, "{ not json");
  assert.equal(ls.listingStateHealth().unreadable, true);
  writeFileSync(FILE, JSON.stringify({ live: { listed: true, updatedAt: "2026-01-01T00:00:00Z" } }));
  ls.__resetListingStateForTest();
  assert.deepEqual(ls.listingStateHealth(), { ok: true, unreadable: false, rows: 1 });
  assert.equal(ls.isListedForSnapshot("live"), true);
});
