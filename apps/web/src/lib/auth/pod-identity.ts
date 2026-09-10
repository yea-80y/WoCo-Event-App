import {
  ACCOUNT_KEYS_DOMAIN,
  ACCOUNT_KEYS_TYPES,
  ACCOUNT_KEYS_NONCE,
  ACCOUNT_KEYS_PURPOSE,
  StorageKeys,
  type EncryptedBlob,
  type EIP712Signer,
} from "@woco/shared";
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
 * Establish the account's identity SEED from the primary wallet.
 *
 * Uses a fixed nonce so the same wallet always produces the same EIP-712
 * signature → same keccak256 hash → same seed, on any device.
 *
 * The seed is the ROOT, not an account: it is the HKDF input for the X25519
 * encryption key (`crypto/keys.ts`), the secp256k1 issuing key
 * (`crypto/issuing.ts`) and the content-feed signer (`crypto/feed-signer.ts`).
 * The ed25519 holder key it used to derive here is gone from every launch path
 * (#518) — the credit and cert-challenge rails derive their own from this same
 * seed, lazily, when they are reachable at all.
 *
 * DETERMINISM IS THE WHOLE MECHANISM, and for one class of signer it has to be
 * CHECKED rather than assumed. Our own signers go through ethers (RFC-6979) and
 * are deterministic by construction. An external wallet's nonce generation is not
 * ours, and a wallet that signs differently twice would give this user a
 * different seed on their next device — a different encryption key (their sealed
 * history stops opening), a different issuer address, and a different content-feed
 * signer (every chunk they own becomes unreachable). None of that announces
 * itself, and none of it is recoverable, so `verifyDeterminism` signs TWICE and
 * throws at setup instead. Nothing falls back to a platform key as a consolation:
 * a different signer is a different owner, not a degraded one.
 */
export async function requestPodIdentity(
  parentAddress: string,
  signTypedData: EIP712Signer,
  opts: {
    /** Sign twice and refuse a wallet that disagrees with itself. Set for
     *  EXTERNAL-wallet kinds only; raw-key kinds are deterministic already and a
     *  second prompt would be pure friction. */
    verifyDeterminism?: boolean;
  } = {},
): Promise<{ seed: string }> {
  // Build deterministic EIP-712 message (fixed nonce!)
  // Every field is FROZEN signed input — see ACCOUNT_KEYS_DOMAIN. The purpose
  // string is imported rather than written here so it cannot be "improved".
  const message = {
    purpose: ACCOUNT_KEYS_PURPOSE,
    address: parentAddress,
    nonce: ACCOUNT_KEYS_NONCE,
  };

  // Sign via provided signer (web3 wallet or local account)
  const sign = () =>
    signTypedData(
      { ...ACCOUNT_KEYS_DOMAIN },
      ACCOUNT_KEYS_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      message as unknown as Record<string, unknown>,
    );
  const signature = await sign();
  if (opts.verifyDeterminism) {
    // Compared on the SIGNATURE bytes, before anything is derived or stored: a
    // wallet that disagrees with itself must not leave a seed behind for the next
    // session to find and treat as established.
    if ((await sign()) !== signature) {
      throw new Error(
        "Your wallet's signature isn't reproducible, so we can't create a recoverable feed for your content. Try a different wallet.",
      );
    }
  }

  // Deterministic: same wallet → same signature → same seed.
  // ethers imported lazily — this module is in auth-store's boot graph.
  // Use getBytes(signature) to hash the canonical signature bytes (65 bytes),
  // not toUtf8Bytes(signature) which hashes the hex string representation
  // (132 bytes of ASCII). The byte form is the standard way to compress an
  // ECDSA signature into a uniform-distribution seed and is what every other
  // library in the ecosystem does. FROZEN: every key the account owns hangs off
  // these exact bytes.
  const { keccak256, getBytes } = await import("ethers");
  const seed = keccak256(getBytes(signature));

  // Encrypt and store seed — AAD binds the blob to the parent address so a
  // stale POD seed left in IndexedDB cannot be decrypted by a different
  // identity on the same browser. See encryption.ts for rationale.
  const deviceKey = await ensureDeviceKey();
  const encSeed = await encrypt(deviceKey, AAD.POD_SEED(parentAddress), { seed });
  await putKV(podSeedKey(parentAddress), encSeed);

  return { seed };
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
 * Persist an identity seed under a parent address — the recovery-path counterpart of
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
