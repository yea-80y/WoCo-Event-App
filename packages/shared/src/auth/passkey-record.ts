/**
 * Which account a passkey belongs to (#746), so a sign-in that would silently open
 * the WRONG account is refused with an explanation instead.
 *
 * Two ways a real passkey lands on an empty account today:
 *   - a passkey used from another device by QR code can answer with a different PRF
 *     output than on its own device (an Apple bug reported as fixed in iOS 18.4 and
 *     still reproduced on iOS 26.3.1), and a different PRF output IS a different
 *     account here;
 *   - a backup passkey picked at sign-in instead of under Recover (#545 A3).
 *
 * THE RECORD IS KEYED BY THE CREDENTIAL ID, NEVER BY THE PRF OUTPUT: the guard has to
 * find it exactly when the PRF misbehaves.
 *
 *   owner   = secp256k1 key from HKDF(sha256(credentialId), "", PASSKEY_RECORD_SOC_OWNER_INFO)
 *   topic   = PASSKEY_RECORD_TOPIC, VERSION 0 ONLY
 *   record  = { v: 1, kind: "main", commit }
 *   commit  = keccak256(PASSKEY_RECORD_COMMIT_LABEL || parent (20 bytes) || credentialId)
 *
 * Version 0 only, because a SOC written at an existing address is a silent no-op:
 * the first record wins and readers ignore anything appended after it. The commit
 * hides both the account and the credential id, so the chunk says only that a
 * record exists. Anyone holding a credential id could write version 0 first, but
 * credential ids are seen only by our origin and the authenticator, and the most a
 * forged record can do is REFUSE a sign-in, never grant one.
 *
 * Backup passkeys are recognised without a record: their WebAuthn user handle
 * carries a frozen prefix (`passkey-backup-handle.ts`), which every assertion returns.
 *
 * Imported by SUBPATH only (`@woco/shared/auth/passkey-record`), never from the
 * package index: the sign-in screen is in the first-load bundle, and this belongs
 * in the chunk that loads when a record is actually read or written.
 *
 * EVERY LABEL HERE IS FROZEN. Change one and every record written so far stops
 * matching, so every guarded sign-in on a new device is refused.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveSecpFromSeed } from "../crypto/secp-hkdf.js";

/** Current record format. Anything else reads as no record (never as a refusal). */
export const PASSKEY_RECORD_VERSION = 1 as const;

/** Content-feed topic of a credential's record. FROZEN. */
export const PASSKEY_RECORD_TOPIC = "woco/passkey-record/v1";

/** HKDF info for the record's SOC owner key. FROZEN. */
export const PASSKEY_RECORD_SOC_OWNER_INFO = "woco/passkey-record/v1/soc-owner";

/** Domain label of the commitment. FROZEN. */
export const PASSKEY_RECORD_COMMIT_LABEL = "woco/passkey-record/v1/commit";


/** Kinds a record can name. Only "main" is written today. */
export type PasskeyRecordKind = "main" | "added" | "backup";

export interface PasskeyRecord {
  v: typeof PASSKEY_RECORD_VERSION;
  kind: PasskeyRecordKind;
  commit: string;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const COMMIT_RE = /^0x[0-9a-f]{64}$/;
const KINDS: readonly string[] = ["main", "added", "backup"];

function credentialBytes(credentialId: Uint8Array): Uint8Array {
  if (credentialId.length === 0) throw new Error("passkey record: empty credential id");
  return credentialId;
}

/** The key that owns a credential's record chunk. */
export function passkeyRecordOwnerKey(credentialId: Uint8Array): { privKey: string; address: string } {
  const seedHex = bytesToHex(sha256(credentialBytes(credentialId)));
  const { privateKey, address } = deriveSecpFromSeed(seedHex, PASSKEY_RECORD_SOC_OWNER_INFO, "credential id digest");
  return { privKey: `0x${bytesToHex(privateKey)}`, address: address.toLowerCase() };
}

/** The commitment a credential's record holds for the account it belongs to. */
export function passkeyRecordCommit(parent: string, credentialId: Uint8Array): string {
  const p = parent.toLowerCase();
  if (!ADDRESS_RE.test(p)) throw new Error("passkey record: parent must be a 20-byte address");
  const label = utf8ToBytes(PASSKEY_RECORD_COMMIT_LABEL);
  const id = credentialBytes(credentialId);
  const input = new Uint8Array(label.length + 20 + id.length);
  input.set(label, 0);
  input.set(hexToBytes(p.slice(2)), label.length);
  input.set(id, label.length + 20);
  return `0x${bytesToHex(keccak_256(input))}`;
}

/** A record from untrusted JSON, or null. Exact fields; an unknown version is null. */
export function parsePasskeyRecord(x: unknown): PasskeyRecord | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "commit,kind,v") return null;
  if (o.v !== PASSKEY_RECORD_VERSION) return null;
  if (typeof o.kind !== "string" || !KINDS.includes(o.kind)) return null;
  if (typeof o.commit !== "string" || !COMMIT_RE.test(o.commit)) return null;
  return { v: PASSKEY_RECORD_VERSION, kind: o.kind as PasskeyRecordKind, commit: o.commit };
}
