/**
 * The door pass's secret P (#186, v2): worked out from the account's current secret, the
 * event and the pass id - so it changes with each of them, and is never stored. One P in
 * the link gives the scanner both keys: the roster's, and the door entries key whose
 * public half the dashboard registers - with proof it holds the account's ORDER key.
 *
 * MUTATION: register a key from another pass id and "the registered key is the one the
 * link opens" goes red; answer with anything but the order key and the vector goes red;
 * skip the nonce-length check and "refuses a nonce that is not 32 bytes" goes red; drop a
 * zeroing and "zeroes" goes red; encrypt the roster under P itself and "never under P
 * itself" goes red; push the roster before the pass and the panel test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64UrlDecode, encodeDoorPassToken } from "@woco/shared";
import { doorKeyRefOf, doorRosterKey } from "@woco/shared/checkin/door-keys";
import { doorEntriesKeypair } from "@woco/shared/checkin/door-entries-key";
import { doorKeyProofSealContext, openBox, sealBox } from "@woco/shared/crypto/sealed-box";
import { deriveXWingKeypairFromSeed } from "@woco/shared/crypto/xwing";
import { hexToBytes } from "@noble/hashes/utils.js";
import { doorPassProof, doorPassRegistration, doorPassSecretB64url, newDoorPassId } from "../src/lib/scanner/door-pass-key.ts";
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

test("the registration: the key the link opens", () => {
  const jti = newDoorPassId();
  const reg = doorPassRegistration(S1, EVENT, jti);
  assert.equal(reg.jti, jti);
  // What the scanner derives from the link must be exactly what was registered.
  const p = base64UrlDecode(doorPassSecretB64url(S1, EVENT, token(jti)));
  const scannerKey = doorEntriesKeypair(p).publicKey;
  assert.equal(doorKeyRefOf(hexToBytes(reg.doorKey)), doorKeyRefOf(scannerKey), "the registered key is the one the link opens");
  assert.equal(reg.doorKeyRef, doorKeyRefOf(scannerKey));
});

const V = JSON.parse(readFileSync(new URL("../../../packages/shared/test/keyring/keyring-v1-vectors.json", import.meta.url), "utf8"));
const PV = V.doorPass.proof;
const proofFields = () => ({ eventId: V.doorPass.eventId, parent: PV.parent, jti: V.doorPass.passId, mode: PV.mode, doorKeyRef: V.doorPass.entriesKeyRef });
async function vectorChallenge(nonce = hexToBytes(PV.nonce)) {
  const pk = deriveXWingKeypairFromSeed(V.secret).publicKey;
  return { challengeId: PV.challengeId, box: await sealBox(pk, nonce, doorKeyProofSealContext(V.doorPass.eventId, PV.parent, PV.challengeId)) };
}

test("the proof: opens the challenge with the current order key and gives the vector's answer", async () => {
  assert.equal(await doorPassProof({ current: V.secret }, await vectorChallenge(), proofFields()), PV.proof);
  await assert.rejects(doorPassProof({ current: "22".repeat(32) }, await vectorChallenge(), proofFields()), undefined, "another account's order key");
});

test("the proof zeroes the order key and the nonce, whatever happens", async () => {
  const seen: Uint8Array[] = [];
  const spy = async (sk: Uint8Array, box: unknown, ctx: { info: string; aad: string }) => {
    seen.push(sk);
    const nonce = await openBox(sk, box, ctx);
    seen.push(nonce);
    return nonce;
  };
  assert.equal(await doorPassProof({ current: V.secret }, await vectorChallenge(), proofFields(), spy), PV.proof);
  assert.equal(seen.length, 2);
  for (const b of seen) assert.ok(b.every((x) => x === 0), "zeroed");
  seen.length = 0;
  await assert.rejects(doorPassProof({ current: V.secret }, await vectorChallenge(new Uint8Array(31)), proofFields(), spy), /didn't check out/);
  for (const b of seen) assert.ok(b.every((x) => x === 0), "zeroed on refusal too");
});

test("the proof refuses a nonce that is not 32 bytes", async () => {
  for (const len of [0, 31, 33, 64]) {
    await assert.rejects(doorPassProof({ current: V.secret }, await vectorChallenge(new Uint8Array(len).fill(7)), proofFields()), /didn't check out/, String(len));
  }
});

test("the key module carries no feed-signer or personal-sign path", () => {
  const src = readFileSync(new URL("../src/lib/scanner/door-pass-key.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /feed-signer|deriveFeedSignerKey|FeedSigner|personal|signPersonalMessage|recoverPersonalSigner|crypto\/issuing/);
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

test("the panel issues the pass with its proof before the roster, stores no secret, and refuses a pass from older keys", () => {
  const panel = readFileSync(new URL("../src/lib/creator/dashboard/CheckinPanel.svelte", import.meta.url), "utf8");
  const gen = panel.slice(panel.indexOf("async function generatePass("), panel.indexOf("async function refreshRoster("));
  assert.match(gen, /await issueDoorPassWithProof\(\s*\{ eventId, parent, mode: passMode, secrets: keys \},\s*\{ challenge: requestDoorPassChallenge, issue: issueDoorPass \},\s*\)/);
  assert.ok(gen.indexOf("await issueDoorPassWithProof(") < gen.indexOf("await pushCheckinRoster("), "pass first");
  assert.match(gen, /const parent = auth\.parent\?\.toLowerCase\(\);/);
  assert.doesNotMatch(panel, /getContentFeedSigner|feedSigner/, "no feed-signer path");
  assert.match(gen, /stored = \{ token: issued\.token, exp: issued\.exp, mode: issued\.mode, gen: keys\.gen,/);
  assert.doesNotMatch(panel, /stored = \{[^}]*(url|passSecret|doorKey|proof|nonce)/, "the link, its secret and the proof are never stored");
  assert.doesNotMatch(panel, /generateRosterKeyB64url|getRandomValues/);
  const refresh = panel.slice(panel.indexOf("async function refreshRoster("), panel.indexOf("async function copyLink("));
  assert.match(refresh, /if \(keys\.gen !== stored\.gen\) \{[\s\S]*?throw new Error\(KEYS_CHANGED\);/);
});
