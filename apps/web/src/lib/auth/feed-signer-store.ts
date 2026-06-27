/**
 * At-rest store for the INDEPENDENT content-feed signer key (Phase B /
 * FEED_SIGNER_ESCROW_HANDOVER). The feed signer is an established secret — NOT a
 * value re-derived each session — so it must be persisted, and persisted exactly
 * like the POD seed: AES-256-GCM under the non-extractable device key, AAD-bound
 * to the account's parent address so a stale blob from a different identity on the
 * same browser cannot be decrypted into this account's signer.
 *
 * Recovery-stability (the whole reason this is a STORE, not a derivation):
 * `CROSS_DEVICE_RECOVERY.md §4` — a passkey credential rotates on guardian
 * recovery, so anything re-derived from it diverges and orphans the user's feeds.
 * Cross-device + post-recovery availability comes from ESCROW + restore of this
 * key (same channel as the POD seed), wired in the later steps; this module is the
 * local persistence those paths read and write.
 */

import { StorageKeys } from "@woco/shared";
import type { EncryptedBlob } from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/** Persist the feed-signer private key, AAD-bound to the parent address. */
export async function storeContentFeedSigner(parentAddress: string, privKey: string): Promise<void> {
  const deviceKey = await ensureDeviceKey();
  const blob = await encrypt(deviceKey, AAD.CONTENT_FEED_SIGNER(parentAddress), { privKey });
  await putKV(StorageKeys.CONTENT_FEED_SIGNER_KEY, blob);
}

/**
 * Restore the feed-signer private key for `parentAddress`, or null if none is
 * stored or the blob was written for a different identity (AAD mismatch). On
 * mismatch the stale blob is dropped — same self-healing as `restorePodSeed`.
 */
export async function restoreContentFeedSigner(parentAddress: string): Promise<string | null> {
  const blob = await getKV<EncryptedBlob>(StorageKeys.CONTENT_FEED_SIGNER_KEY);
  if (!blob) return null;
  const deviceKey = await ensureDeviceKey();
  try {
    const { privKey } = await decrypt<{ privKey: string }>(
      deviceKey,
      AAD.CONTENT_FEED_SIGNER(parentAddress),
      blob,
    );
    return privKey;
  } catch {
    await delKV(StorageKeys.CONTENT_FEED_SIGNER_KEY);
    return null;
  }
}

export async function clearContentFeedSigner(): Promise<void> {
  await delKV(StorageKeys.CONTENT_FEED_SIGNER_KEY);
}
