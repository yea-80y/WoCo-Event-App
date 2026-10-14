/**
 * The two leaves of a door pass's secret P (`doorPassSecret` in keyring/account-secret.ts),
 * and the statement that registers the door entries key.
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
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const DOOR_PASS_SECRET_BYTES = 32;

/** HKDF info for the roster's AES-GCM key. FROZEN. */
export const DOOR_ROSTER_AEAD_INFO = "woco/door-pass/v2/roster-aead";

/** First line of the statement that registers a pass's door entries key. FROZEN. */
export const DOOR_KEY_REGISTRATION_PREFIX = "woco/door-key/v1";

/** A pass id: 16 random bytes, lowercase hex. Chosen by the organiser's device, so the
 *  pass secret (and its door key) exist before the server is asked to issue the pass. */
export const DOOR_PASS_ID_RE = /^[0-9a-f]{32}$/;

const EVENT_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
const REF_RE = /^[0-9a-f]{64}$/;

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

/**
 * The exact text the account's content-feed signer personal-signs to register a door
 * key. The feed signer comes from the account secret, which a login session alone does
 * not hold: without this, anyone with a stolen session could register their own key and
 * have every later buyer's email sealed to it. FROZEN, byte for byte.
 */
export function doorKeyRegistrationMessage(eventId: string, passId: string, doorKeyRef: string): string {
  if (!EVENT_ID_RE.test(eventId) || !DOOR_PASS_ID_RE.test(passId) || !REF_RE.test(doorKeyRef)) {
    throw new Error("door key registration: malformed event id, pass id or key ref");
  }
  return `${DOOR_KEY_REGISTRATION_PREFIX}\n${eventId}\n${passId}\n${doorKeyRef}\n`;
}
