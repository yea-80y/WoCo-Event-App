/**
 * One phone, several events at once (owner requirement, 2026-10-14): two doors in
 * two tabs, or one door switching between them, with no tab closing and no
 * prompts. Each tab keeps its own event in a NON-secret URL marker, so a reload
 * reopens that tab's event and setting one up in another tab never changes it.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDoorPassUrl, parseDoorPassFragment, type CheckinPack, type CheckinRecord } from "@woco/shared";
import {
  chooseEvent,
  ENDED_RECORDS_KEPT_MS,
  endedAtMs,
  endedEventCleanup,
  eventMarker,
  isLive,
  liveEvents,
  parseEventMarker,
  type PassSummary,
} from "../src/lib/scanner/events.js";
import { storeKey } from "../src/lib/scanner/scope.js";
import * as db from "../src/lib/scanner/db.js";

const NOW = 1_800_000_000_000;
const LIVE = Math.floor(NOW / 1000) + 3600;
const A: PassSummary = { eventId: "event-a", exp: LIVE, lastUsedAt: NOW - 60_000 };
const B: PassSummary = { eventId: "event-b", exp: LIVE, lastUsedAt: NOW - 1_000 };
const EXPIRED: PassSummary = { eventId: "event-old", exp: Math.floor(NOW / 1000) - 60, lastUsedAt: NOW };
const DEAD: PassSummary = { eventId: "event-revoked", exp: LIVE, lastUsedAt: NOW, dead: "Door pass revoked" };

test("two events on one phone: each tab's reload reopens its own event", () => {
  assert.deepEqual(chooseEvent("event-a", [A, B], NOW), { kind: "open", eventId: "event-a" }, "B set up later in another tab changes nothing here");
  assert.deepEqual(chooseEvent("event-b", [A, B], NOW), { kind: "open", eventId: "event-b" });
});

test("a fresh open (home-screen icon, bare URL) opens the most recently used live event", () => {
  assert.deepEqual(chooseEvent(null, [A, B, EXPIRED, DEAD], NOW), { kind: "open", eventId: "event-b" });
  assert.deepEqual(chooseEvent(null, [], NOW), { kind: "none" });
});

test("a tab whose event ended says so - it never quietly becomes another event's door", () => {
  assert.deepEqual(chooseEvent("event-old", [EXPIRED, B], NOW), { kind: "ended", eventId: "event-old", reason: "expired" });
  assert.deepEqual(chooseEvent("event-revoked", [DEAD, B], NOW), { kind: "ended", eventId: "event-revoked", reason: "dead", message: "Door pass revoked" });
  assert.deepEqual(chooseEvent("event-removed", [B], NOW), { kind: "none" }, "removed in another tab: nothing, not B");
  assert.deepEqual(chooseEvent(null, [EXPIRED], NOW), { kind: "ended", eventId: "event-old", reason: "expired" });
});

test("the switcher offers live passes only, most recently used first", () => {
  assert.deepEqual(liveEvents([A, EXPIRED, B, DEAD], NOW).map((p) => p.eventId), ["event-b", "event-a"]);
});

test("the URL marker carries the event id and nothing secret", () => {
  const token = "v1.ZXZlbnQtYQ.0123456789abcdef.1800003600." + "ab".repeat(32);
  const key = "c2VjcmV0LXJvc3Rlci1rZXktZm9yLXRoZS1kb29y";
  const marker = eventMarker("event-a");
  assert.equal(marker, "#/e/event-a");
  assert.ok(!marker.includes(token) && !marker.includes(key) && !marker.includes("/p/"));
  assert.equal(parseDoorPassFragment(marker), null, "never mistaken for a pass");
  assert.equal(parseEventMarker(new URL(buildDoorPassUrl("https://scan.test", token, key)).hash), null, "a pass is never read as a marker");
  for (const id of ["event-a", "e0000000-0000-4000-8000-000000000001", "odd/id with spaces"]) {
    assert.equal(parseEventMarker(eventMarker(id)), id);
  }
});

test("an ended event's attendee data goes at once; the rest once nothing is waiting to sync", () => {
  const pending = [storeKey("event-old", "ser-1", 1)];
  assert.deepEqual(endedEventCleanup([A, EXPIRED, DEAD], pending, NOW), { clear: ["event-revoked"], dropAttendeeData: ["event-old"] });
  assert.deepEqual(endedEventCleanup([A, B], [], NOW), { clear: [], dropAttendeeData: [] }, "live events are never touched");
});

test("an ended pass's unsynced check-ins go 30 days after it ended - never a live pass's", () => {
  const pending = [storeKey("event-old", "ser-1", 1), storeKey("event-a", "ser-1", 1)];
  const ended = EXPIRED.exp * 1000;
  const farLive = { ...A, exp: Math.floor(NOW / 1000) + 10 * 365 * 86400 };
  assert.deepEqual(endedEventCleanup([farLive, EXPIRED], pending, ended + ENDED_RECORDS_KEPT_MS - 1), { clear: [], dropAttendeeData: ["event-old"] });
  assert.deepEqual(endedEventCleanup([farLive, EXPIRED], pending, ended + ENDED_RECORDS_KEPT_MS), { clear: ["event-old"], dropAttendeeData: [] });
  assert.deepEqual(endedEventCleanup([farLive], pending, ended + 5 * ENDED_RECORDS_KEPT_MS), { clear: [], dropAttendeeData: [] });
  assert.equal(ENDED_RECORDS_KEPT_MS, 30 * 24 * 60 * 60 * 1000);
});

test("the server's 'expired' ends a pass the phone's clock still calls live, and the 30 days run from it", () => {
  const told = { ...A, expiredAt: NOW - 1000 };
  assert.equal(isLive(A, NOW), true);
  assert.equal(isLive(told, NOW), false);
  assert.equal(endedAtMs(told), NOW - 1000, "the earlier of exp and the server's word");
  assert.equal(endedAtMs(EXPIRED), EXPIRED.exp * 1000);
  assert.deepEqual(chooseEvent("event-a", [told], NOW), { kind: "ended", eventId: "event-a", reason: "expired" });
});

// ---------------------------------------------------------------------------
// Storage: per event, and a reset removes one event only
// ---------------------------------------------------------------------------

const pack = (eventId: string): CheckinPack => ({ v: 1, eventId, eventTitle: eventId, series: [], checkins: [], generatedAt: "2026-10-14T18:00:00.000Z" });
const rec = (seriesId: string, edition: number): CheckinRecord => ({ seriesId, edition, at: "2026-10-14T19:00:00.000Z", deviceId: "dev00001", method: "scan" });
const stored = (eventId: string): db.StoredPass => ({ token: `tok-${eventId}`, keyB64url: `key-${eventId}`, eventId, exp: LIVE });

async function provisionInStorage(eventId: string) {
  await db.putPass(stored(eventId));
  await db.putPack(pack(eventId));
  await db.putRoster(eventId, [{ seriesId: "ser-1", edition: 1, name: `guest of ${eventId}` }]);
  await db.putConflicts(eventId, []);
  await db.checkAndMark(eventId, rec("ser-1", 1));
  await db.setPendingClaimId(eventId, "ser-1", 2, `claim-${eventId}`);
}

test("two events are stored side by side; setting one up never replaces the other", async () => {
  db.useIndexedDbForTests(new IDBFactory());
  await provisionInStorage("event-a");
  await provisionInStorage("event-b");
  for (const id of ["event-a", "event-b"]) {
    assert.equal((await db.getPass(id))?.token, `tok-${id}`);
    assert.equal((await db.getPack(id))?.eventTitle, id);
    assert.equal((await db.getRoster(id))?.[0].name, `guest of ${id}`);
    assert.equal((await db.getAllCheckins(id)).length, 1);
    assert.equal(await db.getPendingClaimId(id, "ser-1", 2), `claim-${id}`);
  }
  assert.equal((await db.getAllPasses()).length, 2);
});

test("a reset removes the current event only - every other event, and its tabs, untouched", async () => {
  db.useIndexedDbForTests(new IDBFactory());
  await provisionInStorage("event-a");
  await provisionInStorage("event-b");
  await db.clearEvent("event-a");
  assert.equal(await db.getPass("event-a"), undefined);
  assert.equal(await db.getPack("event-a"), undefined);
  assert.equal(await db.getRoster("event-a"), undefined);
  assert.deepEqual(await db.getAllCheckins("event-a"), []);
  assert.deepEqual(await db.getPending("event-a"), []);
  assert.equal(await db.getPendingClaimId("event-a", "ser-1", 2), undefined);
  assert.equal((await db.getPass("event-b"))?.token, "tok-event-b");
  assert.equal((await db.getRoster("event-b"))?.length, 1);
  assert.equal((await db.getAllCheckins("event-b")).length, 1);
  assert.equal((await db.getPending("event-b")).length, 1);
  assert.equal(await db.getPendingClaimId("event-b", "ser-1", 2), "claim-event-b");
});

test("dropping an ended event's attendee data keeps its unsynced check-ins, and not its pass secret", async () => {
  db.useIndexedDbForTests(new IDBFactory());
  await provisionInStorage("event-a");
  await db.putDoorEntries("event-a", "tok-event-a", { jti: "j", next: 1, entries: [{ seriesId: "ser-1", edition: 3, email: "b@example.com", source: "sale" }], tombstones: [] });
  await db.dropAttendeeData("event-a", NOW);
  assert.equal(await db.getRoster("event-a"), undefined);
  assert.equal(await db.getPack("event-a"), undefined);
  assert.equal(await db.getDoorEntries("event-a"), undefined);
  assert.equal((await db.getPending("event-a")).length, 1);
  const pass = await db.getPass("event-a");
  assert.ok(pass, "what is left of its pass stays, so the event is still known to be waiting");
  assert.equal(pass.token, "");
  assert.equal(pass.keyB64url, "");
  assert.equal(isLive(pass, NOW), false, "and it never opens again");
});

test("marking a pass dead and recording its use never undo each other", async () => {
  db.useIndexedDbForTests(new IDBFactory());
  await db.putPass(stored("event-a"));
  await Promise.all([db.markPassDead("event-a", "Door pass revoked"), db.touchPass("event-a", NOW)]);
  const p = await db.getPass("event-a");
  assert.equal(p?.dead, "Door pass revoked");
  assert.equal(p?.lastUsedAt, NOW);
});

// ---------------------------------------------------------------------------
// The store uses these rules (runes code; checked at source)
// ---------------------------------------------------------------------------

const src = readFileSync(new URL("../src/lib/scanner/store.svelte.ts", import.meta.url), "utf8");
const body = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

test("boot opens the tab's own event by its marker, through chooseEvent", () => {
  assert.match(body("private async boot()", "async openEvent("), /chooseEvent\(parseEventMarker\(location\.hash\), await db\.getAllPasses\(\), Date\.now\(\)\)/);
});

test("the URL only ever gets the event marker, written from the event id", () => {
  const show = body("private showEventInUrl(", "private forgetEventInUrl(");
  assert.match(show, /history\.replaceState\(null, "", new URL\(eventMarker\(eventId\), location\.href\)\.href\)/);
  assert.equal((src.match(/doorPassFragment\(/g) ?? []).length, 1, "the pass goes back in the URL in one place only: the reload into a new version");
});

test("reset clears this tab's event and nothing else", () => {
  const reset = body("async reset()", "// ── internals");
  assert.match(reset, /const eventId = this\.pass\?\.eventId;/);
  assert.match(reset, /if \(eventId\) await db\.clearEvent\(eventId\);/);
  assert.doesNotMatch(reset, /getAllPasses|resetDevice/);
});

test("provisioning writes this event's pass only, and no BroadcastChannel switches other tabs", () => {
  assert.match(body("async provision(", "private passFromUrl("), /await db\.putPass\(pass\);/);
  assert.doesNotMatch(src, /BroadcastChannel/);
});
