/**
 * At-rest store for the content-feed signer key. The feed signer is an established
 * secret — NOT a value re-derived each session — so it must be persisted, and persisted exactly
 * like the POD seed: AES-256-GCM under the non-extractable device key, AAD-bound
 * to the account's parent address so a stale blob from a different identity on the
 * same browser cannot be decrypted into this account's signer.
 *
 * Recovery-stability (the whole reason this is a STORE, not a derivation):
 * `CROSS_DEVICE_RECOVERY.md §4` — a passkey credential rotates on guardian
 * recovery, so anything re-derived from it diverges and orphans the user's feeds.
 * Cross-device + post-recovery availability comes from ESCROW + restore of this
 * key (same channel as the POD seed) — wired in the guardian-recovery and
 * PRF-portability paths; this module is the local persistence those paths read and write.
 */

import { StorageKeys } from "@woco/shared";
import type { EncryptedBlob } from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/**
 * Per-account feed-signer storage key. Same rationale as `podSeedKey`: a SINGLE
 * global slot let a second account overwrite (and, via the mismatch self-heal,
 * DELETE) the first account's signer key when switching between accounts. Keying
 * the slot by the parent address lets them coexist. Logout still wipes the active
 * account's slot (see clearContentFeedSigner).
 */
function feedSignerKey(parentAddress: string): string {
  return `${StorageKeys.CONTENT_FEED_SIGNER_KEY}:${parentAddress.toLowerCase()}`;
}

/** Persist the feed-signer private key, AAD-bound to the parent address. */
export async function storeContentFeedSigner(parentAddress: string, privKey: string): Promise<void> {
  const deviceKey = await ensureDeviceKey();
  const blob = await encrypt(deviceKey, AAD.CONTENT_FEED_SIGNER(parentAddress), { privKey });
  await putKV(feedSignerKey(parentAddress), blob);
}

/**
 * Restore the feed-signer private key for `parentAddress`, or null if none is
 * stored or the blob was written for a different identity (AAD mismatch). On
 * mismatch this account's own slot is dropped — same self-healing as `restorePodSeed`.
 * Falls back to (and migrates) the legacy single slot from pre-hardening builds.
 */
export async function restoreContentFeedSigner(parentAddress: string): Promise<string | null> {
  const key = feedSignerKey(parentAddress);
  let blob = await getKV<EncryptedBlob>(key);
  let fromLegacy = false;
  if (!blob) {
    blob = await getKV<EncryptedBlob>(StorageKeys.CONTENT_FEED_SIGNER_KEY);
    if (!blob) return null;
    fromLegacy = true;
  }
  const deviceKey = await ensureDeviceKey();
  try {
    const { privKey } = await decrypt<{ privKey: string }>(
      deviceKey,
      AAD.CONTENT_FEED_SIGNER(parentAddress),
      blob,
    );
    if (fromLegacy) {
      await putKV(key, blob); // adopt into this account's per-account slot
      await delKV(StorageKeys.CONTENT_FEED_SIGNER_KEY); // legacy slot retired
    }
    return privKey;
  } catch {
    // Drop ONLY this account's own slot — never the legacy slot, which may still
    // belong to a DIFFERENT account that will migrate it on its next login.
    if (!fromLegacy) await delKV(key);
    return null;
  }
}

/**
 * Wipe the feed-signer key. Pass the parent address to drop its per-account slot;
 * the legacy single slot is always cleared too (shared-device hygiene). Omitting
 * the address clears only legacy.
 */
export async function clearContentFeedSigner(parentAddress?: string): Promise<void> {
  if (parentAddress) await delKV(feedSignerKey(parentAddress));
  await delKV(StorageKeys.CONTENT_FEED_SIGNER_KEY);
}
