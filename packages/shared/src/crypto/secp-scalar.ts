/**
 * The 48-byte → secp256k1 scalar map every seed-derived key uses, with no curve code.
 *
 * Moved here verbatim from secp-hkdf.ts (which re-exports both) so the passkey sign-in
 * window can produce a private key without carrying an elliptic-curve library: it hands
 * the page the scalar, and the page computes the address. `SECP256K1_N` is the curve
 * order as a literal; `test/crypto/secp-scalar.test.ts` pins it to @noble/curves'.
 */

import { hexToBytes } from "@noble/hashes/utils.js";

/** secp256k1 group order. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Map 48 bytes of HKDF output to a scalar in [1, n-1], deterministically.
 *
 * 48 bytes (384 bits) reduced mod (n-1) gives bias ~2^-128 — negligible — and
 * the +1 shift makes zero impossible by construction. No retry loop, no throw:
 * the ~2^-128 "invalid scalar" case of naive 32-byte derivation simply cannot
 * occur. Exported for the range tests; not part of the public derivation API.
 */
export function scalarFromOkm48(okm: Uint8Array): bigint {
  if (okm.length !== 48) {
    throw new Error(`derived-key OKM must be 48 bytes, got ${okm.length}`);
  }
  let x = 0n;
  for (const b of okm) x = (x << 8n) | BigInt(b);
  return (x % (SECP256K1_N - 1n)) + 1n;
}

/** A scalar as a fixed 32-byte big-endian private key. */
export function scalarToPrivateKey(scalar: bigint): Uint8Array {
  return hexToBytes(scalar.toString(16).padStart(64, "0"));
}
