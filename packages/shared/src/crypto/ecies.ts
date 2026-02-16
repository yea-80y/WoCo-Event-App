/**
 * ECIES (Elliptic Curve Integrated Encryption Scheme)
 *
 * Standard construction used by Signal, MetaMask eth-sig-util, and
 * libsodium sealed boxes:
 *
 *   seal:  ephemeral X25519 ECDH  →  HKDF-SHA256  →  AES-256-GCM encrypt
 *   open:  recipient X25519 ECDH  →  HKDF-SHA256  →  AES-256-GCM decrypt
 *
 * Security properties:
 *   - Forward secrecy per message (fresh ephemeral key each time)
 *   - Authenticated encryption (AES-GCM prevents tampering)
 *   - Only the recipient's private key can decrypt
 *   - Uses Web Crypto API for AES-GCM (hardware-accelerated, constant-time)
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { SealedBox } from "./types.js";
import { ECIES_INFO } from "./constants.js";

/** Strip optional 0x prefix and convert hex to bytes. */
function toBytes(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}

/**
 * Copy bytes into a fresh ArrayBuffer.
 * Required because @noble libs return Uint8Array<ArrayBufferLike> but
 * Web Crypto's BufferSource expects ArrayBuffer (not SharedArrayBuffer).
 */
function buf(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * Encrypt data to a recipient's X25519 public key.
 *
 * @param recipientPublicKey - X25519 public key (hex string or Uint8Array)
 * @param plaintext          - Data to encrypt (raw bytes)
 * @returns SealedBox containing ephemeral public key, IV, and ciphertext
 */
export async function seal(
  recipientPublicKey: Uint8Array | string,
  plaintext: Uint8Array,
): Promise<SealedBox> {
  const pubKeyBytes =
    typeof recipientPublicKey === "string"
      ? toBytes(recipientPublicKey)
      : recipientPublicKey;

  // 1. Fresh ephemeral X25519 keypair (forward secrecy)
  const ephPrivate = crypto.getRandomValues(new Uint8Array(32));
  const ephPublic = x25519.getPublicKey(ephPrivate);

  // 2. ECDH shared secret
  const shared = x25519.getSharedSecret(ephPrivate, pubKeyBytes);

  // 3. HKDF key derivation (salt = ephemeral public key for domain separation)
  const aesKeyBytes = hkdf(sha256, shared, ephPublic, ECIES_INFO, 32);

  // 4. AES-256-GCM encrypt via Web Crypto
  const aesKey = await crypto.subtle.importKey(
    "raw",
    buf(aesKeyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    buf(plaintext),
  );

  return {
    ephemeralPublicKey: bytesToHex(ephPublic),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt a sealed box with the recipient's X25519 private key.
 *
 * @param recipientPrivateKey - X25519 private key (hex string or Uint8Array)
 * @param box                 - SealedBox to decrypt
 * @returns Decrypted plaintext bytes
 * @throws If decryption fails (wrong key, tampered data, etc.)
 */
export async function open(
  recipientPrivateKey: Uint8Array | string,
  box: SealedBox,
): Promise<Uint8Array> {
  const privKeyBytes =
    typeof recipientPrivateKey === "string"
      ? toBytes(recipientPrivateKey)
      : recipientPrivateKey;

  const ephPublic = hexToBytes(box.ephemeralPublicKey);
  const iv = hexToBytes(box.iv);
  const ciphertext = hexToBytes(box.ciphertext);

  // 1. ECDH shared secret (same as seal, reversed roles)
  const shared = x25519.getSharedSecret(privKeyBytes, ephPublic);

  // 2. HKDF key derivation (same parameters → same AES key)
  const aesKeyBytes = hkdf(sha256, shared, ephPublic, ECIES_INFO, 32);

  // 3. AES-256-GCM decrypt via Web Crypto
  const aesKey = await crypto.subtle.importKey(
    "raw",
    buf(aesKeyBytes),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(iv) },
    aesKey,
    buf(ciphertext),
  );

  return new Uint8Array(plaintext);
}

// ---------------------------------------------------------------------------
// Convenience helpers for JSON payloads
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encrypt a JSON-serialisable value to a recipient's public key.
 * Convenience wrapper: JSON.stringify → UTF-8 encode → seal.
 */
export async function sealJson(
  recipientPublicKey: Uint8Array | string,
  data: unknown,
): Promise<SealedBox> {
  return seal(recipientPublicKey, encoder.encode(JSON.stringify(data)));
}

/**
 * Decrypt a sealed box and parse the result as JSON.
 * Convenience wrapper: open → UTF-8 decode → JSON.parse.
 */
export async function openJson<T = unknown>(
  recipientPrivateKey: Uint8Array | string,
  box: SealedBox,
): Promise<T> {
  const plaintext = await open(recipientPrivateKey, box);
  return JSON.parse(decoder.decode(plaintext));
}
