/**
 * Acceptance for #37 Fable fixes 1 & 2 — the listing decision logic the builder's
 * candidate loop (directory-snapshot.ts) runs. Exercised directly against the
 * listing-state overlay in an isolated temp .data dir.
 *
 * NOTE: the full doRebuild Swarm round-trip is NOT executed here — its uploads hit
 * the (production) bee via the dev tunnel. What Fixes 1 & 2 actually changed is the
 * enumeration / inclusion predicate and the reseed condition, all of which live in
 * these pure listing-state calls; that is what this asserts.
 *
 * Builder inclusion (see doRebuild):
 *   registered event   → isListedForSnapshot(id)
 *   UNregistered event → isExplicitlyListed(id)   (deliberate /list only)
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotCard } from "@woco/shared";

// listing-state pins DATA_DIR = cwd/.data at import, so chdir to an isolated temp
// dir and dynamic-import it after, keeping the real .data untouched.
type LS = typeof import("../src/lib/event/listing-state.js");
let ls: LS;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-listing-")));
  ls = await import("../src/lib/event/listing-state.js");
});

function card(eventId: string, extra: Partial<SnapshotCard> = {}): SnapshotCard {
  return {
    eventId, title: eventId, imageHash: ("00".repeat(32)) as SnapshotCard["imageHash"],
    startDate: "2999-01-01", location: "", creatorAddress: "0x0" as SnapshotCard["creatorAddress"],
    seriesCount: 1, totalTickets: 10, createdAt: "2026-01-01T00:00:00Z", tags: [], ...extra,
  };
}

test("(precondition) fresh overlay has no rows — the empty-overlay state Fix 2 guards", () => {
  assert.equal(ls.hasAnyRows(), false);
});

test("(c) empty overlay + prior snapshot ⇒ reseed populates rows (not an empty publish)", () => {
  // Simulate the builder's reseed loop over a non-empty base snapshot.
  const base = [card("s1"), card("s2", { apiUrl: "https://organiser.example" })];
  assert.equal(ls.hasAnyRows(), false); // would otherwise publish EMPTY, wiping the directory
  for (const c of base) ls.setListed(c.eventId, true, c, { explicitlyListed: true });
  assert.equal(ls.hasAnyRows(), true);
  for (const c of base) assert.equal(ls.isListedForSnapshot(c.eventId), true, `${c.eventId} kept`);
});

test("(a) federated /list row (seed+apiUrl, no on-chain registration) IS surfaced", () => {
  const fed = card("fed1", { apiUrl: "https://fed.example" });
  ls.setListed("fed1", true, fed, { explicitlyListed: true }); // the /list route path
  // Unregistered ⇒ builder gates on isExplicitlyListed; the card comes from the seed
  // (getEvent can't reach a remote server), which is where apiUrl lives.
  assert.equal(ls.isExplicitlyListed("fed1"), true);
  assert.equal(ls.getListingSeed("fed1")?.apiUrl, "https://fed.example");
});

test("(b) auto-listed-at-create, unregistered ⇒ NOT surfaced", () => {
  // createEventV2 seeds listed:true but NEVER explicitlyListed.
  ls.setListed("auto1", true, card("auto1"));
  assert.equal(ls.isListedForSnapshot("auto1"), true);   // it is listed…
  assert.equal(ls.isExplicitlyListed("auto1"), false);   // …but the UNregistered branch excludes it
});

test("unlist clears the flag; tombstone is terminal and forces listed:false", () => {
  ls.setListed("fed1", false);
  assert.equal(ls.isExplicitlyListed("fed1"), false);
  ls.setTombstoned("auto1");
  ls.setListed("auto1", true, undefined, { explicitlyListed: true }); // attempt re-list
  assert.equal(ls.isListedForSnapshot("auto1"), false); // tombstone wins
});
