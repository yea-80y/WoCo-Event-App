/**
 * Door pass v2: one secret P in the link, two leaves under it, and the statement that
 * registers the door entries key.
 *
 *  - Every label is pinned through its OUTPUT (`keyring-v1-vectors.json` "doorPass"):
 *    a one-byte change to a label, a salt or the derivation order moves a vector.
 *  - The registration is personal_sign, cross-checked against ethers' `verifyMessage`.
 *  - A door entry opens only under its own event, pass, ticket type and ticket.
 *
 * MUTATION: swap the roster and entries labels and both vectors go red; drop the pass id
 * from the entry AAD and "a box lifted to another pass" goes red; let the registration
 * message accept an uppercase pass id and "refuses" goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyMessage } from "ethers";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { doorPassSecret } from "../../src/keyring/account-secret.js";
import {
  DOOR_KEY_REGISTRATION_PREFIX,
  DOOR_ROSTER_AEAD_INFO,
  doorKeyRefOf,
  doorKeyRegistrationMessage,
  doorRosterKey,
} from "../../src/checkin/door-keys.js";
import { DOOR_ENTRIES_KEM_INFO, doorEntriesKeypair } from "../../src/checkin/door-entries-key.js";
import { DOOR_ENTRY_SEAL_INFO, doorEntrySealContext, openBoxJson, sealBoxJson } from "../../src/crypto/sealed-box.js";
import { deriveFeedSignerKey } from "../../src/crypto/feed-signer.js";
import { recoverPersonalSigner, signPersonalMessage } from "../../src/crypto/issuing.js";

const V = JSON.parse(readFileSync(fileURLToPath(new URL("./keyring-v1-vectors.json", import.meta.url)), "utf8"));
const D = V.doorPass;
const P = () => doorPassSecret(hexToBytes(V.secret), D.eventId, D.passId);

test("FROZEN: labels, byte for byte", () => {
  assert.equal(DOOR_ROSTER_AEAD_INFO, "woco/door-pass/v2/roster-aead");
  assert.equal(DOOR_ENTRIES_KEM_INFO, "woco/door-pass/v2/entries-kem");
  assert.equal(DOOR_KEY_REGISTRATION_PREFIX, "woco/door-key/v1");
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

test("FROZEN: the registration statement and its signature, verified by ethers", () => {
  const msg = doorKeyRegistrationMessage(D.eventId, D.passId, D.entriesKeyRef);
  assert.equal(msg, D.registration);
  const signer = deriveFeedSignerKey(V.secret);
  const sig = signPersonalMessage(msg, hexToBytes(signer.privKey.slice(2)));
  assert.equal(sig, D.registrationSig);
  assert.equal(verifyMessage(msg, sig).toLowerCase(), V.feedSigner);
  assert.equal(recoverPersonalSigner(msg, sig), V.feedSigner);
});

test("the registration statement refuses ids that would make it ambiguous", () => {
  assert.throws(() => doorKeyRegistrationMessage(D.eventId, D.passId.toUpperCase(), D.entriesKeyRef), /malformed/);
  assert.throws(() => doorKeyRegistrationMessage(D.eventId, "short", D.entriesKeyRef), /malformed/);
  assert.throws(() => doorKeyRegistrationMessage("ev\n1", D.passId, D.entriesKeyRef), /malformed/);
  assert.throws(() => doorKeyRegistrationMessage(D.eventId, D.passId, "ab"), /malformed/);
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
