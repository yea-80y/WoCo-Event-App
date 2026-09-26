/**
 * #641 - a ticket is admitted ONCE, across every scanner.
 *
 * Before this, a scanner admitted on its own local set and told the server up
 * to 30 seconds later, so two scanners on one queue could both admit the same
 * ticket even with full signal. Door check-in is a capacity control: that is a
 * crowd-safety defect, not a statistic to report afterwards.
 *
 * Now admission is `claimCheckin` - first claim anywhere wins, persisted before
 * it answers - and a "single" door pass is bound to one device, the only case
 * where a scanner may admit offline.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { CheckinRecord } from "@woco/shared";

let store: typeof import("../src/lib/checkin/store.js");
let app: Hono;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-checkin-claim-")));
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-checkin-claims";
  store = await import("../src/lib/checkin/store.js");
  const { checkin } = await import("../src/routes/checkin.js");
  app = new Hono();
  app.route("/api/checkin", checkin);
});

const DEV_A = "deviceaaaaaaaaaa";
const DEV_B = "devicebbbbbbbbbb";

function rec(over: Partial<CheckinRecord> = {}): CheckinRecord {
  return { seriesId: "ser-1", edition: 7, at: "2026-09-26T20:00:00.000Z", deviceId: DEV_A, method: "scan", claimId: "claim-a", ...over };
}

const checkinsDir = () => join(process.cwd(), ".data", "checkins");
const eventFile = (eventId: string) =>
  join(checkinsDir(), `${createHash("sha256").update(eventId).digest("hex")}.json`);

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test("first claim anywhere wins; a second attempt is told who is already in", () => {
  const first = store.claimCheckin("evt-first", rec());
  assert.equal(first.status, "admitted");
  const second = store.claimCheckin("evt-first", rec({ deviceId: DEV_B, claimId: "claim-b", at: "2026-09-26T20:00:01.000Z" }));
  assert.equal(second.status, "already-in");
  assert.equal(second.record.deviceId, DEV_A, "the holder is the first claim, with its device and time");
  assert.equal(store.readCheckins("evt-first").length, 1);
});

test("of many claims for one ticket, exactly one is admitted", () => {
  const results = Array.from({ length: 25 }, (_, i) =>
    store.claimCheckin("evt-many", rec({ deviceId: `device${String(i).padStart(10, "0")}`, claimId: `claim-${i}` })),
  );
  assert.equal(results.filter((r) => r.status === "admitted").length, 1);
});

test("the same attempt retrying is admitted again, never refused as a duplicate of itself", () => {
  assert.equal(store.claimCheckin("evt-retry", rec()).status, "admitted");
  const retry = store.claimCheckin("evt-retry", rec({ at: "2026-09-26T20:00:09.000Z" }));
  assert.equal(retry.status, "admitted");
  assert.equal(retry.record.at, "2026-09-26T20:00:00.000Z", "the original record stands");
  assert.equal(store.readCheckins("evt-retry").length, 1);
});

test("a claim that cannot be saved is refused, and leaves nothing behind", () => {
  store.claimCheckin("evt-seed-dir", rec()); // make sure the directory exists
  chmodSync(checkinsDir(), 0o500);
  try {
    assert.throws(() => store.claimCheckin("evt-unsaved", rec()), /could not be persisted/);
    assert.equal(store.readCheckins("evt-unsaved").length, 0, "memory must not hold what disk does not");
  } finally {
    chmodSync(checkinsDir(), 0o700);
  }
  assert.equal(store.claimCheckin("evt-unsaved", rec()).status, "admitted", "and the ticket can still be admitted once saving works");
});

test("a check-in set that exists but cannot be read fails closed", () => {
  mkdirSync(checkinsDir(), { recursive: true });
  writeFileSync(eventFile("evt-corrupt"), "{not json");
  assert.throws(() => store.claimCheckin("evt-corrupt", rec()), /present but unreadable/,
    "reading it as empty would admit everyone again, then overwrite who is already in");
});

test("a malformed claim is refused", () => {
  assert.throws(() => store.claimCheckin("evt-bad", rec({ claimId: undefined })), /invalid check-in claim/);
  assert.throws(() => store.claimCheckin("evt-bad", rec({ edition: 0 })), /invalid check-in claim/);
});

test("a pass names its mode; one issued without a mode is 'several', which cannot admit twice", () => {
  const legacy = store.issueDoorPass("evt-mode-default", Math.floor(Date.now() / 1000) + 3600);
  const v1 = store.verifyDoorPass(legacy);
  assert.ok(v1.ok && v1.mode === "several");
  const single = store.issueDoorPass("evt-mode-single", Math.floor(Date.now() / 1000) + 3600, undefined, "single");
  const v2 = store.verifyDoorPass(single);
  assert.ok(v2.ok && v2.mode === "single");
});

test("a single-scanner pass binds to its first device and refuses every other", () => {
  store.issueDoorPass("evt-bind", Math.floor(Date.now() / 1000) + 3600, undefined, "single");
  assert.equal(store.bindSinglePassDevice("evt-bind", DEV_A), true);
  assert.equal(store.bindSinglePassDevice("evt-bind", DEV_A), true, "the bound device keeps working");
  assert.equal(store.bindSinglePassDevice("evt-bind", DEV_B), false);
  store.issueDoorPass("evt-bind", Math.floor(Date.now() / 1000) + 3600, undefined, "single");
  assert.equal(store.bindSinglePassDevice("evt-bind", DEV_B), true, "regenerating the pass is how it moves to another phone");
});

test("a claimId replayed from another device is not a retry: it is told already in", () => {
  assert.equal(store.claimCheckin("evt-replay", rec()).status, "admitted");
  const replay = store.claimCheckin("evt-replay", rec({ deviceId: DEV_B }));
  assert.equal(replay.status, "already-in", "same claimId, different device");
  assert.equal(replay.record.deviceId, DEV_A);
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

function claim(eventId: string, token: string, device: string | null, body: Record<string, unknown>) {
  return app.request(`/api/checkin/${eventId}/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Door-Pass": token,
      ...(device ? { "X-Scanner-Device": device } : {}),
    },
    body: JSON.stringify(body),
  });
}

const body = (over: Record<string, unknown> = {}) => ({
  seriesId: "ser-1", edition: 3, method: "scan", claimId: "c-1", at: "2026-09-26T21:00:00.000Z", ...over,
});

test("route: two scanners on a 'several' pass - one admits, the other is told already in", async () => {
  const token = store.issueDoorPass("evt-route", Math.floor(Date.now() / 1000) + 3600);
  const a = await claim("evt-route", token, DEV_A, body());
  assert.equal(a.status, 200);
  assert.equal((await a.json()).data.status, "admitted");
  const b = await claim("evt-route", token, DEV_B, body({ claimId: "c-2" }));
  const bj = await b.json();
  assert.equal(bj.data.status, "already-in");
  assert.equal(bj.data.record.deviceId, DEV_A);
});

test("route: a 'single' pass admits only on its bound device", async () => {
  const token = store.issueDoorPass("evt-route-single", Math.floor(Date.now() / 1000) + 3600, undefined, "single");
  store.bindSinglePassDevice("evt-route-single", DEV_A);
  const other = await claim("evt-route-single", token, DEV_B, body());
  assert.equal(other.status, 409);
  assert.equal((await other.json()).reason, "wrong-device");
  const bound = await claim("evt-route-single", token, DEV_A, body());
  assert.equal(bound.status, 200);
});

test("route: no device id, a malformed claim, or a pass for another event is refused", async () => {
  const token = store.issueDoorPass("evt-route-bad", Math.floor(Date.now() / 1000) + 3600);
  assert.equal((await claim("evt-route-bad", token, null, body())).status, 400);
  assert.equal((await claim("evt-route-bad", token, DEV_A, body({ edition: "7" }))).status, 400);
  assert.equal((await claim("evt-other", token, DEV_A, body())).status, 403);
});

test("route: a claim that cannot be saved answers 503, never 'admitted'", async () => {
  const token = store.issueDoorPass("evt-route-503", Math.floor(Date.now() / 1000) + 3600);
  chmodSync(checkinsDir(), 0o500);
  try {
    const res = await claim("evt-route-503", token, DEV_A, body());
    assert.equal(res.status, 503);
  } finally {
    chmodSync(checkinsDir(), 0o700);
  }
});

test("route: a scanner that sends no device id gets no pack, whatever the mode", async () => {
  // A pre-#641 bundle ignores the door mode and admits offline; it must not
  // provision onto a shared ("several") door.
  const token = store.issueDoorPass("evt-route-pack", Math.floor(Date.now() / 1000) + 3600);
  const res = await app.request("/api/checkin/evt-route-pack/pack", { headers: { "X-Door-Pass": token } });
  assert.equal(res.status, 400);
});
