/**
 * X25519 encryption-key derivation from the identity seed.
 *
 * The seed is never used as the X25519 scalar directly: an HKDF step under its
 * own label keeps the encryption key independent of every other key the same
 * seed roots (issuing key, feed signer).
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// @noble/hashes v2 requires `info` as bytes; v1 UTF-8 encoded the string itself.
// Encoding here yields the identical derived key (verified against Node's RFC 5869
// hkdfSync), so existing encrypted history stays decryptable.
const ENCRYPTION_INFO_BYTES = utf8ToBytes("woco/encryption/v1");

/**
 * Derive an X25519 encryption keypair from an existing identity seed.
 *
 * Uses HKDF to derive a cryptographically independent encryption key
 * from the identity seed — zero additional wallet popups required.
 * Same wallet → same identity seed → same encryption keypair on any device.
 *
 * @param identitySeedHex - The identity seed (keccak256 of EIP-712 signature)
 */
export function deriveEncryptionKeypairFromSeed(identitySeedHex: string): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} {
  const identitySeed = hexToBytes(
    identitySeedHex.startsWith("0x") ? identitySeedHex.slice(2) : identitySeedHex,
  );
  const encSeed = hkdf(sha256, identitySeed, new Uint8Array(0), ENCRYPTION_INFO_BYTES, 32);
  const publicKey = x25519.getPublicKey(encSeed);

  return {
    privateKey: encSeed,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}
