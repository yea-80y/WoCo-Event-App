import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/**
 * Derive ed25519 private key from a 32-byte hex seed.
 * For web3 users: seed comes from keccak256 of deterministic EIP-712 signature.
 */
export function seedToEd25519(seedHex: string): Uint8Array {
  const clean = seedHex.startsWith("0x") ? seedHex.slice(2) : seedHex;
  const bytes = hexToBytes(clean);
  if (bytes.length !== 32) {
    throw new Error(`Invalid seed: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Get ed25519 public key from private key.
 */
export async function getPublicKey(privateKey: Uint8Array): Promise<Uint8Array> {
  return ed.getPublicKeyAsync(privateKey);
}

/**
 * Derive a full ed25519 keypair from a hex seed.
 * Returns hex-encoded keys (0x-prefixed).
 */
export async function deriveKeypair(seedHex: string): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}> {
  const privateKey = seedToEd25519(seedHex);
  const publicKey = await getPublicKey(privateKey);

  return {
    privateKey,
    publicKey,
    publicKeyHex: "0x" + bytesToHex(publicKey),
  };
}
