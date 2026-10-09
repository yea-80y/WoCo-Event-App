/**
 * A removal under way on this device (#186): its new secret and progress, locked under
 * the passkey like the account's chain (its own AAD), so a closed tab resumes with the
 * SAME secret. Only a removal or its resume reads this - it stays out of the page load.
 */
import { StorageKeys, type EncryptedBlob } from "@woco/shared";
import { encrypt, decrypt, AAD } from "../auth/storage/encryption.js";
import { getKV, putKV, delKV } from "../auth/storage/indexeddb.js";
import { importSeedKek } from "../auth/identity-seed.js";

const pendingKey = (seedAddress: string) => `${StorageKeys.PENDING_ROTATION}:${seedAddress.toLowerCase()}`;

export async function storePendingRotation(seedAddress: string, parent: string, pending: unknown, prfSecret: string): Promise<void> {
  const kek = await importSeedKek(prfSecret);
  await putKV(pendingKey(seedAddress), await encrypt(kek, AAD.PENDING_ROTATION(seedAddress, parent), pending));
}

/** The pending removal for this account, opened with the passkey; null when none (or another account's). */
export async function openPendingRotation(seedAddress: string, parent: string, prfSecret: string): Promise<unknown | null> {
  const blob = await getKV<EncryptedBlob>(pendingKey(seedAddress));
  if (!blob) return null;
  try {
    return await decrypt(await importSeedKek(prfSecret), AAD.PENDING_ROTATION(seedAddress, parent), blob);
  } catch {
    return null;
  }
}

/** Is a removal under way on this device? No decrypt. */
export async function hasPendingRotation(seedAddress: string): Promise<boolean> {
  return (await getKV<EncryptedBlob>(pendingKey(seedAddress))) !== null;
}

export async function clearPendingRotation(seedAddress: string): Promise<void> {
  await delKV(pendingKey(seedAddress));
}

