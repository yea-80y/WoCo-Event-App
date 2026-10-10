/**
 * Device-grant registry (#746 step 2) - `.data/device-grants.json`.
 *
 * Holds signed statements only (`packages/shared/src/auth/device-grant.ts`): a
 * grant the account's owner signed, and the removal its owner or the device
 * itself signed. The rules are the ones a contract would apply - signature, owner
 * check, one-use nonce per account, at most MAX_DEVICE_GRANTS live under the
 * current owner, times taken on receipt like a block timestamp - and the owner
 * check is injected. Moving the list onchain is replacing this module behind
 * `lookupDeviceGrant`, with the stored statements as its input (device-grant.ts
 * says when their signatures carry over as they are).
 *
 * MUST SURVIVE RESTARTS. Losing it signs every added device out (each needs a new
 * grant from the main passkey); nothing leaks and nothing is granted. A file that
 * exists and cannot be read is never overwritten: no grant is served, every write
 * is refused, and `/api/health` `deviceGrants` alarms until it is restored.
 *
 * Growth: one record per device ever added and one nonce per statement, per
 * account - bounded by the route's per-account rate limit, never pruned (a nonce
 * forgotten is a removal that can be replayed away).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyTypedData, type TypedDataField } from "ethers";
import {
  DEVICE_GRANT_DOMAIN,
  DEVICE_GRANT_TYPES,
  DEVICE_GRANT_REVOKE_TYPES,
  MAX_DEVICE_GRANTS,
  parseDeviceGrant,
  parseDeviceGrantRevoke,
  type DeviceGrantMessage,
  type DeviceGrantRevokeMessage,
} from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";

const FILE = join(process.cwd(), ".data", "device-grants.json");
const SIG = /^0x[0-9a-fA-F]{130}$/;

export interface DeviceGrantRecord {
  grant: DeviceGrantMessage;
  grantSig: string;
  /** The owner key that signed the grant, lowercase. The grant lives only while
   *  this key is still the account's owner. */
  signer: string;
  registeredAt: number;
  revoke?: DeviceGrantRevokeMessage;
  revokeSig?: string;
  revokedBy?: string;
  revokedAt?: number;
  /** Sessions this device signed at or before this instant are refused: the last
   *  removal of an earlier grant to the same key, carried forward so adding a
   *  device back does not revive what it held before it was removed. */
  notBefore?: number;
}

interface AccountEntry {
  nonces: string[];
  grants: Record<string, DeviceGrantRecord>;
}

interface FileShape {
  version: 1;
  accounts: Record<string, AccountEntry>;
}

/** What the session verifier needs - and all an onchain registry would return. */
export interface DeviceGrantState {
  signer: string;
  active: boolean;
  notBefore?: number;
}

export type DeviceGrantRefusal =
  | "malformed"
  | "bad-signature"
  | "wrong-account"
  | "not-owner"
  | "nonce-used"
  | "cap-reached"
  | "not-found"
  | "not-allowed"
  | "store-unavailable";

/** `changed` is false only for a removal that was already in place. */
export type DeviceGrantResult =
  | { ok: true; record: DeviceGrantRecord; changed: boolean }
  | { ok: false; refusal: DeviceGrantRefusal };

/** May `signer` sign for `parent` right now - its owner, or one of its co-owners
 *  (#746)? Production: `isAccountSigner` under the
 *  caller's read budget. */
export type OwnerCheck = (signer: string, parent: string) => Promise<boolean>;

let state: FileShape = { version: 1, accounts: {} };
const nonceSets = new Map<string, Set<string>>();
let fileUnreadable: string | null = null;
let loaded = false;

function refuseFile(why: string): void {
  fileUnreadable = why;
  console.error(
    `[device-grants] ALARM: device-grants.json ${why} - no added device can sign in and no grant can be ` +
      "added or removed until it is restored and the server restarted (/api/health deviceGrants)",
  );
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return;
    return refuseFile(`exists but could not be read (${code ?? "unknown error"})`);
  }
  let obj: FileShape;
  try {
    obj = JSON.parse(raw) as FileShape;
  } catch {
    return refuseFile("is not valid JSON");
  }
  // Whole-file refusal on any bad shape: a half-understood grant list is worse
  // than none, and losing it entirely is the documented, recoverable failure.
  if (obj?.version !== 1 || !obj.accounts || typeof obj.accounts !== "object") {
    return refuseFile("is not a version-1 grant list");
  }
  for (const [parent, entry] of Object.entries(obj.accounts)) {
    if (!Array.isArray(entry?.nonces) || !entry.grants || typeof entry.grants !== "object") {
      return refuseFile(`has an unreadable entry for ${parent.slice(0, 10)}…`);
    }
    for (const r of Object.values(entry.grants)) {
      if (!parseDeviceGrant(r?.grant) || typeof r.signer !== "string" || typeof r.registeredAt !== "number") {
        return refuseFile(`has an unreadable grant under ${parent.slice(0, 10)}…`);
      }
    }
  }
  state = obj;
  for (const [parent, entry] of Object.entries(state.accounts)) nonceSets.set(parent, new Set(entry.nonces));
}

function account(parent: string): AccountEntry {
  let entry = state.accounts[parent];
  if (!entry) {
    entry = { nonces: [], grants: {} };
    state.accounts[parent] = entry;
    nonceSets.set(parent, new Set());
  }
  return entry;
}

function nonceUsed(parent: string, nonce: string): boolean {
  return nonceSets.get(parent)?.has(nonce) ?? false;
}

function persist(): boolean {
  return writeJsonAtomic(FILE, state, "device-grants");
}

function recoverSigner(
  types: Record<string, readonly { name: string; type: string }[]>,
  message: object,
  sig: unknown,
): string | null {
  if (typeof sig !== "string" || !SIG.test(sig)) return null;
  try {
    return verifyTypedData(
      DEVICE_GRANT_DOMAIN,
      types as unknown as Record<string, TypedDataField[]>,
      message,
      sig,
    ).toLowerCase();
  } catch {
    return null;
  }
}

/** The grant naming `grantee` on `parent`, live or removed. Never throws; an
 *  unreadable file is never loaded, so it answers "no grant" (fail closed). */
export function lookupDeviceGrant(parent: string, grantee: string): DeviceGrantState | undefined {
  ensureLoaded();
  const r = state.accounts[parent.toLowerCase()]?.grants[grantee.toLowerCase()];
  if (!r) return undefined;
  return { signer: r.signer, active: r.revokedAt === undefined, notBefore: r.notBefore };
}

export function listDeviceGrants(parent: string): DeviceGrantRecord[] | null {
  ensureLoaded();
  if (fileUnreadable) return null;
  return Object.values(state.accounts[parent.toLowerCase()]?.grants ?? {});
}

/**
 * Register an owner-signed grant for `account` (the verified session parent).
 *
 * Every check on stored state runs after the owner read, the only await, so two
 * concurrent submissions cannot both pass it.
 *
 * Re-granting a key that already has a record replaces it - the path after an
 * owner rotation, when the new owner keeps the other devices - and carries the
 * last removal forward as `notBefore`.
 */
export async function submitDeviceGrant(
  accountAddress: string,
  body: { grant?: unknown; grantSig?: unknown },
  isOwner: OwnerCheck,
  now = Date.now(),
): Promise<DeviceGrantResult> {
  ensureLoaded();
  if (fileUnreadable) return { ok: false, refusal: "store-unavailable" };
  const grant = parseDeviceGrant(body.grant);
  if (!grant) return { ok: false, refusal: "malformed" };
  if (grant.parent !== accountAddress.toLowerCase()) return { ok: false, refusal: "wrong-account" };
  const signer = recoverSigner(DEVICE_GRANT_TYPES, grant, body.grantSig);
  if (!signer) return { ok: false, refusal: "bad-signature" };
  // A grant to the owner key itself would let it in as a device after it stops
  // being the owner. Depth 1 means the owner is never its own grantee.
  if (signer === grant.grantee) return { ok: false, refusal: "malformed" };
  if (!(await isOwner(signer, grant.parent))) return { ok: false, refusal: "not-owner" };

  if (nonceUsed(grant.parent, grant.nonce)) return { ok: false, refusal: "nonce-used" };
  const entry = account(grant.parent);
  // Live under THIS owner only: grants from a previous owner are dead weight and
  // must not hold the new owner's slots.
  const live = Object.values(entry.grants).filter(
    (r) => r.revokedAt === undefined && r.signer === signer && r.grant.grantee !== grant.grantee,
  ).length;
  if (live >= MAX_DEVICE_GRANTS) return { ok: false, refusal: "cap-reached" };

  const prev = entry.grants[grant.grantee];
  const carried = Math.max(prev?.notBefore ?? 0, prev?.revokedAt ?? 0);
  const record: DeviceGrantRecord = {
    grant,
    grantSig: body.grantSig as string,
    signer,
    registeredAt: now,
    ...(carried > 0 ? { notBefore: carried } : {}),
  };
  entry.grants[grant.grantee] = record;
  entry.nonces.push(grant.nonce);
  nonceSets.get(grant.parent)!.add(grant.nonce);
  if (!persist()) {
    console.error(`[device-grants] grant for ${grant.parent.slice(0, 10)}… is live in memory but NOT on disk`);
  }
  return { ok: true, record, changed: true };
}

/**
 * Remove a device. Signed by the account's owner, or by the device itself
 * ("sign this device out"). Removing an already-removed grant answers with the
 * existing record and consumes nothing.
 */
export async function submitDeviceGrantRevoke(
  accountAddress: string,
  body: { revoke?: unknown; revokeSig?: unknown },
  isOwner: OwnerCheck,
  now = Date.now(),
): Promise<DeviceGrantResult> {
  ensureLoaded();
  if (fileUnreadable) return { ok: false, refusal: "store-unavailable" };
  const revoke = parseDeviceGrantRevoke(body.revoke);
  if (!revoke) return { ok: false, refusal: "malformed" };
  if (revoke.parent !== accountAddress.toLowerCase()) return { ok: false, refusal: "wrong-account" };
  const signer = recoverSigner(DEVICE_GRANT_REVOKE_TYPES, revoke, body.revokeSig);
  if (!signer) return { ok: false, refusal: "bad-signature" };
  if (signer !== revoke.grantee && !(await isOwner(signer, revoke.parent))) {
    return { ok: false, refusal: "not-allowed" };
  }

  // After the await, as for grants.
  const record = state.accounts[revoke.parent]?.grants[revoke.grantee];
  if (!record) return { ok: false, refusal: "not-found" };
  if (record.revokedAt !== undefined) return { ok: true, record, changed: false };
  if (nonceUsed(revoke.parent, revoke.nonce)) return { ok: false, refusal: "nonce-used" };
  record.revoke = revoke;
  record.revokeSig = body.revokeSig as string;
  record.revokedBy = signer;
  record.revokedAt = now;
  const entry = account(revoke.parent);
  entry.nonces.push(revoke.nonce);
  nonceSets.get(revoke.parent)!.add(revoke.nonce);
  // A removal that is in memory takes effect at once, and is what the device's
  // owner asked for; a failed write is reported, never rolled back.
  if (!persist()) {
    console.error(`[device-grants] removal for ${revoke.parent.slice(0, 10)}… is live in memory but NOT on disk`);
  }
  return { ok: true, record, changed: true };
}

export function deviceGrantHealth(): { ok: boolean; unreadable: boolean; accounts: number } {
  ensureLoaded();
  return { ok: fileUnreadable === null, unreadable: fileUnreadable !== null, accounts: Object.keys(state.accounts).length };
}

/** Tests only: forget memory so the next call reloads from disk. */
export function __resetDeviceGrantsForTest(): void {
  state = { version: 1, accounts: {} };
  nonceSets.clear();
  fileUnreadable = null;
  loaded = false;
}
