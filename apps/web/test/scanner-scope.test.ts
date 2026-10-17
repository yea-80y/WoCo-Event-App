/**
 * Every check-in stored on a scanner belongs to one event (DB v2). Before, the
 * phone keyed check-ins, its unsynced queue and in-flight claims by ticket alone
 * and never cleared them when a new event was set up: the owner's phone counted
 * 3 in when 1 was, and an earlier event's unsynced records were sent to the new
 * event's /sync - into its server set and the dashboard count.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventKeyBounds, keyEvent, scopeV1Claims, scopeV1Records, storeKey, unsyncedElsewhere } from "../src/lib/scanner/scope.js";

const inRange = (key: string, [lower, upper]: [string, string]) => key >= lower && key < upper;

test("an event's key range holds its own records and no other event's", () => {
  const bounds = eventKeyBounds("e1");
  assert.ok(inRange(storeKey("e1", "ser-1", 1), bounds));
  assert.ok(inRange(storeKey("e1", "zzzz", 999), bounds));
  for (const other of ["e10", "e", "e0", "e2", "f1", "E1"]) {
    assert.ok(!inRange(storeKey(other, "ser-1", 1), bounds), `${other} must not read as e1`);
  }
});

test("the same ticket in two events is two records", () => {
  assert.notEqual(storeKey("e1", "ser-1", 3), storeKey("e2", "ser-1", 3));
  assert.equal(keyEvent(storeKey("e2", "ser-1", 3)), "e2");
  assert.equal(keyEvent("ser-1 3"), null, "a v1 key names no event");
});

test("records unsynced for other events are counted, the current event's are not", () => {
  const keys = [storeKey("old", "s", 1), storeKey("old", "s", 2), storeKey("now", "s", 1)];
  assert.equal(unsyncedElsewhere(keys, "now"), 2);
  assert.equal(unsyncedElsewhere(keys, null), 3, "on the provision screen, every event is 'elsewhere'");
  assert.equal(unsyncedElsewhere([], "now"), 0);
});

const PACK = { eventId: "now", series: [{ seriesId: "ser-now" }] };
const rec = (seriesId: string, edition: number) => ({ seriesId, edition, at: "2026-10-14T19:00:00.000Z", deviceId: "dev00001", method: "scan" as const });

test("v1 → v2: the stored pack's records move under its event", () => {
  const out = scopeV1Records(PACK, [rec("ser-now", 1), rec("ser-now", 2)]);
  assert.deepEqual(out.map((o) => o.key), [storeKey("now", "ser-now", 1), storeKey("now", "ser-now", 2)]);
  assert.deepEqual(out[0].record, rec("ser-now", 1));
});

test("v1 → v2: records of an event the phone holds no pass for are dropped, never put under the current one", () => {
  const out = scopeV1Records(PACK, [rec("ser-old", 1), rec("ser-now", 1)]);
  assert.deepEqual(out.map((o) => o.key), [storeKey("now", "ser-now", 1)]);
  assert.deepEqual(scopeV1Records(undefined, [rec("ser-now", 1)]), [], "no stored pack: nothing can be placed");
});

test("v1 → v2: in-flight claim ids follow the same rule", () => {
  const out = scopeV1Claims(PACK, { "ser-now 4": "claim-a", "ser-old 4": "claim-b", "ser now spaced 2": "claim-c", junk: "x" });
  assert.deepEqual(out, { [storeKey("now", "ser-now", 4)]: "claim-a" });
  assert.deepEqual(scopeV1Claims(undefined, { "ser-now 4": "claim-a" }), {});
});
