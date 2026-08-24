/**
 * The check-in routes must key their stores on the route parameter — the id
 * ownership was resolved against — not on the `eventId` carried inside the event
 * feed body.
 *
 * The two are equal for every legitimate event, which is what makes the bug
 * invisible: nothing misbehaves until someone makes them differ. A Phase B event
 * feed is a client-signed SOC that the server never writes, and
 * `readEventFeedSoc` does not reconcile the id inside the body with the topic it
 * was read from — so an organiser can produce a feed served at their own event's
 * topic whose body names someone else's event, with a `creatorAddress` they also
 * choose. Three routes here keyed stores on that body value, one of them a WRITE.
 *
 * Same class as #387 and #377 (#389).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../src/lib/checkin/store.js");

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-checkin-key-test-")));
  store = await import("../src/lib/checkin/store.js");
});

// ---------------------------------------------------------------------------
// Why the id choice matters at all
// ---------------------------------------------------------------------------

test("check-in stores are keyed per event, so keying on the wrong id reaches another event's records", () => {
  const victim = "evt_victim";
  const attacker = "evt_attacker";

  store.storeRoster(victim, { iv: "iv-v", ciphertext: "victim-roster", updatedAt: "2026-08-24T00:00:00.000Z" });
  store.storeRoster(attacker, { iv: "iv-a", ciphertext: "attacker-roster", updatedAt: "2026-08-24T00:00:00.000Z" });

  assert.equal(store.readRoster(victim)?.ciphertext, "victim-roster");
  assert.equal(store.readRoster(attacker)?.ciphertext, "attacker-roster");

  // The write is the serious direction: a roster stored under the wrong id
  // REPLACES the other event's roster rather than merely reading it.
  store.storeRoster(victim, { iv: "iv-x", ciphertext: "overwritten", updatedAt: "2026-08-24T01:00:00.000Z" });
  assert.equal(
    store.readRoster(victim)?.ciphertext,
    "overwritten",
    "storeRoster replaces by key — so the key had better be one the caller cannot choose freely",
  );
  assert.equal(store.readRoster(attacker)?.ciphertext, "attacker-roster", "and it is scoped to that key alone");
});

test("check-ins are read per event, so a wrong id would disclose another event's counts", () => {
  const a = "evt_counts_a";
  const b = "evt_counts_b";
  store.mergeCheckins(a, [
    { seriesId: "ser-1", edition: 1, deviceId: "dev-1", at: "2026-08-24T00:00:00.000Z", method: "scan" } as never,
  ]);
  assert.equal(store.readCheckins(a).length, 1);
  assert.equal(store.readCheckins(b).length, 0, "an unrelated event must read empty, not someone else's records");
});

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

/**
 * A source-text guard, in the spirit of `data-store-modes.test.ts`.
 *
 * The real property lives at the route layer, and those handlers sit behind
 * `requireAuth` plus the event-resolution stack, which this suite has no harness
 * for — so this asserts the next best thing that would actually catch a
 * reintroduction: no route in this file reads the id off the feed body.
 *
 * It is a text check and is stated as one. It does not prove the routes behave
 * correctly; it proves nobody has reached for the untrusted value again.
 */
test("no check-in route reads the event id from the feed body", () => {
  const src = readFileSync(new URL("../src/routes/checkin.ts", import.meta.url), "utf-8");

  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments — the module header names the bug on purpose
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  const hits = [...code.matchAll(/\bevent\.eventId\b/g)];
  assert.equal(
    hits.length,
    0,
    "use the `eventId` returned by loadOwnedEvent — the route parameter ownership was checked against",
  );
});
