/**
 * Passkey WebAuthn user handles that say what a credential is for (#746, #545 A3).
 * Every assertion returns the handle, so the sign-in knows at once - no record read,
 * no network - whether it was handed a BACKUP (refused as a login) or an ADDED
 * passkey (signs in as a device of an account, never as one of its own). Split
 * from `passkey-record.ts` so the sign-in screen, which is in the first-load
 * bundle, carries only these few bytes.
 *
 * A handle carries no account: `user.id` syncs into the password manager, and the
 * credential that would make a commitment does not exist until it is created.
 */

import { utf8ToBytes } from "@noble/hashes/utils.js";

/** Prefix of a backup passkey's user handle (`user.id`). FROZEN. */
export const PASSKEY_BACKUP_USER_HANDLE_PREFIX = "woco-backup-v1:";

/** Prefix of an ADDED passkey's user handle - one the main passkey granted. FROZEN. */
export const PASSKEY_ADDED_USER_HANDLE_PREFIX = "woco-added-v1:";

function newHandle(prefixText: string): Uint8Array<ArrayBuffer> {
  const prefix = utf8ToBytes(prefixText);
  const handle = new Uint8Array(prefix.length + 16);
  handle.set(prefix, 0);
  handle.set(crypto.getRandomValues(new Uint8Array(16)), prefix.length);
  return handle;
}

function hasPrefix(handle: Uint8Array | null | undefined, prefixText: string): boolean {
  if (!handle) return false;
  const prefix = utf8ToBytes(prefixText);
  if (handle.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (handle[i] !== prefix[i]) return false;
  return true;
}

/** A backup passkey's user handle: the frozen prefix, then 16 random bytes. */
export function newBackupUserHandle(): Uint8Array<ArrayBuffer> {
  return newHandle(PASSKEY_BACKUP_USER_HANDLE_PREFIX);
}

/** Whether an assertion's user handle marks a backup passkey. */
export function isBackupUserHandle(handle: Uint8Array | null | undefined): boolean {
  return hasPrefix(handle, PASSKEY_BACKUP_USER_HANDLE_PREFIX);
}

/** An added passkey's user handle: the frozen prefix, then 16 random bytes. */
export function newAddedUserHandle(): Uint8Array<ArrayBuffer> {
  return newHandle(PASSKEY_ADDED_USER_HANDLE_PREFIX);
}

/** Whether an assertion's user handle marks an added passkey. */
export function isAddedUserHandle(handle: Uint8Array | null | undefined): boolean {
  return hasPrefix(handle, PASSKEY_ADDED_USER_HANDLE_PREFIX);
}
