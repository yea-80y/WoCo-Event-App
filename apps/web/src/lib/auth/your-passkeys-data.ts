/**
 * What "Your passkeys" shows (#746, every passkey a co-owner): one row per passkey
 * on the account. The CHAIN says which passkeys those are (the co-owner list, or
 * this passkey alone while the account has one); the device records the server
 * keeps add when each was added; and only THIS device knows which password manager
 * holds a passkey it made (passkey-meta.ts - never sent anywhere). Loaded with the
 * screen, never at page load.
 */
import { StorageKeys, credentialTagOf, PASSKEY_PROVIDERS, type PasskeyProviderId } from "@woco/shared";
import { getKV } from "./storage/indexeddb.js";
import { credentialIdBytes } from "./passkey-record.js";

export interface PasskeyRow {
  /** The passkey's signing key (its address on the account's list). */
  key: string;
  /** When its device record says it was added; null for the account's first passkey. */
  addedAt: number | null;
  /** Its password manager, when this device made it. */
  provider: PasskeyProviderId | null;
  /** The passkey is in a password manager on this device. */
  onThisDevice: boolean;
  /** The passkey this tab is signed in with. */
  signedInWith: boolean;
  /** Linked by a device record before co-owners: signs in, holds no onchain right. */
  linkedBefore: boolean;
}

export interface PasskeyRows {
  rows: PasskeyRow[];
  /** The account's passkeys are co-owners: only the list opens it. */
  coOwned: boolean;
  /** The server's answer: adding needs an unlocked account. */
  canAdd: boolean;
}

export function providerName(id: PasskeyProviderId | null | undefined): string | null {
  if (!id || id === "other" || id === "unknown") return null;
  return PASSKEY_PROVIDERS[id].name;
}

export function providerWorksOn(id: PasskeyProviderId | null | undefined): string | null {
  if (!id || id === "other" || id === "unknown") return null;
  return PASSKEY_PROVIDERS[id].worksOn;
}

export async function loadPasskeyRows(parent: string, self: string): Promise<PasskeyRows> {
  const me = self.toLowerCase();
  const [{ readCoOwners, readKernelSignerFor }, { listDeviceGrants }, { verifyDeviceGrantList }, { readPasskeyMeta }] = await Promise.all([
    import("./kernel-account.js"),
    import("../api/device-grants.js"),
    import("./device-grant-verify.js"),
    import("./passkey-meta.js"),
  ]);
  const [list, res, meta, pinned] = await Promise.all([
    readCoOwners(parent),
    listDeviceGrants(),
    readPasskeyMeta(parent),
    getKV<{ credentialId?: string; provider?: PasskeyProviderId }>(StorageKeys.PASSKEY_CREDENTIAL),
  ]);
  if (list === "error") throw new Error("Couldn't read your passkeys - check your connection and try again.");
  if (!res.ok || !res.data) throw new Error(res.error ?? "Couldn't read your passkeys - try again.");
  // One passkey: the account's ECDSA owner (on a device linked before co-owners that is
  // NOT this key, so it is read, not assumed).
  let keys: string[];
  if (list !== null) keys = list;
  else {
    const owner = await readKernelSignerFor(parent, me);
    keys = typeof owner === "string" && owner.startsWith("0x") ? [owner] : [me];
  }
  const records = verifyDeviceGrantList(res.data.grants, { parent, signers: keys }).filter((r) => r.removedAt === null);
  const byKey = new Map(records.map((r) => [r.grantee.toLowerCase(), r]));
  const pinnedTag = pinned?.credentialId ? credentialTagOf(credentialIdBytes(pinned.credentialId)).toLowerCase() : null;
  // Devices linked by a record before co-owners: not on the list, still sign in - shown,
  // and removable, so nothing that opens the account is invisible (Fable sign-off SHOULD-4).
  const linkedBefore = records.map((r) => r.grantee.toLowerCase()).filter((g) => !keys.includes(g));

  const rows = [...keys, ...linkedBefore].map((key): PasskeyRow => {
    const k = key.toLowerCase();
    const record = byKey.get(k);
    const tag = record?.credentialTag.toLowerCase() ?? null;
    const local = tag ? meta[tag] : undefined;
    const signedInWith = k === me;
    return {
      key: k,
      addedAt: record ? record.issuedAt * 1000 : null,
      provider: local?.provider ?? (signedInWith ? (pinned?.provider ?? null) : null),
      onThisDevice: signedInWith || local !== undefined || (tag !== null && tag === pinnedTag),
      signedInWith,
      linkedBefore: !keys.includes(k),
    };
  });
  // The passkey you are using first, then this device's others, then the rest, newest last.
  rows.sort((a, b) =>
    a.signedInWith !== b.signedInWith
      ? (a.signedInWith ? -1 : 1)
      : a.onThisDevice !== b.onThisDevice
        ? (a.onThisDevice ? -1 : 1)
        : (a.addedAt ?? 0) - (b.addedAt ?? 0),
  );
  return { rows, coOwned: list !== null, canAdd: res.data.canAddDevices === true };
}
