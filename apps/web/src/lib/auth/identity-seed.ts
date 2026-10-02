import {
  ACCOUNT_KEYS_DOMAIN,
  ACCOUNT_KEYS_TYPES,
  ACCOUNT_KEYS_NONCE,
  ACCOUNT_KEYS_PURPOSE,
  StorageKeys,
  passkeyIdentitySeed,
  passkeySeedKek,
  type EncryptedBlob,
  type EIP712Signer,
} from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import type { SeedUnlockPolicy } from "./seed-unlock-policy.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";

/**
 * Per-account identity-seed storage key. The blob is already AAD-bound to the address,
 * but a SINGLE global slot let a second account on the same device overwrite (and,
 * via the mismatch self-heal, DELETE) the first account's seed — so switching
 * between accounts thrashed each other's data. Keying the slot by the same address
 * lets multiple accounts' seeds coexist untouched. Logout still wipes the active
 * account's slot (see clearIdentitySeed) so shared-device hygiene is unchanged.
 */
function identitySeedKey(address: string): string {
  return `${StorageKeys.IDENTITY_SEED}:${address.toLowerCase()}`;
}

/**
 * Establish the account's identity SEED from the primary wallet — every kind
 * EXCEPT passkey, which roots its seed on the PRF output instead
 * (`establishPasskeyIdentitySeed` below, #642).
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
export async function requestIdentitySeed(
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
        "Your wallet's signature isn't reproducible, so we can't set up your account keys with it. Try a different wallet.",
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
  // stale identity seed left in IndexedDB cannot be decrypted by a different
  // identity on the same browser. See encryption.ts for rationale.
  const deviceKey = await ensureDeviceKey();
  const encSeed = await encrypt(deviceKey, AAD.IDENTITY_SEED(parentAddress), { seed });
  await putKV(identitySeedKey(parentAddress), encSeed);

  return { seed };
}

/**
 * Establish a passkey account's identity SEED from its PRF output (#642). No
 * signature and no dialog: the biometric that produced the PRF output was the
 * consent. The seed never passes through a secp256k1 key, so recovering the
 * Kernel owner key from its public key does not reproduce it. Stored LOCKED under
 * the same PRF output (#746 fix 1), never under the device key.
 *
 * ONLY for a credential that has never been recovered. A recovered credential's
 * account seed came across in escrow and is not this derivation; the caller must
 * refuse when a recovery binding exists for `seedAddress` (the PRF-EOA), exactly as
 * the signature path does.
 */
export async function establishPasskeyIdentitySeed(
  seedAddress: string,
  parent: string,
  prfSecret: string,
): Promise<{ seed: string }> {
  const seed = passkeyIdentitySeed(prfSecret);
  await storeLockedSeed(seedAddress, parent, seed, prfSecret);
  return { seed };
}

// ---------------------------------------------------------------------------
// Passkey seeds at rest, locked under the passkey (#746 fix 1)
// ---------------------------------------------------------------------------
//
// One slot per seed address, AES-GCM under a key derived from the PRF output and
// bound to the seed address AND the account. Every provenance - derived, opened
// from the portability envelope, carried by pairing - is stored here, so unlocking
// is one path whatever the seed's history. The device-key slot above becomes, for a
// passkey account, either a legacy copy waiting to be locked or the silent copy a
// non-default `SEED_UNLOCK_POLICY` asks for.

function lockedSeedKey(seedAddress: string): string {
  return `${StorageKeys.IDENTITY_SEED_LOCKED}:${seedAddress.toLowerCase()}`;
}

function publicKeysKey(seedAddress: string): string {
  return `${StorageKeys.PUBLIC_KEYS}:${seedAddress.toLowerCase()}`;
}

async function importSeedKek(prfSecret: string): Promise<CryptoKey> {
  const derived = passkeySeedKek(prfSecret);
  // A plain ArrayBuffer copy, as encryption.ts does: WebCrypto's types refuse a
  // view that might sit on a SharedArrayBuffer.
  const raw = new Uint8Array(new ArrayBuffer(derived.byteLength));
  raw.set(derived);
  derived.fill(0);
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

export async function storeLockedSeed(
  seedAddress: string,
  parent: string,
  seed: string,
  prfSecret: string,
): Promise<void> {
  const kek = await importSeedKek(prfSecret);
  const blob = await encrypt(kek, AAD.IDENTITY_SEED_LOCKED(seedAddress, parent), { seed });
  await putKV(lockedSeedKey(seedAddress), blob);
}

/** Is a locked copy on this device? No decrypt, no passkey. */
export async function hasLockedSeed(seedAddress: string): Promise<boolean> {
  return (await getKV<EncryptedBlob>(lockedSeedKey(seedAddress))) !== null;
}

/**
 * Open this account's locked seed with the PRF output in hand. Null when there is
 * none for this account. A copy that fails its tag belongs to another account (or
 * was damaged) and is deleted, as `restoreIdentitySeed` self-heals.
 *
 * A legacy device-key copy from before the lock is locked here, the lock is proved
 * to open, and only then is the legacy copy deleted. The other order loses a
 * recovered account's seed whenever its envelope cannot be read.
 */
export async function openLockedSeed(
  seedAddress: string,
  parent: string,
  prfSecret: string,
): Promise<string | null> {
  const kek = await importSeedKek(prfSecret);
  const aad = AAD.IDENTITY_SEED_LOCKED(seedAddress, parent);
  const slot = lockedSeedKey(seedAddress);
  const open = async (blob: EncryptedBlob | null): Promise<string | null> => {
    if (!blob) return null;
    try {
      return (await decrypt<{ seed: string }>(kek, aad, blob)).seed;
    } catch {
      return null;
    }
  };

  const locked = await getKV<EncryptedBlob>(slot);
  if (locked) {
    const seed = await open(locked);
    if (seed) return seed;
    await delKV(slot);
  }

  const legacy = await restoreIdentitySeed(seedAddress);
  if (!legacy) return null;
  await putKV(slot, await encrypt(kek, aad, { seed: legacy }));
  if ((await open(await getKV<EncryptedBlob>(slot))) === legacy) {
    await delKV(identitySeedKey(seedAddress));
  }
  return legacy;
}

/** Delete a passkey account's locked copy - only where the seed is known WRONG
 *  (a heal), never at sign-out. */
export async function clearLockedSeed(seedAddress: string): Promise<void> {
  await delKV(lockedSeedKey(seedAddress));
}

function windowSeedKey(seedAddress: string): string {
  return `${StorageKeys.IDENTITY_SEED_WINDOW}:${seedAddress.toLowerCase()}`;
}

function feedSignerCacheKey(seedAddress: string): string {
  return `${StorageKeys.FEED_SIGNER_CACHE}:${seedAddress.toLowerCase()}`;
}

/**
 * The unlock-window copy (#746): the seed, opening WITHOUT the passkey until its
 * window closes. Anything else found in the slot - expired, dated further out than
 * the policy allows (a shortened window, a clock set back), another account's, or
 * damaged - is deleted: every unlock locks the seed under the passkey first, so this
 * copy is never the only one.
 */
export async function restoreSilentSeed(
  seedAddress: string,
  parent: string,
  policy: SeedUnlockPolicy,
  now = Date.now(),
): Promise<{ seed: string; expiresAt: number } | null> {
  const slot = windowSeedKey(seedAddress);
  const blob = await getKV<EncryptedBlob>(slot);
  if (!blob) return null;
  if (policy.mode === "device-window") {
    try {
      const { seed, expiresAt } = await decrypt<{ seed: string; expiresAt?: unknown }>(
        await ensureDeviceKey(),
        AAD.IDENTITY_SEED_WINDOW(seedAddress, parent),
        blob,
      );
      if (typeof expiresAt === "number" && expiresAt > now && expiresAt <= now + policy.ms) {
        return { seed, expiresAt };
      }
    } catch {
      /* another account's, or damaged */
    }
  }
  await delKV(slot);
  return null;
}

/**
 * After an unlock: write the window copy to close at `expiresAt` (null = keep none),
 * then drop the pre-lock device-key copy. `stillCurrent` is asked just before the
 * write, so an unlock a sign-out overtook leaves nothing behind.
 */
export async function writeUnlockWindow(
  seedAddress: string,
  parent: string,
  seed: string,
  expiresAt: number | null,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  if (expiresAt === null) {
    await delKV(windowSeedKey(seedAddress));
  } else {
    const blob = await encrypt(await ensureDeviceKey(), AAD.IDENTITY_SEED_WINDOW(seedAddress, parent), {
      seed,
      expiresAt,
    });
    if (!stillCurrent()) return;
    await putKV(windowSeedKey(seedAddress), blob);
  }
  await sweepLegacySeed(seedAddress);
}

/** Drop the device-key copy from before the lock - only once the locked copy is on
 *  the device, so a not-yet-migrated legacy copy is never the casualty. */
export async function sweepLegacySeed(seedAddress: string): Promise<void> {
  if (await hasLockedSeed(seedAddress)) await delKV(identitySeedKey(seedAddress));
}

/**
 * The content-feed signer key, kept under the device key with no expiry (#746), so
 * everyday posts never ask for the passkey. An HKDF child of the seed: it opens
 * neither the seed, the attendee-data key nor the issuing key.
 */
export async function storeFeedSignerCache(
  seedAddress: string,
  parent: string,
  signer: { privKey: string; address: string },
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  const blob = await encrypt(await ensureDeviceKey(), AAD.FEED_SIGNER_CACHE(seedAddress, parent), {
    privKey: signer.privKey,
    address: signer.address.toLowerCase(),
  });
  if (!stillCurrent()) return;
  await putKV(feedSignerCacheKey(seedAddress), blob);
}

/** The cached feed signer for exactly this account, else null. Another account's
 *  copy is left for that account: its own next unlock replaces it. */
export async function readFeedSignerCache(
  seedAddress: string,
  parent: string,
): Promise<{ privKey: string; address: string } | null> {
  const blob = await getKV<EncryptedBlob>(feedSignerCacheKey(seedAddress));
  if (!blob) return null;
  try {
    const { privKey, address } = await decrypt<{ privKey?: unknown; address?: unknown }>(
      await ensureDeviceKey(),
      AAD.FEED_SIGNER_CACHE(seedAddress, parent),
      blob,
    );
    if (typeof privKey !== "string" || !/^0x[0-9a-f]{64}$/i.test(privKey)) return null;
    if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/.test(address)) return null;
    return { privKey, address };
  } catch {
    return null;
  }
}

/** Close the window and drop the cached feed signer: at sign-out, a heal, or a
 *  removed device. */
export async function clearDeviceUnlock(seedAddress: string): Promise<void> {
  await delKV(windowSeedKey(seedAddress));
  await delKV(feedSignerCacheKey(seedAddress));
}

/** PUBLIC values from a seed, kept so own-profile reads work while it is locked.
 *  Read back only for the account that wrote them. */
export async function writePublicKeys(
  seedAddress: string,
  record: { parent: string; feedSignerAddress: string },
): Promise<void> {
  await putKV(publicKeysKey(seedAddress), {
    parent: record.parent.toLowerCase(),
    feedSignerAddress: record.feedSignerAddress.toLowerCase(),
  });
}

export async function clearPublicKeys(seedAddress: string): Promise<void> {
  await delKV(publicKeysKey(seedAddress));
}

export async function readPublicFeedSignerAddress(seedAddress: string, parent: string): Promise<string | null> {
  const record = await getKV<{ parent?: unknown; feedSignerAddress?: unknown }>(publicKeysKey(seedAddress));
  if (!record || record.parent !== parent.toLowerCase()) return null;
  return typeof record.feedSignerAddress === "string" ? record.feedSignerAddress : null;
}

/**
 * Restore cached identity seed from IndexedDB.
 * Returns null if no seed is stored, or if the stored seed was encrypted
 * for a different parent address (cross-identity guard via AAD).
 *
 * On AAD mismatch the stale blob is deleted so the next `requestIdentitySeed`
 * cleanly re-derives it — same wallet always yields the same seed, so this
 * is a UX-transparent one-time re-sign for users carrying pre-hardening
 * blobs from before 2026-05-17.
 */
export async function restoreIdentitySeed(parentAddress: string): Promise<string | null> {
  const key = identitySeedKey(parentAddress);
  let encSeed = await getKV<EncryptedBlob>(key);
  // Legacy migration: pre-hardening builds stored ONE global IDENTITY_SEED. If the
  // per-account slot is empty, fall back to the legacy slot; a successful decrypt
  // means it belongs to THIS account, so migrate it and drop the legacy blob.
  let fromLegacy = false;
  if (!encSeed) {
    encSeed = await getKV<EncryptedBlob>(StorageKeys.IDENTITY_SEED);
    if (!encSeed) return null;
    fromLegacy = true;
  }

  const deviceKey = await ensureDeviceKey();
  try {
    const { seed } = await decrypt<{ seed: string }>(
      deviceKey,
      AAD.IDENTITY_SEED(parentAddress),
      encSeed,
    );
    if (fromLegacy) {
      await putKV(key, encSeed); // adopt into this account's per-account slot
      await delKV(StorageKeys.IDENTITY_SEED); // legacy single slot no longer needed
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
 * `requestIdentitySeed` (which derives + stores in one step). After account
 * recovery the original identity seed comes from the decrypted escrow bundle, not a
 * fresh signature, so it must be re-stored under the recovered (new) identity's
 * parent address: the Kernel address is preserved by recovery, but the SEED_ADDRESS
 * AAD key is the new passkey's PRF-EOA, so the blob is bound to that. Same
 * encrypt + AAD + key as `requestIdentitySeed` so `restoreIdentitySeed` reads it back.
 */
export async function storeIdentitySeed(parentAddress: string, seed: string): Promise<void> {
  const deviceKey = await ensureDeviceKey();
  const encSeed = await encrypt(deviceKey, AAD.IDENTITY_SEED(parentAddress), { seed });
  await putKV(identitySeedKey(parentAddress), encSeed);
}

/**
 * Wipe the identity seed. Pass the account's seed address to drop its per-account slot;
 * the legacy single slot is always cleared too (shared-device hygiene — no seed
 * left decryptable at rest after logout). Omitting the address clears only legacy.
 * A passkey account's LOCKED copy is not touched: it opens only with the passkey,
 * so it survives sign-out (`clearLockedSeed` for a heal). Its window copy and cached
 * feed signer go: both open without the passkey.
 */
export async function clearIdentitySeed(address?: string): Promise<void> {
  if (address) {
    await delKV(identitySeedKey(address));
    await delKV(publicKeysKey(address));
    await clearDeviceUnlock(address);
  }
  await delKV(StorageKeys.IDENTITY_SEED);
}
