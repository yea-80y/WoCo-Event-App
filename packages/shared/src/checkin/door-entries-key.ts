/**
 * The door entries key: the X-Wing keypair each new sale's email and card name are
 * sealed to, so the door phones can read them and the server that seals them cannot.
 *
 *   seed = HKDF-SHA256(P, "", "woco/door-pass/v2/entries-kem", 32)
 *   (sk, pk) = X-Wing.GenerateKeyPairDerand(seed)
 *
 * The same pinned route as `deriveXWingKeypairFromSeed`, never HPKE's `deriveKeyPair`.
 * Import by subpath and lazily in the browser: it loads the lattice code.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { xwing, XWING_SEED_BYTES, type XWingKeypair } from "../crypto/xwing.js";
import { assertDoorPassSecret } from "./door-keys.js";

/** HKDF info for the door entries key's seed. FROZEN. */
export const DOOR_ENTRIES_KEM_INFO = "woco/door-pass/v2/entries-kem";

export function doorEntriesKeypair(passSecret: Uint8Array): XWingKeypair {
  const seed = hkdf(sha256, assertDoorPassSecret(passSecret), new Uint8Array(0), utf8ToBytes(DOOR_ENTRIES_KEM_INFO), XWING_SEED_BYTES);
  try {
    const { secretKey, publicKey } = xwing.keygen(seed);
    return { secretKey, publicKey };
  } finally {
    seed.fill(0);
  }
}
