/**
 * X25519 key derivation utilities for encryption.
 *
 * Mirrors the ed25519 pattern in apps/web/src/lib/credits/holder-key.ts:
 *   - seedToEd25519        →  seedToX25519
 *   - getPublicKey         →  getX25519PublicKey
 *   - deriveHolderKeypair  →  deriveEncryptionKeypair
 *
 * X25519 private keys are 32 raw bytes (clamping is done internally
 * by the x25519 functions). A keccak256 hash output maps directly.
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
 * Convert a 32-byte hex seed to an X25519 private key.
 * For wallet users: seed = keccak256(EIP-712 signature).
 */
export function seedToX25519(seedHex: string): Uint8Array {
  const clean = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
  const bytes = hexToBytes(clean);
  if (bytes.length !== 32) {
    throw new Error(`Invalid seed: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Get X25519 public key from private key bytes. */
export function getX25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/**
 * Derive a full X25519 keypair from a hex seed.
 *
 * @param seedHex - 32-byte hex string (with or without 0x prefix)
 * @returns privateKey bytes, publicKey bytes, and hex-encoded public key
 */
export function deriveEncryptionKeypair(seedHex: string): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} {
  const privateKey = seedToX25519(seedHex);
  const publicKey = getX25519PublicKey(privateKey);

  return {
    privateKey,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}

/**
 * Derive an X25519 encryption keypair from an existing identity seed seed.
 *
 * Uses HKDF to derive a cryptographically independent encryption key
 * from the identity seed — zero additional wallet popups required.
 * Same wallet → same identity seed → same encryption keypair on any device.
 *
 * @param identitySeedHex - The identity seed seed (keccak256 of EIP-712 signature)
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
