/**
 * The live door attendee list: a door pass registers an X-Wing key, which takes PROOF
 * that the account's current order key is held (a challenge sealed to it, answered with
 * an HMAC under its nonce) - a login session alone issues no pass. Each sale's email and
 * card name are then sealed to that key at fulfilment, and scanners read the log after a
 * cursor.
 *
 * MUTATION: skip the proof compare and "a proof without the order key" goes red; bind
 * the proof to the client's parent instead of the server's and "flipping parent" goes
 * red; leave a challenge after use and "a consumed challenge" goes red; drop the expiry
 * and "an expired challenge" goes red; drop the order-key re-check and "a ring bump"
 * goes red; keep the old challenge on a new one and "a second challenge voids the
 * first" goes red; drop the used-id check and "an old proof cannot bring back an old
 * pass" goes red; drop the exp check and "an expired pass gets nothing" goes red; let a
 * seal skip the re-read and "two sales at once" goes red; drop the second duplicate
 * check and "sealed twice at once" goes red; give a removal `seq` from the log instead
 * of `last` and "a cursor sees a removal of the last line" goes red; let a sale overwrite
 * an unreadable file and "unreadable is never overwritten" goes red; drop the issue
 * route's proof check, or move it after the log starts, and the route-order guard goes red.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { orderKeyRef } from "@woco/shared";
import { doorPassSecret } from "@woco/shared/keyring/account-secret";
import { doorKeyProof, doorKeyRefOf } from "@woco/shared/checkin/door-keys";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { doorEntrySealContext, doorKeyProofSealContext, openBox, openBoxJson } from "@woco/shared/crypto/sealed-box";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import type { DoorEntriesPage, DoorEntryPlaintext, DoorPassChallenge } from "@woco/shared";
import type { EventKeys } from "../src/lib/keyring/event-keys.js";

let store: typeof import("../src/lib/checkin/store.js");
let entries: typeof import("../src/lib/checkin/door-entries.js");
let doorKey: typeof import("../src/lib/checkin/door-key.js");
let app: Hono;

const SECRET = "11".repeat(32);
const ORDER = deriveXWingKeypairFromSeed(SECRET);
const ORDER_REF = orderKeyRef(ORDER.publicKey);
const OTHER_ORDER = deriveXWingKeypairFromSeed("22".repeat(32));
const OTHER_REF = orderKeyRef(OTHER_ORDER.publicKey);
const PARENT = "0x" + "aa".repeat(20);
const FEED = "0x" + "f0".repeat(20);
const SERIES = "5d6e7f80-0000-4000-8000-000000000002";
const DEV = "deviceaaaaaaaaaa";

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-door-entries-")));
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-door-entries";
  store = await import("../src/lib/checkin/store.js");
  entries = await import("../src/lib/checkin/door-entries.js");
  doorKey = await import("../src/lib/checkin/door-key.js");
  const keys = new Map([[ORDER_REF, ORDER.publicKey], [OTHER_REF, OTHER_ORDER.publicKey]]);
  doorKey._setDoorKeyDepsForTests({
    fetchOrderKey: async (ref) => keys.get(ref) ?? Promise.reject(new Error("no such key")),
  });
  const { checkin } = await import("../src/routes/checkin.js");
  app = new Hono();
  app.route("/api/checkin", checkin);
});

let n = 0;
const newEvent = () => `3f2a9c1e-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const newJti = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
const soon = () => Math.floor(Date.now() / 1000) + 3600;
const never = () => false;

const record = (ref: string | null = ORDER_REF): EventKeys => ({ kind: "record", creator: PARENT, feedSigner: FEED, orderKeyRef: ref });
const ring = (gen = 2, ref = ORDER_REF): EventKeys => ({ kind: "ring", creator: PARENT, feedSigner: FEED, orderKeyRef: ref, gen });

/** What the organiser's dashboard makes for a new pass: P's door key. */
function organiserPass(eventId: string, jti = newJti()) {
  const kp = doorEntriesKeypair(doorPassSecret(hexToBytes(SECRET), eventId, jti));
  return { jti, doorKey: bytesToHex(kp.publicKey), secretKey: kp.secretKey, doorKeyRef: doorKeyRefOf(kp.publicKey) };
}

/** The dashboard's answer: open the box with the order key, HMAC the transcript. */
async function prove(
  eventId: string,
  ch: DoorPassChallenge,
  pass: { jti: string; doorKeyRef: string },
  o: { mode?: "single" | "several"; parent?: string; secretKey?: Uint8Array } = {},
) {
  const parent = o.parent ?? PARENT;
  const nonce = await openBox(o.secretKey ?? ORDER.secretKey, ch.box, doorKeyProofSealContext(eventId, parent, ch.challengeId));
  return doorKeyProof(nonce, { eventId, parent, challengeId: ch.challengeId, jti: pass.jti, mode: o.mode ?? "several", doorKeyRef: pass.doorKeyRef });
}

async function challenge(eventId: string, keys: EventKeys = record(), parent = PARENT): Promise<DoorPassChallenge> {
  const out = await doorKey.createDoorPassChallenge(eventId, parent, keys);
  assert.ok(out.ok, JSON.stringify(out));
  return out.data;
}

/** A redeem body for a challenge, with the right proof unless told otherwise. */
async function body(eventId: string, pass = organiserPass(eventId), mode: "single" | "several" = "several") {
  const ch = await challenge(eventId);
  return { ch, pass, body: { mode, jti: pass.jti, doorKey: pass.doorKey, challengeId: ch.challengeId, proof: await prove(eventId, ch, pass, { mode }) } };
}

/** Issue as the route does: redeem the proof, start the log, issue. */
async function issue(eventId: string, pass = organiserPass(eventId), exp = soon(), mode: "single" | "several" = "several") {
  const b = await body(eventId, pass, mode);
  const reg = doorKey.redeemDoorPassChallenge(eventId, PARENT, b.body, record(), (j) => store.doorPassIdUsed(eventId, j));
  assert.ok(reg.ok, JSON.stringify(reg));
  entries.startDoorEntries(eventId, reg.jti, reg.doorKey);
  const token = store.issueDoorPass(eventId, exp, undefined, reg.mode, reg.gen, { jti: reg.jti, doorKeyRef: reg.doorKeyRef });
  return { ...pass, token };
}

const file = (eventId: string) =>
  join(process.cwd(), ".data", "checkin-door-entries", `${createHash("sha256").update(eventId).digest("hex")}.json`);

// ---------------------------------------------------------------------------
// Challenge and proof
// ---------------------------------------------------------------------------

test("a challenge opens only with the event's current order key", async () => {
  const ev = newEvent();
  const ch = await challenge(ev);
  const ctx = doorKeyProofSealContext(ev, PARENT, ch.challengeId);
  assert.equal((await openBox(ORDER.secretKey, ch.box, ctx)).length, 32);
  await assert.rejects(openBox(OTHER_ORDER.secretKey, ch.box, ctx), undefined, "another account's order key");
  const onRing = await challenge(ev, ring(3, OTHER_REF));
  await openBox(OTHER_ORDER.secretKey, onRing.box, doorKeyProofSealContext(ev, PARENT, onRing.challengeId));
  assert.ok(ch.exp > Date.now() / 1000 && ch.exp <= Date.now() / 1000 + 121);
});

test("no challenge for a legacy event or one with no order key (409), nor while keys cannot be read (503)", async () => {
  const ev = newEvent();
  for (const [keys, status] of [
    [{ kind: "legacy" }, 409],
    [record(null), 409],
    [{ kind: "unavailable", creator: PARENT, feedSigner: FEED, reason: "rpc" }, 503],
    [record("ee".repeat(32)), 503],
  ] as Array<[EventKeys, number]>) {
    const out = await doorKey.createDoorPassChallenge(ev, PARENT, keys);
    assert.ok(!out.ok && out.status === status, JSON.stringify(keys));
  }
});

test("a correct proof issues the pass with its key, mode and generation", async () => {
  const ev = newEvent();
  const b = await body(ev, organiserPass(ev), "single");
  const reg = doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, ring(4), never);
  assert.ok(reg.ok && reg.mode === "single" && reg.gen === 4 && reg.doorKeyRef === b.pass.doorKeyRef && reg.jti === b.pass.jti);
});

test("a proof without the order key is refused", async () => {
  const ev = newEvent();
  const b = await body(ev);
  // Whoever lacks the order key cannot open the box: the best they can do is guess.
  const guessed = doorKeyProof(new Uint8Array(32).fill(1), {
    eventId: ev, parent: PARENT, challengeId: b.ch.challengeId, jti: b.pass.jti, mode: "several", doorKeyRef: b.pass.doorKeyRef,
  });
  const out = doorKey.redeemDoorPassChallenge(ev, PARENT, { ...b.body, proof: guessed }, record(), never);
  assert.ok(!out.ok && out.status === 409 && out.reason === undefined);
  await assert.rejects(prove(ev, b.ch, b.pass, { secretKey: OTHER_ORDER.secretKey }), undefined, "another X-Wing key cannot even open it");
});

test("flipping any field the proof covers is refused", async () => {
  const flips: Array<[string, (b: Awaited<ReturnType<typeof body>>, ev: string) => { ev: string; parent: string; body: Record<string, unknown> }]> = [
    ["jti", (b, ev) => ({ ev, parent: PARENT, body: { ...b.body, jti: newJti() } })],
    ["doorKey", (b, ev) => ({ ev, parent: PARENT, body: { ...b.body, doorKey: organiserPass(ev).doorKey } })],
    ["mode", (b, ev) => ({ ev, parent: PARENT, body: { ...b.body, mode: "single" } })],
    ["event", (b) => ({ ev: newEvent(), parent: PARENT, body: b.body })],
    ["parent", (b, ev) => ({ ev, parent: "0x" + "bb".repeat(20), body: b.body })],
    ["challengeId", (b, ev) => ({ ev, parent: PARENT, body: { ...b.body, challengeId: "0f".repeat(16) } })],
  ];
  // Which guard refuses: the challenge lookup for who and where it was made, the HMAC for what it covers.
  const lookup = new Set(["event", "parent", "challengeId"]);
  for (const [name, flip] of flips) {
    const ev = newEvent();
    const b = await body(ev);
    const f = flip(b, ev);
    const out = doorKey.redeemDoorPassChallenge(f.ev, f.parent, f.body, record(), never);
    assert.ok(!out.ok && out.status === 409, name);
    assert.equal(out.reason, lookup.has(name) ? "challenge-expired" : undefined, name);
  }
});

test("another account cannot use up your challenge", async () => {
  const ev = newEvent();
  const b = await body(ev);
  const other = doorKey.redeemDoorPassChallenge(ev, "0x" + "bb".repeat(20), b.body, record(), never);
  assert.ok(!other.ok && other.reason === "challenge-expired");
  assert.ok(doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, record(), never).ok, "still yours to use");
});

test("a second challenge for the same account and event voids the first", async () => {
  const ev = newEvent();
  const first = await body(ev);
  await challenge(ev);
  const out = doorKey.redeemDoorPassChallenge(ev, PARENT, first.body, record(), never);
  assert.ok(!out.ok && out.reason === "challenge-expired");
});

test("a challenge is used once, whatever follows", async () => {
  const ev = newEvent();
  const b = await body(ev);
  const wrong = doorKey.redeemDoorPassChallenge(ev, PARENT, { ...b.body, proof: "00".repeat(32) }, record(), never);
  assert.ok(!wrong.ok && wrong.status === 409);
  const retry = doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, record(), never);
  assert.ok(!retry.ok && retry.reason === "challenge-expired", "consumed by the failed try");
  const b2 = await body(ev);
  assert.ok(doorKey.redeemDoorPassChallenge(ev, PARENT, b2.body, record(), never).ok);
  const replay = doorKey.redeemDoorPassChallenge(ev, PARENT, b2.body, record(), never);
  assert.ok(!replay.ok && replay.reason === "challenge-expired", "a replayed consumed challenge");
});

test("an expired challenge, or a forgotten one (restart), is challenge-expired", async () => {
  const ev = newEvent();
  const b = await body(ev);
  const late = doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, record(), never, Date.now() + doorKey.DOOR_KEY_CHALLENGE_TTL_MS + 1);
  assert.ok(!late.ok && late.reason === "challenge-expired");
  const b2 = await body(ev);
  doorKey._setDoorKeyDepsForTests({ clear: true });
  const forgot = doorKey.redeemDoorPassChallenge(ev, PARENT, b2.body, record(), never);
  assert.ok(!forgot.ok && forgot.reason === "challenge-expired");
});

test("the account's keys moving between challenge and pass is refused", async () => {
  const ev = newEvent();
  const b = await body(ev);
  const out = doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, ring(5, OTHER_REF), never);
  assert.ok(!out.ok && out.status === 409 && out.reason === "keys-changed");
});

test("no proof, a malformed one, or keys that cannot be read: no pass", async () => {
  const ev = newEvent();
  const b = await body(ev);
  for (const bad of [{ proof: undefined }, { proof: "zz".repeat(32) }, { challengeId: undefined }, { mode: undefined }, { mode: "both" }, { doorKey: "ff".repeat(1216) }]) {
    const out = doorKey.redeemDoorPassChallenge(ev, PARENT, { ...b.body, ...bad }, record(), never);
    assert.ok(!out.ok && out.status === 400, JSON.stringify(bad));
  }
  const down = doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, { kind: "unavailable", creator: PARENT, feedSigner: FEED, reason: "rpc" }, never);
  assert.ok(!down.ok && down.status === 503);
  assert.ok(!doorKey.redeemDoorPassChallenge(ev, PARENT, b.body, { kind: "legacy" }, never).ok);
});

test("an old proof cannot bring back an old pass", async () => {
  const ev = newEvent();
  const first = organiserPass(ev);
  await issue(ev, first);
  await issue(ev);
  const again = await body(ev, first);
  const out = doorKey.redeemDoorPassChallenge(ev, PARENT, again.body, record(), (j) => store.doorPassIdUsed(ev, j));
  assert.ok(!out.ok && out.status === 409, "the first pass's id, with a fresh valid proof");
});

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

async function open(ev: string, pass: { jti: string; secretKey: Uint8Array }, line: { box?: unknown; seriesId: string; edition: number }) {
  return openBoxJson<DoorEntryPlaintext>(pass.secretKey, line.box, doorEntrySealContext(ev, pass.jti, line.seriesId, line.edition));
}

test("a sale is sealed per ticket, and only the door key opens it", async () => {
  const ev = newEvent();
  const pass = await issue(ev);
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
  const pass = await issue(ev);
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
  await issue(expired, organiserPass(expired), Math.floor(Date.now() / 1000) - 1);
  assert.equal(await entries.sealDoorEntries(expired, t, { email: "a@example.com" }), 0, "an expired pass gets nothing");

  const silent = newEvent();
  await issue(silent);
  assert.equal(await entries.sealDoorEntries(silent, t, {}), 0);
});

test("two sales at once both land", async () => {
  const ev = newEvent();
  const pass = await issue(ev);
  await Promise.all([
    entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" }),
    entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }], { email: "b@example.com" }),
  ]);
  const page = entries.readDoorEntriesPage(ev, pass.jti, 0);
  assert.deepEqual(page.log.map((l) => l.edition).sort(), [1, 2]);
  assert.deepEqual(page.log.map((l) => l.seq).sort(), [1, 2]);
});

test("the same ticket sealed twice at once (a replayed webhook) lands once", async () => {
  const ev = newEvent();
  const pass = await issue(ev);
  const t = [{ seriesId: SERIES, edition: 1 }];
  await Promise.all([entries.sealDoorEntries(ev, t, { email: "a@example.com" }), entries.sealDoorEntries(ev, t, { email: "a@example.com" })]);
  assert.equal(entries.readDoorEntriesPage(ev, pass.jti, 0).log.length, 1);
});

test("regenerating the pass drops the last pass's entries", async () => {
  const ev = newEvent();
  const first = await issue(ev);
  await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" });
  const second = await issue(ev);
  assert.equal(entries.readDoorEntriesPage(ev, second.jti, 0).log.length, 0);
  assert.deepEqual(entries.readDoorEntriesPage(ev, first.jti, 3).reset, true, "the old pass is told to start again");
  assert.equal(await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 2 }], { email: "b@example.com" }), 1);
});

// ---------------------------------------------------------------------------
// The log and its cursor
// ---------------------------------------------------------------------------

test("the cursor: empty, incremental, and a page at a time", async () => {
  const ev = newEvent();
  const pass = await issue(ev);
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
  const pass = await issue(ev);
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
  const pass = await issue(ev);
  writeFileSync(file(ev), "{not json");
  entries._dropDoorEntriesCacheForTests(); // as a restart would: the next read goes to disk
  assert.equal(await entries.sealDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }], { email: "a@example.com" }), 0);
  assert.equal(entries.removeDoorEntries(ev, [{ seriesId: SERIES, edition: 1 }]), 0);
  assert.equal(readFileSync(file(ev), "utf8"), "{not json");
  assert.throws(() => entries.readDoorEntriesPage(ev, pass.jti, 0), entries.DoorEntriesUnreadableError);
  assert.equal(entries.doorEntriesHealth().ok, false);
  const fresh = await issue(ev);
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
  const pass = await issue(ev);
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
  const pass = await issue(ev, organiserPass(ev), soon(), "single");
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
  feedRecord.recordEventFeedSigner(ev, FEED, creator, "0a".repeat(32));
  noRings();
  const pass = await issue(ev);
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
  const pass = await issue(ev);
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

test("the issue route checks the proof, starts the log, then issues - in that order", () => {
  const src = readFileSync(new URL("../src/routes/checkin.ts", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('checkinOrganiser.post("/:id/door-pass", '), src.indexOf('checkinOrganiser.post("/:id/checkin-roster"'));
  const check = route.indexOf("redeemDoorPassChallenge(");
  const refuse = route.indexOf("if (!reg.ok) return c.json(");
  const start = route.indexOf("startDoorEntries(");
  const iss = route.indexOf("issueDoorPass(");
  assert.ok(check > 0 && check < refuse && refuse < start && start < iss, "proof, refusal, then log, then pass");
  assert.equal(route.match(/startDoorEntries\(|issueDoorPass\(/g)?.length, 2, "no other path to a pass");
  assert.match(route, /issueDoorPass\(eventId, exp, event\.creatorFeedSigner, mode, reg\.gen, \{ jti: reg\.jti, doorKeyRef: reg\.doorKeyRef \}\)/);
  assert.match(route, /const mode: DoorMode = reg\.mode;/, "the mode issued is the one the proof covers");
  assert.match(route, /c\.get\("parentAddress"\)/, "the account is the session's, never the body's");
});

test("the challenge route is per-account rate limited before any work: 10 a minute, 60 an hour", () => {
  const src = readFileSync(new URL("../src/routes/checkin.ts", import.meta.url), "utf8");
  assert.match(src, /const doorPassChallenges = new SlidingWindowLimiter\(\[\s*\{ limit: 10, windowMs: 60_000 \},\s*\{ limit: 60, windowMs: 3_600_000 \},\s*\]\);/);
  const route = src.slice(src.indexOf('checkinOrganiser.post("/:id/door-pass/challenge"'), src.indexOf('checkinOrganiser.post("/:id/door-pass", '));
  assert.ok(route.indexOf("doorPassChallenges.allow(parent)") > 0);
  assert.ok(route.indexOf("doorPassChallenges.allow(parent)") < route.indexOf("createDoorPassChallenge("));
  assert.match(route, /const parent = c\.get\("parentAddress"\)\.toLowerCase\(\);/);
});
