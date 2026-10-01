/**
 * A backup passkey's WebAuthn user handle (#746, #545 A3). Every assertion returns
 * the handle, so a backup picked at sign-in is recognised and refused instantly -
 * no record read, no network. Split from `passkey-record.ts` so the sign-in screen,
 * which is in the first-load bundle, carries only these few bytes.
 */

import { utf8ToBytes } from "@noble/hashes/utils.js";

/** Prefix of a backup passkey's user handle (`user.id`). FROZEN. */
export const PASSKEY_BACKUP_USER_HANDLE_PREFIX = "woco-backup-v1:";

/** A backup passkey's user handle: the frozen prefix, then 16 random bytes. */
export function newBackupUserHandle(): Uint8Array<ArrayBuffer> {
  const prefix = utf8ToBytes(PASSKEY_BACKUP_USER_HANDLE_PREFIX);
  const handle = new Uint8Array(prefix.length + 16);
  handle.set(prefix, 0);
  handle.set(crypto.getRandomValues(new Uint8Array(16)), prefix.length);
  return handle;
}

/** Whether an assertion's user handle marks a backup passkey. */
export function isBackupUserHandle(handle: Uint8Array | null | undefined): boolean {
  if (!handle) return false;
  const prefix = utf8ToBytes(PASSKEY_BACKUP_USER_HANDLE_PREFIX);
  if (handle.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (handle[i] !== prefix[i]) return false;
  return true;
}
