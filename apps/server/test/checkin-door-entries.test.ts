/**
 * The live door attendee list: a door pass registers an X-Wing key signed by the
 * account's content-feed signer, each sale's email and card name are sealed to it at
 * fulfilment, and scanners read the log after a cursor.
 *
 * MUTATION: compare the recovered signer to anything but the event's feed signer and
 * "a session alone cannot register" goes red; drop the used-id check and "an old
 * statement cannot bring back an old pass" goes red; drop the exp check and "an
 * expired pass gets nothing" goes red; let a seal skip the re-read and "two sales at
 * once" goes red; give a removal `seq` from the log instead of `last` and "a cursor
 * sees a removal of the last line" goes red; let a sale overwrite an unreadable file and
 * "unreadable is never overwritten" goes red; drop the issue route's registration check
 * and the route-order guard goes red.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { doorPassSecret } from "@woco/shared/keyring/account-secret";
import { doorKeyRefOf, doorKeyRegistrationMessage } from "@woco/shared/checkin/door-keys";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { doorEntrySealContext, openBoxJson } from "@woco/shared/crypto/sealed-box";
import { deriveFeedSignerKey } from "@woco/shared/crypto/feed-signer";
import { signPersonalMessage } from "@woco/shared/crypto/issuing";
import type { DoorEntriesPage, DoorEntryPlaintext } from "@woco/shared";
import type { EventKeys } from "../src/lib/keyring/event-keys.js";

let store: typeof import("../src/lib/checkin/store.js");
let entries: typeof import("../src/lib/checkin/door-entries.js");
let doorKey: typeof import("../src/lib/checkin/door-key.js");
let app: Hono;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-door-entries-")));
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-door-entries";
  store = await import("../src/lib/checkin/store.js");
  entries = await import("../src/lib/checkin/door-entries.js");
  doorKey = await import("../src/lib/checkin/door-key.js");
  const { checkin } = await import("../src/routes/checkin.js");
  app = new Hono();
  app.route("/api/checkin", checkin);
});

const SECRET = "11".repeat(32);
const FEED_SIGNER = deriveFeedSignerKey(SECRET);
const SERIES = "5d6e7f80-0000-4000-8000-000000000002";
const DEV = "deviceaaaaaaaaaa";
let n = 0;
const newEvent = () => `3f2a9c1e-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const newJti = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
const soon = () => Math.floor(Date.now() / 1000) + 3600;

/** What the organiser's dashboard makes for a new pass. */
function organiserPass(eventId: string, jti = newJti(), signerHex = SECRET) {
  const p = doorPassSecret(hexToBytes(SECRET), eventId, jti);
  const kp = doorEntriesKeypair(p);
  const doorKeyHex = bytesToHex(kp.publicKey);
  const signer = deriveFeedSignerKey(signerHex);
  const sig = signPersonalMessage(doorKeyRegistrationMessage(eventId, jti, doorKeyRefOf(kp.publicKey)), hexToBytes(signer.privKey.slice(2)));
  return { jti, doorKey: doorKeyHex, sig, secretKey: kp.secretKey, doorKeyRef: doorKeyRefOf(kp.publicKey) };
}

const record = (feedSigner = FEED_SIGNER.address): EventKeys => ({ kind: "record", creator: "0x" + "aa".repeat(20), feedSigner, orderKeyRef: null });
const ring = (gen = 2): EventKeys => ({ kind: "ring", creator: "0x" + "aa".repeat(20), feedSigner: FEED_SIGNER.address, orderKeyRef: "0a".repeat(32), gen });
const never = () => false;

/** Issue as the route does: check, start the log, issue. */
function issue(eventId: string, pass = organiserPass(eventId), exp = soon(), mode: "single" | "several" = "several") {
  const reg = doorKey.checkDoorKeyRegistration(eventId, pass, record(), (j) => store.doorPassIdUsed(eventId, j));
  assert.ok(reg.ok, JSON.stringify(reg));
  entries.startDoorEntries(eventId, reg.jti, reg.doorKey);
  const token = store.issueDoorPass(eventId, exp, undefined, mode, reg.gen, { jti: reg.jti, doorKeyRef: reg.doorKeyRef });
  return { ...pass, token };
}

const file = (eventId: string) =>
  join(process.cwd(), ".data", "checkin-door-entries", `${createHash("sha256").update(eventId).digest("hex")}.json`);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registration: the event's feed signer, on a record or a ring, is accepted with its generation", () => {
  const ev = newEvent();
  const p = organiserPass(ev);
  const r1 = doorKey.checkDoorKeyRegistration(ev, p, record(), never);
  assert.ok(r1.ok && r1.gen === 0 && r1.doorKeyRef === p.doorKeyRef);
  const r2 = doorKey.checkDoorKeyRegistration(ev, p, ring(3), never);
  assert.ok(r2.ok && r2.gen === 3);
});

test("registration: a session alone cannot register - any other signer is refused", () => {
  const ev = newEvent();
  const other = organiserPass(ev, newJti(), "22".repeat(32));
  const r = doorKey.checkDoorKeyRegistration(ev, other, record(), never);
  assert.ok(!r.ok && r.status === 409);
  const p = organiserPass(ev);
  const r2 = doorKey.checkDoorKeyRegistration(ev, { ...p, sig: undefined }, record(), never);
  assert.ok(!r2.ok && r2.status === 400);
});

test("registration: the statement binds event, pass id and key", () => {
  const ev = newEvent();
  const p = organiserPass(ev);
  const swappedKey = organiserPass(ev).doorKey;
  assert.ok(!doorKey.checkDoorKeyRegistration(ev, { ...p, doorKey: swappedKey }, record(), never).ok, "another key");
  assert.ok(!doorKey.checkDoorKeyRegistration(ev, { ...p, jti: newJti() }, record(), never).ok, "another pass id");
  assert.ok(!doorKey.checkDoorKeyRegistration(newEvent(), p, record(), never).ok, "another event");
});

test("registration: malformed ids and keys are refused", () => {
  const ev = newEvent();
  const p = organiserPass(ev);
  for (const bad of [
    { ...p, jti: p.jti.toUpperCase() },
    { ...p, jti: "abc" },
    { ...p, doorKey: p.doorKey.slice(2) },
    { ...p, doorKey: "ff".repeat(1216) },
    { mode: "several" },
  ]) {
    const r = doorKey.checkDoorKeyRegistration(ev, bad as never, record(), never);
    assert.ok(!r.ok && r.status === 400, JSON.stringify(bad).slice(0, 60));
  }
});

test("registration: a legacy event is refused, and unreadable keys are a 503", () => {
  const ev = newEvent();
  const p = organiserPass(ev);
  const legacy = doorKey.checkDoorKeyRegistration(ev, p, { kind: "legacy" }, never);
  assert.ok(!legacy.ok && legacy.status === 409);
  const down = doorKey.checkDoorKeyRegistration(ev, p, { kind: "unavailable", creator: "0x", feedSigner: FEED_SIGNER.address, reason: "rpc" }, never);
  assert.ok(!down.ok && down.status === 503);
});

test("registration: an old statement cannot bring back an old pass", () => {
  const ev = newEvent();
  const first = organiserPass(ev);
  issue(ev, first);
  issue(ev);
  const used = (j: string) => store.doorPassIdUsed(ev, j);
  const replay = doorKey.checkDoorKeyRegistration(ev, first, record(), used);
  assert.ok(!replay.ok && replay.status === 409, "the first pass's id, signed and all");
});

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

async function open(ev: string, pass: { jti: string; secretKey: Uint8Array }, line: { box?: unknown; seriesId: string; edition: number }) {
  return openBoxJson<DoorEntryPlaintext>(pass.secretKey, line.box, doorEntrySealContext(ev, pass.jti, line.seriesId, line.edition));
}

test("a sale is sealed per ticket, and only the door key opens it", async () => {
  const ev = newEvent();
  const pass = issue(ev);
  const t = [{ seriesId: SERIES, edition: 1 }, { seriesId: SERIES, edition: 2 }];
  assert.equal(await entries.sealDoorEntries(ev, t, { email: "a@example.com", buyerName: "A Buyer" }), 2);
  const page = entries.readDoorEntriesPage(ev, pass.jti, 0);
  assert.equal(page.log.length, 2);
  assert.equal(page.doorKeyRef, pass.doorKeyRef);
  assert.deepEqual(await open(ev, pass, page.log[1]!), { v: 1, seriesId: SERIES, edition: 2, email: "a@example.com", buyerName: "A Buyer" });
  assert.doesNotMatch(readFileSync(file(ev), "utf8"), /a@example\.com|A Buyer/, "nothing readable at rest");
});

test("sealing is idempotent per ticket", async () => {
  const ev = newEvent();
  const pass = issue(ev);
  const t = [{ seriesId: SERIES, edition: 1 }];
  await entries.sealDoorEntries(ev, t, { email: "a@example.com" });
  assert.equal(await entries.sealDoorEntries(ev, [...t, ...t], { email: "a@example.com" }), 0);
  assert.equal(entries.readDoorEntriesPage(ev, pass.jti, 0).log.length, 1);
});

test("nothing is sealed with no pass, no key, an expired pass, or nothing to say", async () => {
  const t = [{ seriesId: SERIES, edition: 1 }];
  const none = newEvent();
  assert.equal(await entries.sealDoorEntries(none, t, { email: "a@example.com" }), 0);

  const keyless = newEvent();
  store.issueDoorPass(keyless, soon());
  assert.equal(await entries.sealDoorEntries(keyless, t, { email: "a@example.com" }), 0);

  const expired = newEvent();
  issue(expired, organiserPass(expired), Math.floor(Date.now() / 1000) - 1);
  assert.equal(await entries.sealDoorEntries(expired, t, { email: "a@example.com" }), 0, "an expired pass gets nothing");

  const silent = newEvent();
  issue(silent);
  assert.equal(await entries.sealDoorEntries(silent, t, {}), 0);
});

test("two sales at once both land", async () => {
  const ev = newEvent();
  const pass = issue(ev);
  await Promise.all([
    entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" }),
    entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }], { email: "b@example.com" }),
  ]);
  const page = entries.readDoorEntriesPage(ev, pass.jti, 0);
  assert.deepEqual(page.log.map((l) => l.edition).sort(), [1, 2]);
  assert.deepEqual(page.log.map((l) => l.seq).sort(), [1, 2]);
});

test("regenerating the pass drops the last pass's entries", async () => {
  const ev = newEvent();
  const first = issue(ev);
  await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" });
  const second = issue(ev);
  assert.equal(entries.readDoorEntriesPage(ev, second.jti, 0).log.length, 0);
  assert.deepEqual(entries.readDoorEntriesPage(ev, first.jti, 3).reset, true, "the old pass is told to start again");
  assert.equal(await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }], { email: "b@example.com" }), 1);
});

// ---------------------------------------------------------------------------
// The log and its cursor
// ---------------------------------------------------------------------------

test("the cursor: empty, incremental, and a page at a time", async () => {
  const ev = newEvent();
  const pass = issue(ev);
  const empty = entries.readDoorEntriesPage(ev, pass.jti, 0);
  assert.deepEqual({ next: empty.next, reset: empty.reset, more: empty.more, n: empty.log.length }, { next: 0, reset: false, more: false, n: 0 });
  await entries.sealDoorEntries(ev, [1, 2, 3].map((edition) => ({ seriesId: SERIES, edition })), { email: "a@example.com" });
  const page1 = entries.readDoorEntriesPage(ev, pass.jti, 0, 2);
  assert.deepEqual([page1.next, page1.more, page1.log.length], [2, true, 2]);
  const page2 = entries.readDoorEntriesPage(ev, pass.jti, page1.next, 2);
  assert.deepEqual([page2.next, page2.more, page2.log.map((l) => l.edition)], [3, false, [3]]);
  const idle = entries.readDoorEntriesPage(ev, pass.jti, page2.next);
  assert.deepEqual([idle.next, idle.log.length, idle.reset], [3, 0, false]);
  assert.equal(entries.readDoorEntriesPage(ev, pass.jti, 99).reset, true, "a cursor past the end starts again");
});

test("an erased order: its sealed lines are deleted and a removal reaches the cursor - even of the last line", async () => {
  const ev = newEvent();
  const pass = issue(ev);
  await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }, { seriesId: SERIES, edition: 2 }], { email: "a@example.com" });
  const seen = entries.readDoorEntriesPage(ev, pass.jti, 0).next; // 2
  assert.equal(entries.removeDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }]), 1);
  const after = entries.readDoorEntriesPage(ev, pass.jti, seen);
  assert.deepEqual(after.log.map((l) => [l.kind, l.edition, l.seq]), [["remove", 2, 3]]);
  const all = entries.readDoorEntriesPage(ev, pass.jti, 0).log;
  assert.equal(all.filter((l) => l.kind === "add" && l.edition === 2).length, 0, "the sealed copy is gone, not hidden");
  assert.equal(await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }], { email: "a@example.com" }), 0, "never added back");
  assert.equal(entries.removeDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }]), 0, "idempotent");
});

test("unreadable is never overwritten by a sale or a removal; only a new pass replaces it", async () => {
  const ev = newEvent();
  const pass = issue(ev);
  writeFileSync(file(ev), "{not json");
  entries._dropDoorEntriesCacheForTests(); // as a restart would: the next read goes to disk
  assert.equal(await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" }), 0);
  assert.equal(entries.removeDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }]), 0);
  assert.equal(readFileSync(file(ev), "utf8"), "{not json");
  assert.throws(() => entries.readDoorEntriesPage(ev, pass.jti, 0), entries.DoorEntriesUnreadableError);
  assert.equal(entries.doorEntriesHealth().ok, false);
  const fresh = issue(ev);
  assert.equal(entries.readDoorEntriesPage(ev, fresh.jti, 0).log.length, 0);
  assert.equal(entries.doorEntriesHealth().ok, true);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

function get(eventId: string, token: string | null, device: string | null, since = "0") {
  return app.request(`/api/checkin/${eventId}/entries?since=${since}`, {
    headers: { ...(token ? { "X-Door-Pass": token } : {}), ...(device ? { "X-Scanner-Device": device } : {}) },
  });
}

test("route: the log after the cursor, for the pass that asks", async () => {
  const { noRings } = await import("./helpers/key-ring.js");
  noRings();
  const ev = newEvent();
  const pass = issue(ev);
  await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" });
  const res = await get(ev, pass.token, DEV);
  assert.equal(res.status, 200);
  const page = (await res.json()).data as DoorEntriesPage;
  assert.equal(page.log.length, 1);
  assert.equal(page.jti, pass.jti);
  const later = (await (await get(ev, pass.token, DEV, String(page.next))).json()).data as DoorEntriesPage;
  assert.equal(later.log.length, 0);
});

test("route: no pass, no device, another phone on a single pass, a bad cursor - all refused", async () => {
  const { noRings } = await import("./helpers/key-ring.js");
  noRings();
  const ev = newEvent();
  const pass = issue(ev, organiserPass(ev), soon(), "single");
  store.bindSinglePassDevice(ev, DEV);
  assert.equal((await get(ev, null, DEV)).status, 401);
  const noDevice = await get(ev, pass.token, null);
  assert.equal(noDevice.status, 400);
  assert.equal((await noDevice.json()).reason, "outdated-client");
  assert.equal((await get(ev, pass.token, "devicebbbbbbbbbb")).status, 409);
  assert.equal((await get(ev, pass.token, DEV, "-1")).status, 400);
  assert.equal((await get(ev, pass.token, DEV, "abc")).status, 400);
});

test("route: refused like the roster when the account's keys moved, or cannot be read", async () => {
  const { installRing, noRings } = await import("./helpers/key-ring.js");
  const feedRecord = await import("../src/lib/event/feed-signer-record.js");
  const ev = newEvent();
  const creator = "0x" + "c1".repeat(20);
  feedRecord.recordEventFeedSigner(ev, FEED_SIGNER.address, creator, "0a".repeat(32));
  noRings();
  const pass = issue(ev);
  assert.equal((await get(ev, pass.token, DEV)).status, 200);
  noRings({ down: true });
  assert.equal((await get(ev, pass.token, DEV)).status, 503);
  await installRing(creator, 1);
  const moved = await get(ev, pass.token, DEV);
  assert.equal(moved.status, 401);
  assert.equal((await moved.json()).reason, "revoked");
  noRings();
});

test("route: an unreadable log is a 503 that says scanning still works", async () => {
  const { noRings } = await import("./helpers/key-ring.js");
  noRings();
  const ev = newEvent();
  const pass = issue(ev);
  mkdirSync(join(process.cwd(), ".data", "checkin-door-entries"), { recursive: true });
  writeFileSync(file(ev), "[]");
  entries._dropDoorEntriesCacheForTests();
  const res = await get(ev, pass.token, DEV);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /scanning still works/);
});

// ---------------------------------------------------------------------------
// The issue route: a source-order guard (it sits behind requireAuth and the event
// resolution stack, which this suite has no harness for)
// ---------------------------------------------------------------------------

test("the issue route checks the registration, starts the log, then issues - in that order", () => {
  const src = readFileSync(new URL("../src/routes/checkin.ts", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('checkinOrganiser.post("/:id/door-pass"'), src.indexOf('checkinOrganiser.post("/:id/checkin-roster"'));
  const check = route.indexOf("checkDoorKeyRegistration(");
  const start = route.indexOf("startDoorEntries(");
  const iss = route.indexOf("issueDoorPass(");
  assert.ok(check > 0 && check < start && start < iss, "check, then log, then pass");
  assert.match(route, /if \(!reg\.ok\) return c\.json\(\{ ok: false, error: reg\.error \}, reg\.status\);/);
  assert.match(route, /issueDoorPass\(eventId, exp, event\.creatorFeedSigner, mode, reg\.gen, \{ jti: reg\.jti, doorKeyRef: reg\.doorKeyRef \}\)/);
});
