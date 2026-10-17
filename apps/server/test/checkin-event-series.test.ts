/**
 * /claim and /sync take records only for the event's own ticket types.
 *
 * A scanner kept its check-ins by ticket alone, so an earlier event's unsynced
 * records on the same phone were sent to the next event's /sync and merged into
 * its set: the owner's dashboard counted 3 in when 1 was (2026-10-14). The series
 * list comes from the last pack this server built for the event - never a Swarm
 * read on a claim - and until one is built since a restart, records go through.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { CheckinRecord } from "@woco/shared";

let store: typeof import("../src/lib/checkin/store.js");
let series: typeof import("../src/lib/checkin/event-series.js");
let app: Hono;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-checkin-series-")));
  process.env.CHECKIN_PASS_SECRET = "test-secret-for-checkin-series";
  store = await import("../src/lib/checkin/store.js");
  series = await import("../src/lib/checkin/event-series.js");
  const { checkin } = await import("../src/routes/checkin.js");
  app = new Hono();
  app.route("/api/checkin", checkin);
});

beforeEach(() => series.forgetEventSeries());

const DEV = "deviceaaaaaaaaaa";
const pass = (eventId: string) => store.issueDoorPass(eventId, Math.floor(Date.now() / 1000) + 3600);
const rec = (seriesId: string, edition: number): CheckinRecord =>
  ({ seriesId, edition, at: `2026-10-14T19:00:0${edition}.000Z`, deviceId: DEV, method: "scan" });

function claim(eventId: string, token: string, seriesId: string, edition: number, claimId: string) {
  return app.request(`/api/checkin/${eventId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Door-Pass": token, "X-Scanner-Device": DEV },
    body: JSON.stringify({ seriesId, edition, method: "scan", claimId, at: "2026-10-14T19:00:00.000Z" }),
  });
}

function sync(eventId: string, token: string, checkins: CheckinRecord[]) {
  return app.request(`/api/checkin/${eventId}/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Door-Pass": token, "X-Scanner-Device": DEV },
    body: JSON.stringify({ deviceId: DEV, checkins }),
  });
}

test("a claim for another event's ticket type is refused, and nothing is recorded", async () => {
  const token = pass("evt-claim");
  series.rememberEventSeries("evt-claim", ["ser-mine"]);
  const res = await claim("evt-claim", token, "ser-earlier-event", 1, "c-1");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, "wrong-event");
  assert.equal(store.readCheckins("evt-claim").length, 0);
  assert.equal((await claim("evt-claim", token, "ser-mine", 1, "c-2")).status, 200);
});

test("a sync keeps the event's own records and drops another event's", async () => {
  const token = pass("evt-sync");
  series.rememberEventSeries("evt-sync", ["ser-mine"]);
  const res = await sync("evt-sync", token, [rec("ser-mine", 1), rec("ser-earlier-event", 1), rec("ser-earlier-event", 2)]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.data.checkins.map((r: CheckinRecord) => r.seriesId), ["ser-mine"]);
  assert.deepEqual(store.readCheckins("evt-sync").map((r) => r.seriesId), ["ser-mine"], "never merged into the set");
});

test("records merged here before the check never come back out of a sync", async () => {
  const token = pass("evt-polluted");
  store.mergeCheckins("evt-polluted", [rec("ser-earlier-event", 1), rec("ser-mine", 1)]);
  series.rememberEventSeries("evt-polluted", ["ser-mine"]);
  const body = await (await sync("evt-polluted", token, [])).json();
  assert.deepEqual(body.data.checkins.map((r: CheckinRecord) => r.seriesId), ["ser-mine"]);
});

test("before any pack since a restart, claims and syncs go through as before", async () => {
  const token = pass("evt-cold");
  assert.equal((await claim("evt-cold", token, "ser-anything", 1, "c-1")).status, 200,
    "the door does not stop on our bookkeeping");
  const body = await (await sync("evt-cold", token, [rec("ser-other", 2)])).json();
  assert.equal(body.data.checkins.length, 2);
});

test("a new pack replaces the list: a ticket type added since is accepted", async () => {
  const token = pass("evt-added");
  series.rememberEventSeries("evt-added", ["ser-1"]);
  assert.equal((await claim("evt-added", token, "ser-2", 1, "c-1")).status, 400);
  series.rememberEventSeries("evt-added", ["ser-1", "ser-2"]);
  assert.equal((await claim("evt-added", token, "ser-2", 1, "c-2")).status, 200);
});

test("the list is learned from every pack, and the pack, the sync and the dashboard count use it", () => {
  // Route wiring that needs a real event feed to exercise; checked at source,
  // as checkin-trusted-event-id.test.ts does for the same file.
  const src = readFileSync(new URL("../src/routes/checkin.ts", import.meta.url), "utf-8");
  const pack = src.slice(src.indexOf('checkin.get("/:eventId/pack"'), src.indexOf('checkin.post("/:eventId/sync"'));
  assert.match(pack, /if \(!event\) return[^\n]*\n\s*rememberEventSeries\(eventId, event\.series\.map\(\(s\) => s\.seriesId\)\);/,
    "remembered as soon as the event resolves, before anything can fail");
  assert.match(pack, /checkins: ofEventSeries\(eventId, readCheckins\(eventId\)\)/);
  const status = src.slice(src.indexOf('"/:id/checkin-status"'), src.indexOf("// Scanner endpoints"));
  assert.match(status, /readCheckins\(eventId\)\.filter\(\(r\) => own\.has\(r\.seriesId\)\)/);
});

test("another event's records are never reported as conflicts at this door", async () => {
  const token = pass("evt-conflicts");
  store.mergeCheckins("evt-conflicts", [rec("ser-earlier-event", 1), { ...rec("ser-earlier-event", 1), deviceId: "devicebbbbbbbbbb" }]);
  series.rememberEventSeries("evt-conflicts", ["ser-mine"]);
  const body = await (await sync("evt-conflicts", token, [])).json();
  assert.deepEqual(body.data.conflicts, []);
});
