/**
 * QUARANTINED X25519-only sealing — the credits rail and NOTHING else (#642).
 *
 * This is the hand-assembled ECIES every sealed box used before #642:
 *
 *   seal:  ephemeral X25519 ECDH → HKDF-SHA256(salt = ephPub, info "woco/order/v1")
 *          → AES-256-GCM (random 12-byte IV) → { ephemeralPublicKey, iv, ciphertext }
 *
 * It is NOT post-quantum: a box sealed here can be opened by whoever breaks X25519
 * later. Orders, contact lists and the recovery escrow moved to the X-Wing v2 box
 * (`@woco/shared/crypto/sealed-box`). The credits rail (`woco.credit.v1`, out of
 * launch scope) keeps this construction frozen inside its own module until it is
 * migrated, by owner decision — the `holder-key.ts` pattern: an out-of-scope rail
 * carries its own legacy crypto so no launch path can reach it.
 * `apps/web/test/no-legacy-seal.test.ts` fails if anything outside `lib/credits/`
 * seals or opens this way.
 *
 * The bytes are unchanged from the shared module it came from, info label
 * included, so private credits sealed before the move still open.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** The retired X25519 box. */
export interface LegacySealedBox {
  /** Ephemeral X25519 public key used for ECDH (hex, no 0x prefix) */
  ephemeralPublicKey: string;
  /** AES-256-GCM initialisation vector (hex, 24 chars = 12 bytes) */
  iv: string;
  /** Encrypted payload with GCM auth tag appended (hex) */
  ciphertext: string;
}

// FROZEN with the credits rail's existing sealed statements.
const LEGACY_ECIES_INFO_BYTES = utf8ToBytes("woco/order/v1");

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
 * @returns LegacySealedBox containing ephemeral public key, IV, and ciphertext
 */
export async function seal(
  recipientPublicKey: Uint8Array | string,
  plaintext: Uint8Array,
): Promise<LegacySealedBox> {
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
  const aesKeyBytes = hkdf(sha256, shared, ephPublic, LEGACY_ECIES_INFO_BYTES, 32);

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
 * @param box                 - LegacySealedBox to decrypt
 * @returns Decrypted plaintext bytes
 * @throws If decryption fails (wrong key, tampered data, etc.)
 */
export async function open(
  recipientPrivateKey: Uint8Array | string,
  box: LegacySealedBox,
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
  const aesKeyBytes = hkdf(sha256, shared, ephPublic, LEGACY_ECIES_INFO_BYTES, 32);

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
): Promise<LegacySealedBox> {
  return seal(recipientPublicKey, encoder.encode(JSON.stringify(data)));
}

/**
 * Decrypt a sealed box and parse the result as JSON.
 * Convenience wrapper: open → UTF-8 decode → JSON.parse.
 */
export async function openJson<T = unknown>(
  recipientPrivateKey: Uint8Array | string,
  box: LegacySealedBox,
): Promise<T> {
  const plaintext = await open(recipientPrivateKey, box);
  return JSON.parse(decoder.decode(plaintext));
}
