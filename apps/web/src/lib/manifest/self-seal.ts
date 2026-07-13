/**
 * Encrypt-to-SELF for the user manifest (Recovery Increment 3a).
 *
 * The manifest is the user's OWN private data — only they ever read it — so this
 * is symmetric AEAD, not public-key crypto: a fresh single-recipient HPKE seal
 * would be gratuitous when the only recipient is the sealer. Construction, every
 * step a single vetted-library call (no hand-rolled crypto):
 *
 *  - KEY = HKDF-SHA256 over the user's feed-signer PRIVATE KEY (32-byte secp256k1
 *    scalar → high-entropy IKM) under a distinct `info` label. HKDF (not the raw
 *    key) so the AEAD key is cryptographically SEPARATED from the ECDSA signing
 *    use of the same secret — never reuse one key across two cryptosystems. The
 *    feed-signer secret is chosen because it is the SAME root that OWNS the
 *    manifest SOC and is available WITHOUT a prompt after login (restored from the
 *    device key store or recovery escrow), so reading the manifest never pops a
 *    signing dialog.
 *  - AEAD = XChaCha20-Poly1305 (`@noble/ciphers`), random 24-byte nonce, with the
 *    account (parent/Kernel) address bound as additional-data so a copied envelope
 *    cannot be replayed or misread under another account.
 *
 * Confidentiality equals the secrecy of the feed-signer key: whoever can derive it
 * (the user on any device, or a guardian who restored it from escrow) can read the
 * manifest — nobody else, and never the server, which sees ciphertext only.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { SelfSealedEnvelope } from "@woco/shared";

/** XChaCha20-Poly1305 nonce length (bytes). */
const XNONCE_LEN = 24;

/**
 * HKDF `info` label domain-separating the manifest AEAD key from every other use
 * of the feed-signer secret (SOC signing, any future derivation).
 */
const HKDF_INFO = new TextEncoder().encode("woco/manifest/enc/v1");

/**
 * The AEAD additional-data binding the envelope to one account. Namespaced +
 * lowercased so casing variation cannot break the bind; MUST be byte-identical at
 * seal and open.
 */
function aadBytes(parentAddress: string): Uint8Array {
  return new TextEncoder().encode(`woco/manifest/v1:${parentAddress.toLowerCase()}`);
}

/**
 * Derive the 32-byte manifest AEAD key from the feed-signer private key. The
 * caller MUST zero the returned key after use; the intermediate IKM copy is zeroed
 * here.
 */
function deriveManifestKey(feedSignerPrivKey: string): Uint8Array {
  const hex = feedSignerPrivKey.startsWith("0x") ? feedSignerPrivKey.slice(2) : feedSignerPrivKey;
  const ikm = hexToBytes(hex);
  if (ikm.length !== 32) {
    ikm.fill(0);
    throw new Error("deriveManifestKey: feed-signer key must be 32 bytes");
  }
  try {
    return hkdf(sha256, ikm, undefined, HKDF_INFO, 32);
  } finally {
    ikm.fill(0);
  }
}

/** Seal a JSON-serialisable manifest body to self. */
export function sealToSelf(args: {
  feedSignerPrivKey: string;
  parentAddress: string;
  data: unknown;
}): SelfSealedEnvelope {
  const key = deriveManifestKey(args.feedSignerPrivKey);
  try {
    const nonce = randomBytes(XNONCE_LEN);
    const aad = aadBytes(args.parentAddress);
    const plaintext = new TextEncoder().encode(JSON.stringify(args.data));
    const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
    return { v: 1, nonce: bytesToHex(nonce), ct: bytesToHex(ciphertext) };
  } finally {
    key.fill(0);
  }
}

/** Open a self-sealed envelope. Throws on a wrong key, tampered ciphertext, or account mismatch. */
export function openFromSelf<T>(args: {
  feedSignerPrivKey: string;
  parentAddress: string;
  envelope: SelfSealedEnvelope;
}): T {
  const key = deriveManifestKey(args.feedSignerPrivKey);
  try {
    const aad = aadBytes(args.parentAddress);
    const plaintext = xchacha20poly1305(key, hexToBytes(args.envelope.nonce), aad).decrypt(
      hexToBytes(args.envelope.ct),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } finally {
    key.fill(0);
  }
}
