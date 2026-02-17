import { keccak256, toUtf8Bytes } from "ethers";
import {
  POD_IDENTITY_DOMAIN,
  POD_IDENTITY_TYPES,
  POD_IDENTITY_NONCE,
  StorageKeys,
  type EncryptedBlob,
  type EIP712Signer,
} from "@woco/shared";
import { deriveKeypair } from "../pod/keys.js";
import { ensureDeviceKey, encrypt, decrypt } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/**
 * Request POD identity derivation from the primary wallet.
 *
 * Uses a fixed nonce so the same wallet always produces the same
 * EIP-712 signature → same keccak256 hash → same ed25519 seed.
 * This makes the POD identity deterministic and recoverable on any device.
 */
export async function requestPodIdentity(
  parentAddress: string,
  signTypedData: EIP712Signer,
): Promise<{ podPublicKeyHex: string; seed: string }> {
  // Build deterministic EIP-712 message (fixed nonce!)
  const message = {
    purpose: "Derive deterministic POD signing identity",
    address: parentAddress,
    nonce: POD_IDENTITY_NONCE,
  };

  // Sign via provided signer (web3 wallet or local account)
  const signature = await signTypedData(
    { ...POD_IDENTITY_DOMAIN },
    POD_IDENTITY_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    message as unknown as Record<string, unknown>,
  );

  // Deterministic: same wallet → same signature → same seed
  const seed = keccak256(toUtf8Bytes(signature));

  // Derive keypair to get public key
  const keypair = await deriveKeypair(seed);

  // Encrypt and store seed
  const deviceKey = await ensureDeviceKey();
  const encSeed = await encrypt(deviceKey, { seed });
  await putKV(StorageKeys.POD_SEED, encSeed);

  return { podPublicKeyHex: keypair.publicKeyHex, seed };
}

/**
 * Restore cached POD seed from IndexedDB.
 * Returns null if no seed is stored (user hasn't done POD derivation on this device).
 */
export async function restorePodSeed(): Promise<string | null> {
  const encSeed = await getKV<EncryptedBlob>(StorageKeys.POD_SEED);
  if (!encSeed) return null;

  const deviceKey = await ensureDeviceKey();
  const { seed } = await decrypt<{ seed: string }>(deviceKey, encSeed);
  return seed;
}

/**
 * Get the POD keypair, deriving from stored seed.
 * Returns null if no seed is stored.
 */
export async function getPodKeypair(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} | null> {
  const seed = await restorePodSeed();
  if (!seed) return null;
  return deriveKeypair(seed);
}

export async function clearPodIdentity(): Promise<void> {
  await delKV(StorageKeys.POD_SEED);
}
