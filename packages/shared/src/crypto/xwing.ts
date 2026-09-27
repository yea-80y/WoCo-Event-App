/**
 * X-Wing — the hybrid post-quantum KEM every sealed box moves to (#642).
 *
 * X-Wing (draft-connolly-cfrg-xwing-kem) combines ML-KEM-768 with X25519 and hashes
 * both shared secrets together, so a box stays confidential while EITHER half holds:
 * a future quantum computer breaks X25519, a flaw in the young ML-KEM code leaves
 * X25519 standing. Sealed orders and escrowed seeds sit on public storage for years,
 * which is what makes "decrypt later" the threat worth paying for now.
 *
 * The implementation is `@noble/post-quantum`'s `ml_kem768_x25519`, the draft's
 * construction, pinned to an exact version. It has NOT been independently audited
 * (self-audit at 0.6.1, April 2026, per its README); the hybrid is the mitigation,
 * and `test/crypto/xwing.test.ts` holds it to the draft's own test vectors.
 *
 * This file is the PRIMITIVE and the account's KEY. Sealing goes through HPKE
 * (`sealed-box.ts`) over the adapter in `xwing-hpke.ts`; nothing seals with the raw
 * KEM directly. Import it by subpath (`@woco/shared/crypto/xwing`) so the ~20 KB of
 * lattice code loads only where a box is sealed or opened.
 */

import { ml_kem768_x25519 } from "@noble/post-quantum/hybrid.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** The X-Wing KEM. Decapsulation key = its 32-byte seed; nothing larger at rest. */
export const xwing = ml_kem768_x25519;

export const XWING_SEED_BYTES = 32;
export const XWING_PUBLIC_KEY_BYTES = 1216;
export const XWING_CIPHERTEXT_BYTES = 1120;
export const XWING_SHARED_SECRET_BYTES = 32;

/**
 * HKDF info for the account's X-Wing key. FROZEN: change it and every organiser's
 * published key moves, so every box already sealed to the old one stops opening.
 * A sibling of "woco/encryption/v1" (the classical X25519 key, kept only for the
 * quarantined credits rail), "woco/issuing/v1/{gen}" and "woco/feed-signer/v1".
 */
export const XWING_ENCRYPTION_INFO = "woco/encryption/xwing/v1";

export interface XWingKeypair {
  /** The 32-byte X-Wing decapsulation key (the draft's `sk`, which is its seed). */
  secretKey: Uint8Array;
  /** The 1216-byte encapsulation key: ML-KEM-768 (1184) ‖ X25519 (32). */
  publicKey: Uint8Array;
}

/**
 * The account's X-Wing keypair, from the identity seed.
 *
 *   sk = HKDF-SHA256(seed, salt = "", XWING_ENCRYPTION_INFO, 32)
 *   (sk, pk) = X-Wing.GenerateKeyPairDerand(sk)
 *
 * Its X25519 half is a NEW key, not the "woco/encryption/v1" one: X-Wing derives
 * both halves from its own seed, and splicing an existing X25519 key in would not
 * be X-Wing any more (and would fail the draft's vectors).
 *
 * This deliberately does NOT go through the HPKE adapter's `deriveKeyPair`, which
 * the draft defines as SHAKE256(ikm) first. Two routes to "the account key" that
 * differ by one hash would be a silent key change waiting to happen; this is the
 * only one, and it is pinned.
 */
export function deriveXWingKeypairFromSeed(identitySeedHex: string): XWingKeypair {
  const clean = identitySeedHex.startsWith("0x") ? identitySeedHex.slice(2) : identitySeedHex;
  const seed = hexToBytes(clean);
  if (seed.length !== 32) throw new Error(`invalid identity seed: expected 32 bytes, got ${seed.length}`);
  const sk = hkdf(sha256, seed, new Uint8Array(0), utf8ToBytes(XWING_ENCRYPTION_INFO), XWING_SEED_BYTES);
  const { secretKey, publicKey } = xwing.keygen(sk);
  return { secretKey, publicKey };
}

/**
 * Refuse a public key of the wrong length with a readable message. The deeper check
 * (FIPS 203's ML-KEM modulus check) is noble's own, run inside every encapsulate —
 * a malformed key throws there and is never "sealed to anyway".
 */
export function assertXWingPublicKey(publicKey: Uint8Array): void {
  if (publicKey.length !== XWING_PUBLIC_KEY_BYTES) {
    throw new Error(`X-Wing public key must be ${XWING_PUBLIC_KEY_BYTES} bytes, got ${publicKey.length}`);
  }
}

/**
 * Full validity, for a key about to be PUBLISHED (not per seal): the length AND
 * FIPS 203's ML-KEM modulus check, by running noble's own encapsulate once and
 * discarding the result — so the check is noble's, never a second hand-written one.
 */
export function isValidXWingPublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== XWING_PUBLIC_KEY_BYTES) return false;
  try {
    xwing.encapsulate(publicKey);
    return true;
  } catch {
    return false;
  }
}
