import { keccak256, getBytes } from "ethers";
import {
  POD_IDENTITY_DOMAIN,
  POD_IDENTITY_TYPES,
  POD_IDENTITY_NONCE,
  StorageKeys,
  type EncryptedBlob,
  type EIP712Signer,
} from "@woco/shared";
import { deriveKeypair } from "../pod/keys.js";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/**
 * Per-account POD-seed storage key. The blob is already AAD-bound to the address,
 * but a SINGLE global slot let a second account on the same device overwrite (and,
 * via the mismatch self-heal, DELETE) the first account's seed — so switching
 * between accounts thrashed each other's data. Keying the slot by the same address
 * lets multiple accounts' seeds coexist untouched. Logout still wipes the active
 * account's slot (see clearPodIdentity) so shared-device hygiene is unchanged.
 */
function podSeedKey(address: string): string {
  return `${StorageKeys.POD_SEED}:${address.toLowerCase()}`;
}

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

  // Deterministic: same wallet → same signature → same seed.
  // Use getBytes(signature) to hash the canonical signature bytes (65 bytes),
  // not toUtf8Bytes(signature) which hashes the hex string representation
  // (132 bytes of ASCII). The byte form is the standard way to compress an
  // ECDSA signature into a uniform-distribution seed and is what every other
  // library in the ecosystem does. BREAKING (2026-04-09): changes the derived
  // ed25519 keypair for any user who previously called this function.
  const seed = keccak256(getBytes(signature));

  // Derive keypair to get public key
  const keypair = await deriveKeypair(seed);

  // Encrypt and store seed — AAD binds the blob to the parent address so a
  // stale POD seed left in IndexedDB cannot be decrypted by a different
  // identity on the same browser. See encryption.ts for rationale.
  const deviceKey = await ensureDeviceKey();
  const encSeed = await encrypt(deviceKey, AAD.POD_SEED(parentAddress), { seed });
  await putKV(podSeedKey(parentAddress), encSeed);

  return { podPublicKeyHex: keypair.publicKeyHex, seed };
}

/**
 * Restore cached POD seed from IndexedDB.
 * Returns null if no seed is stored, or if the stored seed was encrypted
 * for a different parent address (cross-identity guard via AAD).
 *
 * On AAD mismatch the stale blob is deleted so the next `requestPodIdentity`
 * cleanly re-derives it — same wallet always yields the same seed, so this
 * is a UX-transparent one-time re-sign for users carrying pre-hardening
 * blobs from before 2026-05-17.
 */
export async function restorePodSeed(parentAddress: string): Promise<string | null> {
  const key = podSeedKey(parentAddress);
  let encSeed = await getKV<EncryptedBlob>(key);
  // Legacy migration: pre-hardening builds stored ONE global POD_SEED. If the
  // per-account slot is empty, fall back to the legacy slot; a successful decrypt
  // means it belongs to THIS account, so migrate it and drop the legacy blob.
  let fromLegacy = false;
  if (!encSeed) {
    encSeed = await getKV<EncryptedBlob>(StorageKeys.POD_SEED);
    if (!encSeed) return null;
    fromLegacy = true;
  }

  const deviceKey = await ensureDeviceKey();
  try {
    const { seed } = await decrypt<{ seed: string }>(
      deviceKey,
      AAD.POD_SEED(parentAddress),
      encSeed,
    );
    if (fromLegacy) {
      await putKV(key, encSeed); // adopt into this account's per-account slot
      await delKV(StorageKeys.POD_SEED); // legacy single slot no longer needed
    }
    return seed;
  } catch {
    // AES-GCM auth tag failure (wrong AAD or tampered ciphertext). Drop ONLY this
    // account's own slot — never the legacy slot, which may still belong to a
    // DIFFERENT account that will migrate it on its next login.
    if (!fromLegacy) await delKV(key);
    return null;
  }
}

/**
 * Get the POD keypair, deriving from stored seed.
 * Returns null if no seed is stored.
 */
export async function getPodKeypair(parentAddress: string): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
} | null> {
  const seed = await restorePodSeed(parentAddress);
  if (!seed) return null;
  return deriveKeypair(seed);
}

/**
 * Persist a POD seed under a parent address — the recovery-path counterpart of
 * `requestPodIdentity` (which derives + stores in one step). After account
 * recovery the original POD seed comes from the decrypted escrow bundle, not a
 * fresh signature, so it must be re-stored under the recovered (new) identity's
 * parent address: the Kernel address is preserved by recovery, but the POD_ADDRESS
 * AAD key is the new passkey's PRF-EOA, so the blob is bound to that. Same
 * encrypt + AAD + key as `requestPodIdentity` so `restorePodSeed` reads it back.
 */
export async function storePodSeed(parentAddress: string, seed: string): Promise<void> {
  const deviceKey = await ensureDeviceKey();
  const encSeed = await encrypt(deviceKey, AAD.POD_SEED(parentAddress), { seed });
  await putKV(podSeedKey(parentAddress), encSeed);
}

/**
 * Wipe the POD seed. Pass the account's POD address to drop its per-account slot;
 * the legacy single slot is always cleared too (shared-device hygiene — no seed
 * left decryptable at rest after logout). Omitting the address clears only legacy.
 */
export async function clearPodIdentity(address?: string): Promise<void> {
  if (address) await delKV(podSeedKey(address));
  await delKV(StorageKeys.POD_SEED);
}
