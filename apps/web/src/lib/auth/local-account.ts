import { Wallet } from "ethers";
import { StorageKeys, type EncryptedBlob } from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/**
 * Create a new local browser account.
 * Generates a random secp256k1 keypair, encrypts the private key with
 * the device key, and stores it in IndexedDB.
 */
export async function createLocalAccount(): Promise<{
  address: string;
  privateKey: string;
}> {
  const wallet = Wallet.createRandom();
  const address = wallet.address.toLowerCase();
  const privateKey = wallet.privateKey;

  const deviceKey = await ensureDeviceKey();
  const encKey = await encrypt(deviceKey, { privateKey, address });
  await putKV(StorageKeys.LOCAL_KEY, encKey);

  return { address, privateKey };
}

/**
 * Restore an existing local account from IndexedDB.
 * Returns null if no local account exists.
 */
export async function restoreLocalAccount(): Promise<{
  address: string;
  privateKey: string;
} | null> {
  const encKey = await getKV<EncryptedBlob>(StorageKeys.LOCAL_KEY);
  if (!encKey) return null;

  const deviceKey = await ensureDeviceKey();
  const { privateKey, address } = await decrypt<{
    privateKey: string;
    address: string;
  }>(deviceKey, encKey);

  return { address, privateKey };
}

/**
 * Delete the local account from IndexedDB.
 */
export async function clearLocalAccount(): Promise<void> {
  await delKV(StorageKeys.LOCAL_KEY);
}
