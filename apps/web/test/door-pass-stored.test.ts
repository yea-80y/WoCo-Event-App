/**
 * A door pass the dashboard stored before the pass secret P (no `v: 2`) has a roster
 * sealed under the old key and no door entries key on the server: a link built for it
 * now would open nothing at the door, silently. It shows as stale, exactly like a pass
 * from older account keys, and the organiser is asked to make a new one (Fable sign-off).
 *
 * MUTATION: drop the format check in `storedPassStale` and "a pass stored before P is
 * stale" goes red; stop writing `v` on a new pass and the panel test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOOR_PASS_FORMAT,
  KEYS_CHANGED,
  parseStoredDoorPass,
  PASS_FROM_OLDER_VERSION,
  storedPassStale,
} from "../src/lib/creator/dashboard/door-pass-stored.js";

const before = JSON.stringify({ token: "v1.x.j.1.t", exp: 1_900_000_000, mode: "single", gen: 0, rosterPushedAt: "2026-10-14T18:00:00.000Z" });
const now = JSON.stringify({ v: 2, token: "v1.x.j.1.t", exp: 1_900_000_000, mode: "several", gen: 3 });

test("a pass stored before P is kept, so it can be shown as stale - never turned into a link", () => {
  const p = parseStoredDoorPass(before);
  assert.ok(p, "kept: the organiser is told, rather than the pass vanishing");
  assert.equal(p.v, undefined);
  assert.equal(storedPassStale(p, 0), PASS_FROM_OLDER_VERSION, "same keys, but made before P");
  assert.equal(storedPassStale(p, 5), PASS_FROM_OLDER_VERSION);
});

test("a v2 pass is fine under the keys it was made with, stale under newer ones", () => {
  const p = parseStoredDoorPass(now);
  assert.deepEqual(p, { v: DOOR_PASS_FORMAT, token: "v1.x.j.1.t", exp: 1_900_000_000, mode: "several", gen: 3 });
  assert.equal(storedPassStale(p!, 3), null);
  assert.equal(storedPassStale(p!, 4), KEYS_CHANGED);
  assert.equal(storedPassStale({ ...p!, v: 3 }, 3), PASS_FROM_OLDER_VERSION, "an unknown format is not trusted either");
});

test("nothing usable stored reads as no pass", () => {
  for (const raw of [null, "", "not json", "null", JSON.stringify({ token: "t", exp: 1 }), JSON.stringify({ key: "in-clear", token: "t" })]) {
    assert.equal(parseStoredDoorPass(raw), null, String(raw));
  }
});

test("the panel: a new pass is stored as v2, and showing or re-pushing a stale one builds no link", () => {
  const panel = readFileSync(new URL("../src/lib/creator/dashboard/CheckinPanel.svelte", import.meta.url), "utf8");
  const show = panel.slice(panel.indexOf("async function showPass("), panel.indexOf("async function generatePass("));
  assert.match(show, /const stale = storedPassStale\(stored, keys\.gen\);\s*if \(stale\) \{\s*passStale = stale;\s*passUrl = null;\s*return;\s*\}/);
  assert.ok(show.indexOf("storedPassStale(") < show.indexOf("buildDoorPassUrl("), "checked before any link is built");
  assert.match(panel, /stored = parseStoredDoorPass\(raw\);/);
  assert.match(panel, /stored = \{ v: DOOR_PASS_FORMAT, token: issued\.token/);
  assert.match(panel, /<p class="error">\{passStale\}<\/p>/);
});
