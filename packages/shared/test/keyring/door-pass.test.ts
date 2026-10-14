/**
 * Door pass v2: one secret P in the link, two leaves under it, and the order-key proof
 * that registers the door entries key.
 *
 *  - Every label is pinned through its OUTPUT (`keyring-v1-vectors.json` "doorPass"):
 *    a one-byte change to a label, a salt or the derivation order moves a vector.
 *  - The proof is HMAC-SHA256, cross-checked against node:crypto's own HMAC.
 *  - A door entry and a proof challenge open only under their own context.
 *
 * MUTATION: swap the roster and entries labels and both vectors go red; drop the pass id
 * from the entry AAD and "a box lifted to another pass" goes red; let the transcript accept
 * an uppercase id or a ":" and "refuses" goes red; drop the account from the challenge AAD
 * and "a challenge opens only" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { doorPassSecret } from "../../src/keyring/account-secret.js";
import {
  DOOR_KEY_PROOF_TRANSCRIPT_PREFIX,
  DOOR_ROSTER_AEAD_INFO,
  doorKeyProof,
  doorKeyProofTranscript,
  doorKeyRefOf,
  doorRosterKey,
  type DoorKeyProofFields,
} from "../../src/checkin/door-keys.js";
import { DOOR_ENTRIES_KEM_INFO, doorEntriesKeypair } from "../../src/checkin/door-entries-key.js";
import {
  DOOR_ENTRY_SEAL_INFO,
  DOOR_KEY_PROOF_SEAL_INFO,
  doorEntrySealContext,
  doorKeyProofSealContext,
  openBox,
  openBoxJson,
  sealBox,
  sealBoxJson,
} from "../../src/crypto/sealed-box.js";
import { deriveXWingKeypairFromSeed } from "../../src/crypto/xwing.js";

const V = JSON.parse(readFileSync(fileURLToPath(new URL("./keyring-v1-vectors.json", import.meta.url)), "utf8"));
const D = V.doorPass;
const P = () => doorPassSecret(hexToBytes(V.secret), D.eventId, D.passId);

test("FROZEN: labels, byte for byte", () => {
  assert.equal(DOOR_ROSTER_AEAD_INFO, "woco/door-pass/v2/roster-aead");
  assert.equal(DOOR_ENTRIES_KEM_INFO, "woco/door-pass/v2/entries-kem");
  assert.equal(DOOR_KEY_PROOF_TRANSCRIPT_PREFIX, "woco/door-key-proof/v1");
  assert.equal(DOOR_KEY_PROOF_SEAL_INFO, "woco/door-key-proof/v1");
  assert.equal(DOOR_ENTRY_SEAL_INFO, "woco/door-entry/v1");
});

test("FROZEN: one pass secret gives the roster key and the door entries key, by output", () => {
  const p = P();
  assert.equal(bytesToHex(p), D.secret);
  assert.equal(bytesToHex(doorRosterKey(p)), D.rosterKey);
  assert.equal(doorKeyRefOf(doorEntriesKeypair(p).publicKey), D.entriesKeyRef);
  assert.notEqual(bytesToHex(doorRosterKey(p)), D.secret, "P itself is never a key");
  assert.notEqual(bytesToHex(doorEntriesKeypair(p).secretKey), D.rosterKey, "the two leaves are different bytes");
});

const PF = (): DoorKeyProofFields => ({
  eventId: D.eventId,
  parent: D.proof.parent,
  challengeId: D.proof.challengeId,
  jti: D.passId,
  mode: D.proof.mode,
  doorKeyRef: D.entriesKeyRef,
});

test("FROZEN: the proof's transcript and value, by output, and HMAC as node computes it", () => {
  const nonce = hexToBytes(D.proof.nonce);
  assert.equal(doorKeyProofTranscript(PF()), D.proof.transcript);
  assert.equal(doorKeyProof(nonce, PF()), D.proof.proof);
  assert.equal(createHmac("sha256", Buffer.from(nonce)).update(D.proof.transcript).digest("hex"), D.proof.proof);
  assert.equal(doorKeyProofSealContext(D.eventId, D.proof.parent, D.proof.challengeId).aad, D.proof.challengeAad);
});

test("the proof binds every field", () => {
  const nonce = hexToBytes(D.proof.nonce);
  for (const [k, v] of Object.entries({
    eventId: "3f2a9c1e-0000-4000-8000-000000000009",
    parent: "0x" + "cd".repeat(20),
    challengeId: "1f".repeat(16),
    jti: "f".repeat(32),
    mode: "several",
    doorKeyRef: "00".repeat(32),
  })) {
    assert.notEqual(doorKeyProof(nonce, { ...PF(), [k]: v }), D.proof.proof, k);
  }
  assert.notEqual(doorKeyProof(new Uint8Array(32).fill(0x78), PF()), D.proof.proof, "another nonce");
});

test("the transcript and the challenge context refuse a separator or a bad charset", () => {
  for (const bad of [
    { eventId: "ev:1" }, { eventId: "ev\n1" }, { parent: D.proof.parent.toUpperCase().replace("0X", "0x") },
    { parent: "abab" }, { challengeId: "0F".repeat(16) }, { challengeId: "short" }, { jti: D.passId.toUpperCase() },
    { mode: "both" }, { doorKeyRef: "ab" },
  ]) {
    assert.throws(() => doorKeyProofTranscript({ ...PF(), ...bad } as DoorKeyProofFields), /malformed/, JSON.stringify(bad));
  }
  assert.throws(() => doorKeyProof(new Uint8Array(31), PF()), /32 bytes/);
  assert.throws(() => doorKeyProofSealContext("ev:1", D.proof.parent, D.proof.challengeId), /malformed/);
  assert.throws(() => doorKeyProofSealContext(D.eventId, "0x" + "AB".repeat(20), D.proof.challengeId), /malformed/);
  assert.throws(() => doorKeyProofSealContext(D.eventId, D.proof.parent, "a:b"), /malformed/);
  assert.throws(() => doorKeyProofSealContext(D.eventId, D.proof.parent, ""), /malformed/);
});

test("a challenge opens only with the account's order key, under its own event, account and id", async () => {
  const order = deriveXWingKeypairFromSeed(V.secret);
  const nonce = hexToBytes(D.proof.nonce);
  const ctx = (o: { eventId?: string; parent?: string; challengeId?: string } = {}) =>
    doorKeyProofSealContext(o.eventId ?? D.eventId, o.parent ?? D.proof.parent, o.challengeId ?? D.proof.challengeId);
  const box = await sealBox(order.publicKey, nonce, ctx());
  assert.deepEqual(await openBox(order.secretKey, box, ctx()), nonce);
  for (const other of [{ eventId: "3f2a9c1e-0000-4000-8000-000000000009" }, { parent: "0x" + "cd".repeat(20) }, { challengeId: "1f".repeat(16) }]) {
    await assert.rejects(openBox(order.secretKey, box, ctx(other)), undefined, JSON.stringify(other));
  }
  await assert.rejects(openBox(deriveXWingKeypairFromSeed("22".repeat(32)).secretKey, box, ctx()), undefined, "another account's key");
});

test("FROZEN: a door entry's context", () => {
  assert.equal(doorEntrySealContext(D.eventId, D.passId, D.entrySeriesId, D.entryEdition).aad, D.entryAad);
  assert.throws(() => doorEntrySealContext(D.eventId, D.passId, D.entrySeriesId, 0), /malformed/);
  assert.throws(() => doorEntrySealContext(D.eventId, "nothex", D.entrySeriesId, 1), /malformed/);
  assert.throws(() => doorEntrySealContext("Upper", D.passId, D.entrySeriesId, 1), /malformed/);
});

test("a door entry opens with the door key under its own context, and under no other", async () => {
  const kp = doorEntriesKeypair(P());
  const ctx = (o: { eventId?: string; passId?: string; seriesId?: string; edition?: number } = {}) =>
    doorEntrySealContext(o.eventId ?? D.eventId, o.passId ?? D.passId, o.seriesId ?? D.entrySeriesId, o.edition ?? D.entryEdition);
  const plain = { v: 1, seriesId: D.entrySeriesId, edition: D.entryEdition, email: "a@example.com", buyerName: "A Buyer" };
  const box = await sealBoxJson(kp.publicKey, plain, ctx());
  assert.deepEqual(await openBoxJson(kp.secretKey, box, ctx()), plain);
  for (const other of [
    { eventId: "3f2a9c1e-0000-4000-8000-000000000009" },
    { passId: "f".repeat(32) },
    { seriesId: "5d6e7f80-0000-4000-8000-000000000009" },
    { edition: D.entryEdition + 1 },
  ]) {
    await assert.rejects(openBoxJson(kp.secretKey, box, ctx(other)), undefined, `lifted to ${JSON.stringify(other)}`);
  }
  const otherPass = doorEntriesKeypair(doorPassSecret(hexToBytes(V.secret), D.eventId, "f".repeat(32)));
  await assert.rejects(openBoxJson(otherPass.secretKey, box, ctx()), undefined, "another pass's key");
});
