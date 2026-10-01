/**
 * Passkey records (#746) - the format and the reasons live in `@woco/shared`
 * auth/passkey-record.ts. This module reads them on a cold sign-in and writes one
 * when an account is created.
 *
 * WHEN A RECORD IS WRITTEN: once, at account creation - the one moment the account
 * is known for certain, because whatever the creation ceremony answered IS the
 * account, even by QR code. A sign-in never writes one: a passkey answering by QR
 * code may carry a different PRF output than the account was made with, and a
 * record written then would pin the passkey to the wrong account.
 *
 * WHAT A READ DECIDES: only to REFUSE. Absent, unreadable, or a read that throws
 * proceeds exactly as before this guard existed, so an outage never locks anyone
 * out.
 */

import {
  PASSKEY_RECORD_TOPIC,
  PASSKEY_RECORD_VERSION,
  parsePasskeyRecord,
  passkeyRecordCommit,
  passkeyRecordOwnerKey,
  type PasskeyRecord,
} from "@woco/shared/auth/passkey-record";
import type { ContentFeedResult } from "../swarm/content-feed.js";

export type PasskeyRecordVerdict = "proceed" | "mismatch" | "backup";

/** The passkey's record names a different account than this sign-in derived. */
export class PasskeyRecordMismatchError extends Error {
  constructor() {
    super("This passkey didn't open your account on this device. Sign in on the device where you usually use it.");
    this.name = "PasskeyRecordMismatchError";
  }
}

/** Decode a base64url credential id. */
export function credentialIdBytes(credentialId: string): Uint8Array {
  const padded = credentialId.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * What a sign-in does with a record read. Pure. Refuses on a record that names a
 * different account or marks a backup; everything else - no record, an unreadable
 * one, a format this build does not know - proceeds as before.
 */
export function passkeyRecordVerdict(
  read: ContentFeedResult<unknown>,
  credentialId: Uint8Array,
  parent: string,
): PasskeyRecordVerdict {
  if (read.status !== "found") return "proceed";
  const record = parsePasskeyRecord(read.value);
  if (!record) return "proceed";
  if (record.kind === "backup") return "backup";
  return record.commit === passkeyRecordCommit(parent, credentialId) ? "proceed" : "mismatch";
}

export interface PasskeyRecordDeps {
  read: (credentialId: Uint8Array) => Promise<ContentFeedResult<unknown>>;
  write: (credentialId: Uint8Array, record: PasskeyRecord) => Promise<void>;
}

async function routeFor() {
  const { FEED_ROUTES } = await import("../swarm/gateways.js");
  // The recovery family's store: the record is the same kind of credential-scoped
  // account fact as the portability envelope, and reusing the route keeps the
  // server's family table unchanged.
  return FEED_ROUTES.recoveryPortability;
}

/**
 * Version 0 of a credential's record, the only version anyone reads. Not `thorough`:
 * a false absent only misses a refusal (today's behaviour), while thorough would add
 * a server round trip to every cold sign-in on a passkey that has no record.
 */
export async function readPasskeyRecord(credentialId: Uint8Array): Promise<ContentFeedResult<unknown>> {
  const { address } = passkeyRecordOwnerKey(credentialId);
  const { readContentFeedAtVersion } = await import("../swarm/content-feed.js");
  return readContentFeedAtVersion(address, PASSKEY_RECORD_TOPIC, 0, { route: await routeFor() });
}

/** Write version 0. If it already exists the chunk is a silent no-op: first write wins. */
export async function writePasskeyRecord(credentialId: Uint8Array, record: PasskeyRecord): Promise<void> {
  const { privKey } = passkeyRecordOwnerKey(credentialId);
  const { writeContentFeed } = await import("../swarm/content-feed.js");
  await writeContentFeed({
    signerPrivKey: privKey,
    topic: PASSKEY_RECORD_TOPIC,
    data: record,
    route: await routeFor(),
    knownVersion: 0,
  });
}

const DEFAULT_DEPS: PasskeyRecordDeps = { read: readPasskeyRecord, write: writePasskeyRecord };

/**
 * The cold sign-in check. Throws the refusal the login modal shows; returns
 * otherwise.
 */
export async function guardPasskeyRecord(
  credentialId: string,
  parent: string,
  deps: Pick<PasskeyRecordDeps, "read"> = DEFAULT_DEPS,
): Promise<void> {
  const id = credentialIdBytes(credentialId);
  let read: ContentFeedResult<unknown>;
  try {
    read = await deps.read(id);
  } catch (e) {
    // A network exception from the reader is an unreadable record, not a refusal.
    console.warn("[auth] passkey record read failed - proceeding without the check:", e);
    read = { status: "unavailable", reason: String(e) };
  }
  const verdict = passkeyRecordVerdict(read, id, parent);
  if (verdict === "mismatch") throw new PasskeyRecordMismatchError();
  if (verdict === "backup") {
    const { PasskeyIsBackupError } = await import("./passkey-account.js");
    throw new PasskeyIsBackupError();
  }
}

/**
 * Write a new account's record unless one is already there. `unavailable` means
 * try again later; every other outcome is final.
 */
export async function ensurePasskeyRecord(
  args: { credentialId: string; parent: string },
  deps: PasskeyRecordDeps = DEFAULT_DEPS,
): Promise<"written" | "present" | "conflict" | "unavailable"> {
  const id = credentialIdBytes(args.credentialId);
  const read = await deps.read(id);
  if (read.status === "unavailable") return "unavailable";
  if (read.status === "found") {
    return passkeyRecordVerdict(read, id, args.parent) === "proceed" ? "present" : "conflict";
  }
  await deps.write(id, {
    v: PASSKEY_RECORD_VERSION,
    kind: "main",
    commit: passkeyRecordCommit(args.parent, id),
  });
  return "written";
}
