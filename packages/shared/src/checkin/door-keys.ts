/**
 * The two leaves of a door pass's secret P (`doorPassSecret` in keyring/account-secret.ts),
 * and the proof that registers the door entries key.
 *
 *   roster key          K = HKDF-SHA256(P, "", "woco/door-pass/v2/roster-aead", 32)  AES-256-GCM
 *   door entries key    see door-entries-key.ts (X-Wing, kept apart: it loads the lattice code)
 *
 * P travels only in the door-pass link fragment. It is used by no primitive itself, so the
 * AES key and the KEM seed are siblings and never the same bytes in two roles.
 *
 * Light on purpose (hashes only): the scanner imports it on boot to open its roster.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const DOOR_PASS_SECRET_BYTES = 32;

/** HKDF info for the roster's AES-GCM key. FROZEN. */
export const DOOR_ROSTER_AEAD_INFO = "woco/door-pass/v2/roster-aead";

/** First line of the door-key proof transcript. FROZEN (the same label is the HPKE info
 *  of the challenge box, `DOOR_KEY_PROOF_SEAL_INFO` in crypto/sealed-box.ts). */
export const DOOR_KEY_PROOF_TRANSCRIPT_PREFIX = "woco/door-key-proof/v1";

/** A pass id: 16 random bytes, lowercase hex. Chosen by the organiser's device, so the
 *  pass secret (and its door key) exist before the server is asked to issue the pass. */
export const DOOR_PASS_ID_RE = /^[0-9a-f]{32}$/;

const EVENT_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
const REF_RE = /^[0-9a-f]{64}$/;
const PARENT_RE = /^0x[0-9a-f]{40}$/;
/** A challenge id: 16 random bytes, lowercase hex. */
export const DOOR_KEY_CHALLENGE_ID_RE = /^[0-9a-f]{32}$/;

export function assertDoorPassSecret(passSecret: Uint8Array): Uint8Array {
  if (!(passSecret instanceof Uint8Array) || passSecret.length !== DOOR_PASS_SECRET_BYTES) {
    throw new Error(`door pass secret must be ${DOOR_PASS_SECRET_BYTES} bytes`);
  }
  return passSecret;
}

/** The roster's AES-256-GCM key. */
export function doorRosterKey(passSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, assertDoorPassSecret(passSecret), new Uint8Array(0), utf8ToBytes(DOOR_ROSTER_AEAD_INFO), 32);
}

/** A door entries public key's reference: sha256 of its 1216 bytes, lowercase hex. */
export function doorKeyRefOf(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey));
}

/** What a door-key proof binds: the server checks it over its OWN event id and parent. */
export interface DoorKeyProofFields {
  eventId: string;
  /** The account, lowercase 0x + 40 hex. */
  parent: string;
  challengeId: string;
  jti: string;
  mode: "single" | "several";
  doorKeyRef: string;
}

/**
 * The text a door-key proof is an HMAC of. FROZEN, byte for byte. Every field is checked
 * against a charset that cannot contain the separator, so no two field sets share a text.
 */
export function doorKeyProofTranscript(f: DoorKeyProofFields): string {
  if (
    !EVENT_ID_RE.test(f.eventId) || !PARENT_RE.test(f.parent) || !DOOR_KEY_CHALLENGE_ID_RE.test(f.challengeId) ||
    !DOOR_PASS_ID_RE.test(f.jti) || (f.mode !== "single" && f.mode !== "several") || !REF_RE.test(f.doorKeyRef)
  ) {
    throw new Error("door key proof: malformed field");
  }
  return `${DOOR_KEY_PROOF_TRANSCRIPT_PREFIX}\n${f.eventId}\n${f.parent}\n${f.challengeId}\n${f.jti}\n${f.mode}\n${f.doorKeyRef}\n`;
}

/**
 * Proof that whoever registers a door key holds the account's CURRENT order key - which a
 * login session alone does not: HMAC-SHA256 under the 32-byte nonce the server sealed to
 * that key, over the transcript. The nonce itself never travels back. Hex.
 */
export function doorKeyProof(nonce: Uint8Array, f: DoorKeyProofFields): string {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error("door key proof: the nonce must be 32 bytes");
  return bytesToHex(hmac(sha256, nonce, utf8ToBytes(doorKeyProofTranscript(f))));
}
