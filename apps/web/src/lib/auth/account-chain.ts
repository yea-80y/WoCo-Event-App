/**
 * A passkey account's LATER account secrets on this device (#186).
 *
 * Generation 0 is the identity seed (`identity-seed.ts`). Each passkey removal moves
 * the account to a new random secret, handed to the remaining passkeys through the
 * account's key ring; this device keeps what it opened - generations 1..g - so it can
 * sign under the current one and open orders sealed under any. Stored like the seed:
 * locked under the passkey (the same PRF-derived key, its own AAD) and, while an
 * unlock window is open, a device-key copy that closes with it.
 *
 *   chain = { ringRef, gen, secrets: [S_1 .. S_gen] }   ("" = a generation never opened)
 *
 * A chain at gen 0 holds no secrets: the account has a ring (its first passkey was
 * added) but no removal yet, and the ring is remembered so it is not fetched again.
 *
 * `ringRef` is the ring it came from, so a device can tell when the anchor moved on.
 * `gen` only ever rises here: an older ring is never adopted over a newer one.
 */
import { StorageKeys, type EncryptedBlob } from "@woco/shared";
import { ensureDeviceKey, encrypt, decrypt, AAD } from "./storage/encryption.js";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";
import { importSeedKek } from "./identity-seed.js";
import type { SeedUnlockPolicy } from "./seed-unlock-policy.js";

export interface AccountChain {
  ringRef: string;
  gen: number;
  /** S_1..S_gen, 0x-hex; "" where this device never had that generation. */
  secrets: string[];
}

const REF = /^[0-9a-f]{64}$/;
const SECRET = /^0x[0-9a-f]{64}$/;

/** A chain from storage, or null for anything malformed (never trusted half-read). */
export function parseAccountChain(x: unknown): AccountChain | null {
  if (typeof x !== "object" || x === null) return null;
  const { ringRef, gen, secrets } = x as Record<string, unknown>;
  if (typeof ringRef !== "string" || !REF.test(ringRef)) return null;
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0) return null;
  if (!Array.isArray(secrets) || secrets.length !== gen) return null;
  if (!secrets.every((s) => s === "" || (typeof s === "string" && SECRET.test(s)))) return null;
  if (gen > 0 && secrets[gen - 1] === "") return null;
  return { ringRef, gen, secrets: secrets as string[] };
}

/** The current generation's secret. */
export function currentSecretOf(seed: string, chain: AccountChain | null): string {
  return chain && chain.gen > 0 ? chain.secrets[chain.gen - 1]! : seed;
}

/** Every secret this device has, generation 0 first; holes left out. */
export function allSecretsOf(seed: string, chain: AccountChain | null): string[] {
  return [seed, ...(chain?.secrets.filter((s) => s !== "") ?? [])];
}

const lockedKey = (seedAddress: string) => `${StorageKeys.ACCOUNT_CHAIN_LOCKED}:${seedAddress.toLowerCase()}`;
const windowKey = (seedAddress: string) => `${StorageKeys.ACCOUNT_CHAIN_WINDOW}:${seedAddress.toLowerCase()}`;

export async function storeLockedChain(seedAddress: string, parent: string, chain: AccountChain, prfSecret: string): Promise<void> {
  const kek = await importSeedKek(prfSecret);
  await putKV(lockedKey(seedAddress), await encrypt(kek, AAD.ACCOUNT_CHAIN_LOCKED(seedAddress, parent), chain));
}

/** This account's locked chain, or null when there is none (generation 0) or it is not this account's. */
export async function openLockedChain(seedAddress: string, parent: string, prfSecret: string): Promise<AccountChain | null> {
  const blob = await getKV<EncryptedBlob>(lockedKey(seedAddress));
  if (!blob) return null;
  try {
    return parseAccountChain(await decrypt(await importSeedKek(prfSecret), AAD.ACCOUNT_CHAIN_LOCKED(seedAddress, parent), blob));
  } catch {
    // Another account reachable from this credential: its chain is left for it.
    return null;
  }
}

/** The window copy, written beside the seed's and closing with it. Null chain = none. */
export async function writeChainWindow(
  seedAddress: string,
  parent: string,
  chain: AccountChain | null,
  expiresAt: number | null,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  if (!chain || expiresAt === null) {
    await delKV(windowKey(seedAddress));
    return;
  }
  const blob = await encrypt(await ensureDeviceKey(), AAD.ACCOUNT_CHAIN_WINDOW(seedAddress, parent), { chain, expiresAt });
  if (!stillCurrent()) return;
  await putKV(windowKey(seedAddress), blob);
}

/** The window copy while it is open, else null (and anything stale or foreign is dropped). */
export async function restoreChainWindow(
  seedAddress: string,
  parent: string,
  policy: SeedUnlockPolicy,
  now = Date.now(),
): Promise<AccountChain | null> {
  const blob = await getKV<EncryptedBlob>(windowKey(seedAddress));
  if (!blob) return null;
  if (policy.mode === "device-window") {
    try {
      const { chain, expiresAt } = await decrypt<{ chain?: unknown; expiresAt?: unknown }>(
        await ensureDeviceKey(),
        AAD.ACCOUNT_CHAIN_WINDOW(seedAddress, parent),
        blob,
      );
      const parsed = parseAccountChain(chain);
      if (parsed && typeof expiresAt === "number" && expiresAt > now && expiresAt <= now + policy.ms) return parsed;
    } catch {
      /* another account's, or damaged */
    }
  }
  await delKV(windowKey(seedAddress));
  return null;
}

/** Close the chain's window copy: at sign-out, a heal or a removed device. */
export async function clearChainWindow(seedAddress: string): Promise<void> {
  await delKV(windowKey(seedAddress));
}

/** Delete this account's locked chain - only where it is known wrong (a heal), never at sign-out. */
export async function clearLockedChain(seedAddress: string): Promise<void> {
  await delKV(lockedKey(seedAddress));
}
