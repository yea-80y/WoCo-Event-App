/**
 * The one construction every secp256k1 key derived from the account seed uses.
 *
 * Two siblings hang off it today — the ISSUING key (`issuing.ts`, info
 * `"woco/issuing/v1/{gen}"`) and the CONTENT-FEED SIGNER (`feed-signer.ts`, info
 * `"woco/feed-signer/v1"`) — and they are independent of each other, and of the
 * X25519 encryption key (`keys.ts`, info `"woco/encryption/v1"`), because the
 * HKDF `info` string is the only thing that differs. HKDF's one-wayness is what
 * makes that separation real rather than nominal: a leaked issuing key cannot
 * recover the seed, and so cannot reach the feed signer.
 *
 *   HKDF(sha256, seed, salt = "", info, 48) → scalar in [1, n-1] → secp256k1
 *
 * SALT IS PINNED TO THE EMPTY BYTE STRING, exactly as the X25519 sibling. The
 * info string alone separates the domains, and adding a salt to one sibling
 * later would silently fork it.
 *
 * This file exists so the two siblings CANNOT drift. It was extracted from
 * issuing.ts unchanged: the scalar mapping, the 48-byte length, the empty salt
 * and the address computation are byte-for-byte what shipped in #443, and every
 * issuing key ever derived still derives identically. Do not "tidy" any of it.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { scalarFromOkm48, scalarToPrivateKey } from "./secp-scalar.js";

// The scalar map lives in secp-scalar.ts so the passkey window can use it without
// a curve library; re-exported unchanged for every existing importer.
export { scalarFromOkm48, scalarToPrivateKey } from "./secp-scalar.js";

/** Ethereum address = last 20 bytes of keccak256 over the 64-byte public key
 *  (uncompressed form minus its 0x04 tag byte). Lowercase, 0x-prefixed. */
export function addressFromUncompressed(pub65: Uint8Array): string {
  return "0x" + bytesToHex(keccak_256(pub65.subarray(1)).subarray(12));
}

/** The 20-byte address for a secp256k1 private key. */
export function addressForPrivateKey(privateKey: Uint8Array): string {
  return addressFromUncompressed(secp256k1.getPublicKey(privateKey, false));
}

/** Normalise a 32-byte hex seed, with or without `0x`, or throw saying why. */
export function seedBytes(seedHex: string, label = "seed"): Uint8Array {
  if (typeof seedHex !== "string") throw new Error(`invalid ${label}: expected a hex string`);
  const clean =
    seedHex.startsWith("0x") || seedHex.startsWith("0X") ? seedHex.slice(2) : seedHex;
  const bytes = hexToBytes(clean);
  if (bytes.length !== 32) {
    throw new Error(`invalid ${label}: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Derive a secp256k1 key from the account seed under an HKDF `info` string.
 *
 * Throws on a malformed seed; never on a seed VALUE (see {@link scalarFromOkm48}).
 * Callers that may lack a seed must FAIL LOUD before calling this, never fall
 * through to another signer.
 */
export function deriveSecpFromSeed(
  seedHex: string,
  info: string,
  label = "seed",
): { privateKey: Uint8Array; address: string } {
  const seed = seedBytes(seedHex, label);
  const okm = hkdf(sha256, seed, new Uint8Array(0), utf8ToBytes(info), 48);
  const privateKey = scalarToPrivateKey(scalarFromOkm48(okm));
  return { privateKey, address: addressForPrivateKey(privateKey) };
}
