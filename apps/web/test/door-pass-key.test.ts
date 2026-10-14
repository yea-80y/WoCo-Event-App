/**
 * The door pass's secret P (#186, v2): worked out from the account's current secret, the
 * event and the pass id - so it changes with each of them, and is never stored. One P in
 * the link gives the scanner both keys: the roster's, and the door entries key whose
 * public half the dashboard registers, signed by the account's content-feed signer.
 *
 * MUTATION: register a key from another pass id and "the registered key is the one the
 * link opens" goes red; sign with anything but the feed signer and "the registration
 * verifies" goes red; encrypt the roster under P itself and "never under P itself" goes red;
 * issue the pass after the roster push and the panel test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64UrlDecode, encodeDoorPassToken } from "@woco/shared";
import { doorKeyRefOf, doorKeyRegistrationMessage, doorRosterKey } from "@woco/shared/checkin/door-keys";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { deriveFeedSignerKey } from "@woco/shared/crypto/feed-signer";
import { recoverPersonalSigner } from "@woco/shared/crypto/issuing";
import { hexToBytes } from "@noble/hashes/utils.js";
import { doorPassRegistration, doorPassSecretB64url, newDoorPassId } from "../src/lib/scanner/door-pass-key.ts";
import { decryptRoster, encryptRoster } from "../src/lib/scanner/roster-crypto.ts";

const S1 = "0x" + "11".repeat(32);
const S2 = "0x" + "22".repeat(32);
const EVENT = "0b3c5c1e-7d1a-4c55-9a8e-2f6d0e1b9c44";
const token = (jti: string, eventId = EVENT) => encodeDoorPassToken({ v: "v1", eventId, jti, exp: 2_000_000_000 }, "ab".repeat(32));

test("the secret is fixed by account secret, event and pass - and changes with each", () => {
  const k = doorPassSecretB64url(S1, EVENT, token("a".repeat(32)));
  assert.equal(k, doorPassSecretB64url(S1, EVENT, token("a".repeat(32))));
  assert.notEqual(k, doorPassSecretB64url(S2, EVENT, token("a".repeat(32))), "new account keys, new secret");
  assert.notEqual(k, doorPassSecretB64url(S1, EVENT, token("b".repeat(32))), "new pass, new secret");
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
});

test("a pass for another event is refused", () => {
  assert.throws(() => doorPassSecretB64url(S1, EVENT, token("a".repeat(32), "another-event")), /isn't for this event/);
  assert.throws(() => doorPassSecretB64url(S1, EVENT, "not-a-token"), /isn't for this event/);
});

test("a new pass id is 16 random bytes, lowercase hex", () => {
  const a = newDoorPassId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newDoorPassId());
});

test("the registration: the key the link opens, signed by the account's feed signer", () => {
  const jti = newDoorPassId();
  const reg = doorPassRegistration(S1, EVENT, jti, deriveFeedSignerKey(S1).privKey);
  assert.equal(reg.jti, jti);
  // What the scanner derives from the link must be exactly what was registered.
  const p = base64UrlDecode(doorPassSecretB64url(S1, EVENT, token(jti)));
  const scannerKey = doorEntriesKeypair(p).publicKey;
  assert.equal(doorKeyRefOf(hexToBytes(reg.doorKey)), doorKeyRefOf(scannerKey), "the registered key is the one the link opens");
  const msg = doorKeyRegistrationMessage(EVENT, jti, doorKeyRefOf(scannerKey));
  assert.equal(recoverPersonalSigner(msg, reg.sig), deriveFeedSignerKey(S1).address, "the registration verifies");
  assert.notEqual(recoverPersonalSigner(msg, doorPassRegistration(S1, EVENT, jti, deriveFeedSignerKey(S2).privKey).sig), deriveFeedSignerKey(S1).address);
});

test("one secret in the link opens the roster the panel encrypted, and no other does", async () => {
  const p1 = doorPassSecretB64url(S1, EVENT, token("a".repeat(32)));
  const entries = [{ seriesId: "s1", seriesName: "GA", edition: 1, email: "a@example.com" }];
  const roster = { ...(await encryptRoster(entries, p1)), updatedAt: "2026-10-14T00:00:00Z" };
  assert.deepEqual(await decryptRoster(roster, p1), entries);
  await assert.rejects(decryptRoster(roster, doorPassSecretB64url(S1, EVENT, token("b".repeat(32)))));
});

test("the roster is sealed under P's roster-key child, never under P itself", async () => {
  const pB64 = doorPassSecretB64url(S1, EVENT, token("c".repeat(32)));
  const enc = await encryptRoster([{ seriesId: "s1", seriesName: "GA", edition: 1 }], pB64);
  const b64 = (x: string) => Uint8Array.from(atob(x), (ch) => ch.charCodeAt(0));
  const open = async (raw: Uint8Array) => {
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) as BufferSource }, key, b64(enc.ciphertext) as BufferSource);
  };
  const p = base64UrlDecode(pB64);
  await assert.doesNotReject(open(doorRosterKey(p)));
  await assert.rejects(open(p));
});

test("the panel issues the pass with its registration before the roster, stores no secret, and refuses a pass from older keys", () => {
  const panel = readFileSync(new URL("../src/lib/creator/dashboard/CheckinPanel.svelte", import.meta.url), "utf8");
  const gen = panel.slice(panel.indexOf("async function generatePass("), panel.indexOf("async function refreshRoster("));
  assert.match(gen, /const feedSigner = await auth\.getContentFeedSigner\(\);/, "the signer comes from the auth store");
  assert.match(gen, /await issueDoorPass\(eventId, passMode, doorPassRegistration\(keys\.current, eventId, newDoorPassId\(\), feedSigner\.privKey\)\)/);
  assert.ok(gen.indexOf("await issueDoorPass(") < gen.indexOf("await pushCheckinRoster("), "pass first");
  assert.match(gen, /stored = \{ token: issued\.token, exp: issued\.exp, mode: issued\.mode, gen: keys\.gen,/);
  assert.doesNotMatch(panel, /stored = \{[^}]*(url|passSecret|doorKey|sig)/, "the link, its secret and the registration are never stored");
  assert.doesNotMatch(panel, /generateRosterKeyB64url|getRandomValues/);
  const refresh = panel.slice(panel.indexOf("async function refreshRoster("), panel.indexOf("async function copyLink("));
  assert.match(refresh, /if \(keys\.gen !== stored\.gen\) \{[\s\S]*?throw new Error\(KEYS_CHANGED\);/);
});
