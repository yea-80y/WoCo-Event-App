import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
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
 * Binding each ciphertext to a distinct context prevents an attacker who
 * has IndexedDB write access from swapping blobs across slots — e.g.
 * decrypting a delegation blob as a raw local-account key and tricking
 * the wallet code into signing with the wrong material. The AAD is
 * authenticated but NOT encrypted; mismatched context → decrypt throws.
 */
export const AAD = {
  LOCAL_ACCOUNT: "woco/device/local-account/v1",
  SESSION_KEY: "woco/device/session-key/v1",
  SESSION_DELEGATION: "woco/device/session-delegation/v1",
  POD_SEED: "woco/device/pod-seed/v1",
} as const;

export type EncryptionContext = typeof AAD[keyof typeof AAD];

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
