/**
 * After the event, the scanner deletes its attendee data on its own (owner,
 * 2026-10-15). When a pass expires - its `exp`, the event end + 24 h, on the phone's
 * clock, or the server's 401 `expired` - that event's decrypted roster, door entries,
 * pack (it carries the roster ciphertext) and the pass itself (token + pass secret)
 * go: at boot, on the refresh tick and when the tab comes back. Its check-ins hold no
 * names; unsynced ones stay, still counted, until 30 days after the pass ended. A live
 * pass, and every other event, is never touched.
 *
 * MUTATION (each goes red here): drop `expiredAt` from `isLive` and "the server's
 * 401 expired" goes red; keep unsynced records forever (no 30-day clear) and "then
 * they go" goes red; keep the token in `dropEndedEventDataIn` and every "pass is
 * gone" assertion goes red; drop the clean-up from the refresh tick, the "came back"
 * handler or boot and its test goes red; leave the tab on an expired event and "the
 * tab leaves" goes red; skip the in-transaction re-check and "a pass set up meanwhile"
 * goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CheckinRecord } from "@woco/shared";
import { PASS_EXPIRED_MESSAGE } from "../src/lib/scanner/pass-gate.js";
import { ENDED_RECORDS_KEPT_MS } from "../src/lib/scanner/events.js";
import {
  clock,
  db,
  DAY,
  EntriesLog,
  fakeDocument,
  fire,
  HOUR,
  makePass,
  openTab,
  removeCompiledStore,
  resetWorld,
  server,
  seriesId,
  settle,
  storeEvent,
  tick,
  type TestPass,
} from "./scanner-store-harness.ts";

test.after(removeCompiledStore);
test.beforeEach(resetWorld);

const A = "event-a";
const B = "event-b";
const nowS = () => Math.floor(Date.now() / 1000);
const REFRESH_TICK_MS = 15_000;

const rec = (eventId: string, edition: number): CheckinRecord => ({
  seriesId: seriesId(eventId),
  edition,
  at: "2026-10-14T19:00:00.000Z",
  deviceId: "dev00001",
  method: "scan",
});

/** An event as a phone holds it after a night at the door: pass, pack with roster ciphertext, roster, door entries, check-ins. */
async function eventOnPhone(pass: TestPass, opts: { unsynced?: number; synced?: number } = {}): Promise<void> {
  await storeEvent(pass, { roster: { iv: "aXY=", ciphertext: "Y2lwaGVy", updatedAt: "2026-10-14T18:00:00.000Z" } });
  await db.putRoster(pass.eventId, [{ seriesId: seriesId(pass.eventId), edition: 1, name: `Guest at ${pass.eventId}`, email: "guest@example.com" }]);
  await db.putDoorEntries(pass.eventId, pass.token, {
    jti: pass.jti,
    next: 1,
    entries: [{ seriesId: seriesId(pass.eventId), edition: 2, name: "Card Holder", email: "buyer@example.com", source: "sale" }],
    tombstones: [],
  });
  let edition = 10;
  for (let i = 0; i < (opts.unsynced ?? 0); i++) await db.checkAndMark(pass.eventId, rec(pass.eventId, edition++));
  for (let i = 0; i < (opts.synced ?? 0); i++) await db.absorbServerCheckins(pass.eventId, [rec(pass.eventId, edition++)], []);
}

async function assertAttendeeDataGone(eventId: string): Promise<void> {
  assert.equal(await db.getRoster(eventId), undefined, `${eventId}: decrypted roster`);
  assert.equal(await db.getPack(eventId), undefined, `${eventId}: pack (roster ciphertext)`);
  assert.equal(await db.getDoorEntries(eventId), undefined, `${eventId}: door entries`);
  const pass = await db.getPass(eventId);
  assert.equal(pass?.token ?? "", "", `${eventId}: pass token`);
  assert.equal(pass?.keyB64url ?? "", "", `${eventId}: pass secret`);
}

async function assertUntouched(pass: TestPass, checkins: number): Promise<void> {
  const eventId = pass.eventId;
  assert.equal((await db.getPass(eventId))?.token, pass.token, `${eventId}: pass`);
  assert.equal((await db.getPass(eventId))?.keyB64url, pass.keyB64url, `${eventId}: pass secret`);
  assert.ok(await db.getPack(eventId), `${eventId}: pack`);
  assert.equal((await db.getRoster(eventId))?.[0].name, `Guest at ${eventId}`);
  assert.equal((await db.getDoorEntries(eventId))?.entries.length, 1, `${eventId}: door entries`);
  assert.equal((await db.getAllCheckins(eventId)).length, checkins, `${eventId}: check-ins`);
}

test("boot: an expired pass's names, emails, pack, door entries and pass are gone; a live event beside it is untouched", async (t) => {
  const expired = makePass(A, "a".repeat(32), nowS() - 60);
  const live = makePass(B, "b".repeat(32));
  await eventOnPhone(expired, { synced: 1 });
  await eventOnPhone(live, { unsynced: 1, synced: 1 });
  server.handlers.set("/sync", () => new Promise<Response>(() => {})); // no answer: nothing syncs
  page_marker(A);

  const scanner = await openTab(t);
  await scanner.init();
  await settle();
  // Nothing unsynced: the event goes entirely, check-ins and all.
  assert.equal(await db.getPass(A), undefined);
  assert.equal(await db.getPack(A), undefined);
  assert.equal(await db.getRoster(A), undefined);
  assert.equal(await db.getDoorEntries(A), undefined);
  assert.deepEqual(await db.getAllCheckins(A), []);
  await assertUntouched(live, 2);
  assert.equal((await db.getPending(B)).length, 1, "a live event's unsynced check-in stays");
  assert.equal(scanner.provisionError, PASS_EXPIRED_MESSAGE, "the tab that showed it says why");
});

/** The tab's own event, as its URL marker. */
function page_marker(eventId: string): void {
  history.replaceState(null, "", `https://scan.test/#/e/${encodeURIComponent(eventId)}`);
}

test("the refresh tick: an open event whose pass expires leaves memory and storage; the tab leaves it", async (t) => {
  const pass = makePass(A, "a".repeat(32), nowS() + HOUR / 1000);
  const other = makePass(B, "b".repeat(32), nowS() + 3 * HOUR / 1000);
  await eventOnPhone(pass, { unsynced: 2 });
  await eventOnPhone(other, { unsynced: 1 });
  server.handlers.set("/sync", () => new Promise<Response>(() => {})); // no answer: nothing syncs

  const scanner = await openTab(t);
  assert.equal(await scanner.openEvent(A), true);
  assert.equal(scanner.attendees.length, 2, "roster + door entry shown while live");
  tick(REFRESH_TICK_MS);
  await settle();
  await assertUntouched(pass, 2);
  assert.equal(scanner.phase, "ready", "still live: nothing happens");

  clock.offsetMs = HOUR + 1000; // past A's exp, not B's
  tick(REFRESH_TICK_MS);
  await settle(60);
  assert.equal(scanner.phase, "unprovisioned");
  assert.equal(scanner.pass, null);
  assert.equal(scanner.attendees.length, 0, "the decrypted roster and door entries left memory");
  assert.equal(scanner.provisionError, PASS_EXPIRED_MESSAGE);
  await assertAttendeeDataGone(A);
  assert.equal((await db.getPending(A)).length, 2, "unsynced check-ins (no names) stay");
  assert.equal(scanner.otherUnsynced, 3, "and are still counted as waiting to sync");
  await assertUntouched(other, 1);
});

test("the tab coming back runs the clean-up", async (t) => {
  const pass = makePass(A, "a".repeat(32), nowS() + HOUR / 1000);
  await eventOnPhone(pass, { unsynced: 1 });
  const scanner = await openTab(t);
  await scanner.init();
  assert.equal(scanner.pass?.eventId, A);

  clock.offsetMs = HOUR + 1000;
  fakeDocument.visibilityState = "visible";
  fire("visibilitychange");
  await settle(60);
  assert.equal(scanner.phase, "unprovisioned");
  await assertAttendeeDataGone(A);
  assert.equal((await db.getPending(A)).length, 1);
});

test("unsynced check-ins of an expired pass stay until 30 days after it expired, then go", async (t) => {
  const pass = makePass(A, "a".repeat(32), nowS() - 60);
  const live = makePass(B, "b".repeat(32), nowS() + 400 * DAY / 1000);
  await eventOnPhone(pass, { unsynced: 2, synced: 1 });
  await eventOnPhone(live, { unsynced: 1 });
  const scanner = await openTab(t);
  await scanner.cleanUpEndedEvents();
  await assertAttendeeDataGone(A);
  assert.equal((await db.getPending(A)).length, 2);
  assert.equal((await db.getAllCheckins(A)).length, 3);
  assert.equal(scanner.otherUnsynced, 3);

  clock.offsetMs = ENDED_RECORDS_KEPT_MS - 2 * HOUR; // not quite 30 days after exp
  await scanner.cleanUpEndedEvents();
  assert.equal((await db.getPending(A)).length, 2, "inside the 30 days they stay");

  clock.offsetMs = ENDED_RECORDS_KEPT_MS + 1000;
  await scanner.cleanUpEndedEvents();
  assert.deepEqual(await db.getPending(A), []);
  assert.deepEqual(await db.getAllCheckins(A), []);
  assert.equal(await db.getPass(A), undefined, "the event is gone from the phone");
  assert.equal(scanner.otherUnsynced, 1, "only the live event's record is still counted");
  assert.equal((await db.getPending(B)).length, 1, "a live pass's check-ins are never removed, however long it has been");
  assert.equal((await db.getPass(B))?.token, live.token);
});

test("a server 401 'expired' cleans up the same way, whatever the phone's clock says", async (t) => {
  const pass = makePass(A, "a".repeat(32)); // a day left by the phone's clock
  await eventOnPhone(pass, { unsynced: 1 });
  server.handlers.set("/sync", () => Response.json({ ok: false, error: "Door pass expired", reason: "expired" }, { status: 401 }));
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.sync();
  await settle(60);

  assert.equal(scanner.phase, "unprovisioned");
  assert.equal(scanner.provisionError, PASS_EXPIRED_MESSAGE);
  await assertAttendeeDataGone(A);
  const stored = await db.getPass(A);
  assert.ok(stored?.expiredAt !== undefined && stored.dead === undefined, "recorded as expired, not dead");
  assert.equal((await db.getPending(A)).length, 1, "its unsynced check-in stays, counted");
  assert.equal(await scanner.openEvent(A), false, "it never opens again");
});

test("a 401 'expired' on the door entries poll, or on the pack, does the same", async (t) => {
  for (const path of ["/entries", "/pack"] as const) {
    resetWorld();
    const pass = makePass(A, "a".repeat(32));
    await eventOnPhone(pass);
    server.handlers.set(path, () => Response.json({ ok: false, error: "Door pass expired", reason: "expired" }, { status: 401 }));
    const scanner = await openTab(t);
    await scanner.openEvent(A);
    if (path === "/entries") await scanner.refreshDoorEntries();
    else await scanner.refreshPack();
    await settle(60);
    assert.equal(scanner.phase, "unprovisioned", path);
    await assertAttendeeDataGone(A);
  }
});

test("a refused pass that is not expired is dead as before: its attendee data goes, the tab keeps its banner", async (t) => {
  const pass = makePass(A, "a".repeat(32));
  await eventOnPhone(pass, { unsynced: 1 });
  server.handlers.set("/sync", () => Response.json({ ok: false, error: "Door pass revoked", reason: "revoked" }, { status: 401 }));
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  await scanner.sync();
  assert.equal(scanner.passDead, "Door pass revoked");
  assert.equal(scanner.phase, "ready");
  await scanner.cleanUpEndedEvents();
  await assertAttendeeDataGone(A);
  assert.equal((await db.getPass(A))?.dead, "Door pass revoked");
  assert.equal((await db.getPending(A)).length, 1);
});

test("a pass set up for the event while a clean-up was deciding is never touched", async (t) => {
  const old = makePass(A, "a".repeat(32), nowS() - 60);
  await eventOnPhone(old, { unsynced: 1 });
  // Planned against the old pass, then a tab stores a new one before the clean-up runs.
  const fresh = makePass(A, "b".repeat(32));
  await db.putPass({ token: fresh.token, keyB64url: fresh.keyB64url, eventId: A, exp: fresh.exp });
  await db.putPack({ v: 1, eventId: A, eventTitle: A, series: [], checkins: [], generatedAt: "2026-10-15T18:00:00.000Z" });
  assert.equal(await db.cleanUpEndedEvent(A, Date.now()), "keep");
  assert.equal((await db.getPass(A))?.token, fresh.token);
  assert.ok(await db.getPack(A));
  assert.equal((await db.getPending(A)).length, 1);
  void t;
});

test("a clock set back after the clean-up never reopens an expired pass", async (t) => {
  const pass = makePass(A, "a".repeat(32), nowS() - 60);
  await eventOnPhone(pass, { unsynced: 1 });
  const scanner = await openTab(t);
  await scanner.cleanUpEndedEvents();
  clock.offsetMs = -2 * DAY;
  assert.equal(await scanner.openEvent(A), false);
  assert.equal(scanner.events.length, 0);
});

test("a door entries reply that lands after the clean-up writes nothing back", async (t) => {
  const pass = makePass(A, "a".repeat(32), nowS() + HOUR / 1000);
  await eventOnPhone(pass);
  const log = await new EntriesLog(pass).add(5);
  let release!: () => void;
  let arrive!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrive = r));
  server.handlers.set("/entries", async (url, init) => {
    arrive();
    await held;
    return log.handler()(url, init);
  });
  const scanner = await openTab(t);
  await scanner.openEvent(A);
  const polling = scanner.refreshDoorEntries();
  await reached;
  clock.offsetMs = HOUR + 1000;
  await scanner.cleanUpEndedEvents();
  release();
  await polling;
  await assertAttendeeDataGone(A);
  assert.equal(await db.putDoorEntries(A, pass.token, { jti: pass.jti, next: 5, entries: [], tombstones: [] }), false, "storage refuses a scrubbed pass");
});

test("the clean-up runs from boot, the refresh tick and the tab coming back (source)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/scanner/store.svelte.ts", import.meta.url), "utf8");
  const between = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  assert.match(between("private async boot()", "async openEvent("), /await this\.cleanUpEndedEvents\(\);/);
  assert.match(between("private startSyncLoop()", "private stopLoops()"), /void this\.cleanUpEndedEvents\(\);/);
  assert.match(between("private onReturn()", "refreshDoorEntries()"), /void this\.cleanUpEndedEvents\(\);/);
  assert.match(between("private listen()", "private async boot()"), /addEventListener\("visibilitychange", \(\) => this\.onReturn\(\)\)/);
});
