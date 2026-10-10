/**
 * The door pass's roster key (#186): worked out from the account's current secret, the
 * event and the pass id - so it changes with each of them, and is never stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeDoorPassToken } from "@woco/shared";
import { doorPassRosterKeyB64url } from "../src/lib/scanner/door-pass-key.ts";

const S1 = "0x" + "11".repeat(32);
const S2 = "0x" + "22".repeat(32);
const EVENT = "0b3c5c1e-7d1a-4c55-9a8e-2f6d0e1b9c44";
const token = (jti: string, eventId = EVENT) => encodeDoorPassToken({ v: "v1", eventId, jti, exp: 2_000_000_000 }, "ab".repeat(32));

test("the key is fixed by secret, event and pass - and changes with each", () => {
  const k = doorPassRosterKeyB64url(S1, EVENT, token("a".repeat(32)));
  assert.equal(k, doorPassRosterKeyB64url(S1, EVENT, token("a".repeat(32))));
  assert.notEqual(k, doorPassRosterKeyB64url(S2, EVENT, token("a".repeat(32))), "new account keys, new roster key");
  assert.notEqual(k, doorPassRosterKeyB64url(S1, EVENT, token("b".repeat(32))), "new pass, new roster key");
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
});

test("a pass for another event is refused", () => {
  assert.throws(() => doorPassRosterKeyB64url(S1, EVENT, token("a".repeat(32), "another-event")), /isn't for this event/);
  assert.throws(() => doorPassRosterKeyB64url(S1, EVENT, "not-a-token"), /isn't for this event/);
});

test("the panel issues the pass before the roster, stores no key, and refuses a pass from older keys", () => {
  const panel = readFileSync(new URL("../src/lib/creator/dashboard/CheckinPanel.svelte", import.meta.url), "utf8");
  const gen = panel.slice(panel.indexOf("async function generatePass("), panel.indexOf("async function refreshRoster("));
  assert.ok(gen.indexOf("await issueDoorPass(") < gen.indexOf("await pushCheckinRoster("), "pass first");
  assert.match(gen, /stored = \{ token: issued\.token, exp: issued\.exp, mode: issued\.mode, gen: keys\.gen,/);
  assert.doesNotMatch(panel, /stored = \{[^}]*url/, "the link (with its key) is never stored");
  assert.doesNotMatch(panel, /generateRosterKeyB64url|getRandomValues/);
  const refresh = panel.slice(panel.indexOf("async function refreshRoster("), panel.indexOf("async function copyLink("));
  assert.match(refresh, /if \(keys\.gen !== stored\.gen\) \{[\s\S]*?throw new Error\(KEYS_CHANGED\);/);
});
