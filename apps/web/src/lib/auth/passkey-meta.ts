/**
 * What THIS device knows about the passkeys it added to an account (#746 step 3):
 * the password manager each one went into and its credential id, keyed by the
 * grant's `credentialTag`. Device-local by rule - which manager holds an account's
 * keys tells someone which account to attack - so it is never sent to the server
 * or written to Swarm, sealed or not. Another device shows a generic label.
 */

import type { PasskeyProviderId } from "@woco/shared";
import { getKV, putKV } from "./storage/indexeddb.js";

export interface AddedPasskeyMeta {
  provider: PasskeyProviderId;
  addedAt: number;
  /** base64url - kept so the next add can exclude this manager. */
  credentialId: string;
}

function key(parent: string): string {
  return `woco:auth:passkey-meta:${parent.toLowerCase()}`;
}

export async function readPasskeyMeta(parent: string): Promise<Record<string, AddedPasskeyMeta>> {
  return (await getKV<Record<string, AddedPasskeyMeta>>(key(parent))) ?? {};
}

export async function writePasskeyMeta(parent: string, credentialTag: string, meta: AddedPasskeyMeta): Promise<void> {
  const all = await readPasskeyMeta(parent);
  all[credentialTag.toLowerCase()] = meta;
  await putKV(key(parent), all);
}
