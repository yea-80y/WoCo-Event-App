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

export async function encrypt(
  deviceKey: CryptoKey,
  data: unknown,
): Promise<EncryptedBlob> {
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
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

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    deviceKey,
    ct,
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}
