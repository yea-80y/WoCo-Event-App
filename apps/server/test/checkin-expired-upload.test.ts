/**
 * An expired door pass can still UPLOAD its phone's check-ins for 30 days, and
 * nothing comes back (owner, 2026-10-15). /sync takes a pass whose only fault is
 * expiry, inside the window, as the event's ACTIVE pass with its key generation not
 * behind; the device check and the series filter apply as for a live pass; the
 * answer is an acknowledgement only - no check-in set, no conflicts. /pack, /claim
 * and /entries refuse it as before.
 *
 * MUTATION: let /sync answer an expired pass with the full set and "only an ack"
 * goes red; drop the window and "past 30 days" goes red; take uploadAfterExpiry on
 * every route and "/pack, /claim and /entries" goes red; skip the active-jti check
 * for expired passes and "a regenerated pass" goes red; let unreadable keys through
 * and "older account keys" goes red; merge the body unfiltered and "the series
 * filter" goes red.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { CheckinRecord } from "@woco/shared";

let store: typeof import("../src/lib/checkin/store.js");
let series: typeof import("../src/lib/checkin/event-series.js");
let app: Hono;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-expired-upload-")));
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-expired-upload";
  store = await import("../src/lib/checkin/store.js");
  series = await import("../src/lib/checkin/event-series.js");
  const { checkin } = await import("../src/routes/checkin.js");
  app = new Hono();
  app.route("/api/checkin", checkin);
});

const DEV_A = "deviceaaaaaaaaaa";
const DEV_B = "devicebbbbbbbbbb";
const DAY = 24 * 3600;
const nowS = () => Math.floor(Date.now() / 1000);
let n = 0;
const newEvent = () => `evt-upload-${++n}`;
const rec = (edition: number, over: Partial<CheckinRecord> = {}): CheckinRecord => ({
  seriesId: "ser-1",
  edition,
  at: "2026-10-14T20:00:00.000Z",
  deviceId: DEV_A,
  method: "scan",
  ...over,
});

function sync(eventId: string, token: string, checkins: CheckinRecord[], device = DEV_A) {
  return app.request(`/api/checkin/${eventId}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Door-Pass": token, "X-Scanner-Device": device },
    body: JSON.stringify({ deviceId: device, checkins }),
  });
}

test("an active pass expired inside 30 days uploads, and gets only an acknowledgement back", async () => {
  const ev = newEvent();
  store.claimCheckin(ev, { ...rec(1), deviceId: DEV_B, claimId: "other-phone" }); // another phone's, already on the server
  const token = store.issueDoorPass(ev, nowS() - 3 * DAY);
  const res = await sync(ev, token, [rec(2), rec(3)]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, data: { acknowledged: 2 } }, "no check-in set, no conflicts");
  assert.deepEqual(store.readCheckins(ev).map((r) => r.edition).sort(), [1, 2, 3], "the records are merged");
});

test("past 30 days it is refused as expired", async () => {
  const ev = newEvent();
  const token = store.issueDoorPass(ev, nowS() - 31 * DAY);
  const res = await sync(ev, token, [rec(1)]);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "expired");
  assert.deepEqual(store.readCheckins(ev), []);
  const edge = newEvent();
  assert.equal((await sync(edge, store.issueDoorPass(edge, nowS() - 30 * DAY + 60), [rec(1)])).status, 200, "just inside the window");
});

test("a regenerated pass's old token is refused, expired or not", async () => {
  const ev = newEvent();
  const old = store.issueDoorPass(ev, nowS() - DAY);
  store.issueDoorPass(ev, nowS() - DAY); // the organiser made a new pass
  const res = await sync(ev, old, [rec(1)]);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "revoked");
  assert.deepEqual(store.readCheckins(ev), []);
});

test("expiry must be the only fault: a tampered expired token is refused", async () => {
  const ev = newEvent();
  const token = store.issueDoorPass(ev, nowS() - DAY);
  const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  const res = await sync(ev, tampered, [rec(1)]);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "bad-sig");
  assert.deepEqual(store.readCheckins(ev), []);
});

test("/pack, /claim and /entries still refuse an expired pass", async () => {
  const ev = newEvent();
  const token = store.issueDoorPass(ev, nowS() - DAY);
  const headers = { "X-Door-Pass": token, "X-Scanner-Device": DEV_A };
  const pack = await app.request(`/api/checkin/${ev}/pack`, { headers });
  const entries = await app.request(`/api/checkin/${ev}/entries?since=0`, { headers });
  const claim = await app.request(`/api/checkin/${ev}/claim`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ...rec(1), claimId: "c-1" }),
  });
  for (const [name, res] of [["pack", pack], ["entries", entries], ["claim", claim]] as const) {
    assert.equal(res.status, 401, name);
    assert.equal((await res.json()).reason, "expired", name);
  }
  assert.deepEqual(store.readCheckins(ev), [], "the claim admitted nothing");
});

test("the device check and the series filter apply as for a live pass", async () => {
  const ev = newEvent();
  const token = store.issueDoorPass(ev, nowS() - DAY, undefined, "single");
  assert.equal(store.bindSinglePassDevice(ev, DEV_A), true);
  const other = await sync(ev, token, [rec(1, { deviceId: DEV_B })], DEV_B);
  assert.equal(other.status, 409, "a single pass uploads from its own phone only");

  series.rememberEventSeries(ev, ["ser-1"]);
  const res = await sync(ev, token, [rec(1), rec(2, { seriesId: "ser-other-event" })]);
  assert.deepEqual((await res.json()).data, { acknowledged: 1 });
  assert.deepEqual(store.readCheckins(ev).map((r) => r.seriesId), ["ser-1"]);
});

test("an expired pass from older account keys, or while the keys cannot be read, is refused", async () => {
  const { installRing, noRings } = await import("./helpers/key-ring.js");
  const feedRecord = await import("../src/lib/event/feed-signer-record.js");
  const ev = newEvent();
  const creator = "0x" + "c2".repeat(20);
  feedRecord.recordEventFeedSigner(ev, "0x" + "f0".repeat(20), creator, "0a".repeat(32));
  const token = store.issueDoorPass(ev, nowS() - DAY);
  noRings({ down: true });
  assert.equal((await sync(ev, token, [rec(1)])).status, 503, "gen not behind cannot be shown: try later");
  await installRing(creator, 1);
  const moved = await sync(ev, token, [rec(1)]);
  assert.equal(moved.status, 401);
  assert.equal((await moved.json()).reason, "revoked");
  noRings();
  assert.equal((await sync(ev, token, [rec(1)])).status, 200);
});

test("a live pass's sync still answers the full set", async () => {
  const ev = newEvent();
  const token = store.issueDoorPass(ev, nowS() + DAY);
  const body = await (await sync(ev, token, [rec(1)])).json();
  assert.deepEqual(Object.keys(body.data).sort(), ["checkins", "conflicts"]);
});
