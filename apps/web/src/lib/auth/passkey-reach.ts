/**
 * Where the passkey this device just made works (#746) - read from the provider
 * kept beside the credential on THIS device only. `null` when the provider is not
 * known, or when it reaches laptops anyway (no note needed). Loaded only after a
 * new account is made, never with the sign-in sheet.
 */
import { StorageKeys, PASSKEY_PROVIDERS, type PasskeyProviderId } from "@woco/shared";
import { getKV } from "./storage/indexeddb.js";

export async function stayingPasskeyNote(): Promise<{ name: string; worksOn: string } | null> {
  const pinned = await getKV<{ provider?: PasskeyProviderId }>(StorageKeys.PASSKEY_CREDENTIAL).catch(() => null);
  const id = pinned?.provider;
  if (!id || id === "other" || id === "unknown") return null;
  const p = PASSKEY_PROVIDERS[id];
  return p.travels ? null : { name: p.name, worksOn: p.worksOn };
}
