/**
 * The ACCOUNT SECRET and everything that hangs off it (#186).
 *
 * Generation 0 is the identity seed every account has today. Removing a passkey
 * makes generation g+1: 32 fresh random bytes, never derived from anything the
 * removed passkey holds, handed to the remaining passkeys through the key ring
 * (`ring.ts`). The keys a removed passkey must lose come from the CURRENT secret,
 * with the same frozen labels the seed has always used:
 *
 *   content-feed signer   HKDF(S_g, "woco/feed-signer/v1")        crypto/feed-signer.ts
 *   order key (X-Wing)    HKDF(S_g, "woco/encryption/xwing/v1")   crypto/xwing.ts
 *   door-pass roster key  HKDF(S_g, "", "woco/door-pass/roster/v1:{eventId}:{passId}")
 *
 * So at generation 0 nothing moves. What stays on the identity seed whatever the
 * generation: the issuing key (every use of it sits behind a session the removed
 * passkey cannot get - revisit before anything verifies issuing signatures out of
 * band) and the portability envelopes (they carry the seed; the ring carries the rest).
 *
 * A passkey's BOX KEY is not account material: it is the passkey's own, from its PRF.
 *
 * Import by subpath, lazily in the browser: this loads the lattice code.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveFeedSignerKey } from "../crypto/feed-signer.js";
import { passkeyBoxSeed } from "../crypto/passkey-prf.js";
import { deriveXWingKeypairFromSeed, xwing, type XWingKeypair } from "../crypto/xwing.js";
import { orderKeyRef } from "../event/order-key.js";
import type { Hex0x } from "../types.js";

export const ACCOUNT_SECRET_BYTES = 32;

/** HKDF info prefix for a door pass's roster key. FROZEN: change it and every door
 *  device holding a pass reads its roster as garbage until the pass is made again. */
export const DOOR_PASS_ROSTER_INFO = "woco/door-pass/roster/v1";

const ID_RE = /^[0-9A-Za-z_-]{1,128}$/;

export interface AccountKeys {
  feedSigner: { privKey: Hex0x; address: string };
  orderKey: XWingKeypair;
  /** Content address of `orderKey.publicKey`: what an event names and a ring states. */
  orderKeyRef: string;
}

export function assertAccountSecret(secret: Uint8Array): Uint8Array {
  if (!(secret instanceof Uint8Array) || secret.length !== ACCOUNT_SECRET_BYTES) {
    throw new Error(`account secret must be ${ACCOUNT_SECRET_BYTES} bytes`);
  }
  return secret;
}

/** A fresh secret for the next generation. The caller zeroes it once it is sealed and stored. */
export function newAccountSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ACCOUNT_SECRET_BYTES));
}

/** The keys a generation's secret gives. Generation 0's are today's seed-derived keys. */
export function accountKeysOf(secret: Uint8Array): AccountKeys {
  const hex = bytesToHex(assertAccountSecret(secret));
  const orderKey = deriveXWingKeypairFromSeed(hex);
  return { feedSigner: deriveFeedSignerKey(hex), orderKey, orderKeyRef: orderKeyRef(orderKey.publicKey) };
}

/**
 * A door pass's roster key: any device of the account at this generation derives it,
 * so nothing is stored in the clear. `passId` is the server's id for the pass, so a
 * new pass is a new key even for the same event.
 */
export function doorPassRosterKey(secret: Uint8Array, eventId: string, passId: string): Uint8Array {
  if (!ID_RE.test(eventId) || !ID_RE.test(passId)) {
    throw new Error("door pass roster key: event and pass ids must be [0-9A-Za-z_-]");
  }
  return hkdf(
    sha256,
    assertAccountSecret(secret),
    new Uint8Array(0),
    utf8ToBytes(`${DOOR_PASS_ROSTER_INFO}:${eventId}:${passId}`),
    32,
  );
}

/** A passkey's box key, from its PRF output. */
export function passkeyBoxKeypair(prfSecret: string | Uint8Array): XWingKeypair {
  const seed = passkeyBoxSeed(prfSecret);
  try {
    const { secretKey, publicKey } = xwing.keygen(seed);
    return { secretKey, publicKey };
  } finally {
    seed.fill(0);
  }
}
