/**
 * X25519 key derivation utilities for encryption.
 *
 * Mirrors the Ed25519 pattern in apps/web/src/lib/pod/keys.ts:
 *   - seedToEd25519  →  seedToX25519
 *   - getPublicKey   →  getX25519PublicKey
 *   - deriveKeypair  →  deriveEncryptionKeypair
 *
 * X25519 private keys are 32 raw bytes (clamping is done internally
 * by the x25519 functions). A keccak256 hash output maps directly.
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

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
 * Derive an X25519 encryption keypair from an existing POD identity seed.
 *
 * Uses HKDF to derive a cryptographically independent encryption key
 * from the POD signing seed — zero additional wallet popups required.
 * Same wallet → same POD seed → same encryption keypair on any device.
 *
 * @param podSeedHex - The POD identity seed (keccak256 of EIP-712 signature)
 */
export function deriveEncryptionKeypairFromPodSeed(podSeedHex: string): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} {
  const podSeed = hexToBytes(
    podSeedHex.startsWith("0x") ? podSeedHex.slice(2) : podSeedHex,
  );
  const encSeed = hkdf(sha256, podSeed, new Uint8Array(0), "woco/encryption/v1", 32);
  const publicKey = x25519.getPublicKey(encSeed);

  return {
    privateKey: encSeed,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}
