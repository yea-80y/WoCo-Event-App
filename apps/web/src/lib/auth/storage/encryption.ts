import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { EncryptedBlob } from "@woco/shared";
import { StorageKeys } from "@woco/shared";
import { getKV, putKV } from "./indexeddb.js";

/**
 * Get or create a non-extractable AES-256-GCM key bound to this device.
 * IndexedDB stores CryptoKey objects natively - the raw key material
 * never leaves the Web Crypto API.
 */
export async function ensureDeviceKey(): Promise<CryptoKey> {
  const existing = await getKV<CryptoKey>(StorageKeys.DEVICE_KEY);
  if (existing) return existing;

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  await putKV(StorageKeys.DEVICE_KEY, key);
  return key;
}

/**
 * Context strings used as AES-GCM Additional Authenticated Data (AAD).
 *
 * Two layers of binding:
 *   1. SLOT KIND — prevents cross-slot blob substitution (e.g. swap a
 *      delegation blob into another slot).
 *   2. PARENT ADDRESS — for identity-scoped slots (identity seed, session key,
 *      session delegation) the AAD also commits to the wallet address that
 *      wrote the blob. Decryption fails cryptographically when the active
 *      parent differs from the writer — so a stale blob left in IndexedDB
 *      (e.g. by a bug in clear-on-logout / clear-on-switch) cannot be
 *      silently re-used by a different identity on the same browser. AAD
 *      is authenticated but NOT encrypted.
 *
 * Address is lowercased so casing variation cannot lock a user out.
 */
export const AAD = {
  SESSION_KEY: (parent: string) =>
    `woco/device/session-key/v1:${parent.toLowerCase()}`,
  SESSION_DELEGATION: (parent: string) =>
    `woco/device/session-delegation/v1:${parent.toLowerCase()}`,
  IDENTITY_SEED: (parent: string) =>
    `woco/device/pod-seed/v1:${parent.toLowerCase()}`,
  // ZeroDev scoped EAS session key, bound to the Kernel (smart-account) address
  // that owns it. A serialized permission account written under one Kernel
  // cannot be decrypted by a different Kernel on the same device. (The sub-ENS
  // mint key had its own AAD beside this one until #501 deleted that rail; its
  // stored blobs are now only ever DELETED, which needs no AAD.)
  WOCO_AA_EAS_SESSION: (kernel: string) =>
    `woco/device/aa-eas-session/v1:${kernel.toLowerCase()}`,
  // A CONTENT_FEED_SIGNER entry sat here while the feed signer was stored as its
  // own secret. The signer is derived from the seed now, so nothing is encrypted
  // under that label — and an unused AAD constructor is worse than none, because
  // the next person to need one is invited to reuse it for something it was never
  // bound to. Its stale blobs are only ever DELETED, which needs no AAD.
} as const;

/** Any string is accepted at the encrypt/decrypt boundary; AAD constructors
 *  above produce well-formed values. Loose typing keeps the encryption
 *  primitive reusable. */
export type EncryptionContext = string;

export async function encrypt(
  deviceKey: CryptoKey,
  context: EncryptionContext,
  data: unknown,
): Promise<EncryptedBlob> {
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(context);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    deviceKey,
    plaintext,
  );

  return {
    iv: bytesToHex(iv),
    ct: bytesToHex(new Uint8Array(ciphertext)),
  };
}

export async function decrypt<T = unknown>(
  deviceKey: CryptoKey,
  context: EncryptionContext,
  blob: EncryptedBlob,
): Promise<T> {
  const ivBytes = hexToBytes(blob.iv);
  const ctBytes = hexToBytes(blob.ct);

  // Copy into plain ArrayBuffer — hexToBytes returns Uint8Array<ArrayBufferLike>
  // but Web Crypto requires ArrayBuffer (not SharedArrayBuffer).
  const iv = new ArrayBuffer(ivBytes.byteLength);
  new Uint8Array(iv).set(ivBytes);
  const ct = new ArrayBuffer(ctBytes.byteLength);
  new Uint8Array(ct).set(ctBytes);
  const additionalData = new TextEncoder().encode(context);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData },
    deviceKey,
    ct,
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}
