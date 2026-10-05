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
 * WHAT A READ DECIDES depends on how the passkey answered:
 * - on this device ("platform", or the browser did not say): only to REFUSE. Absent,
 *   unreadable, or a read that throws proceeds exactly as before this guard existed,
 *   so an outage never locks anyone out;
 * - from another device ("cross-platform": a phone by QR code, or a security key):
 *   the sign-in commits only on a POSITIVE match. A QR-code answer can carry the
 *   wrong PRF output, which is a different, empty account, and the record is the
 *   one thing that can tell. Absent or unreadable refuses - unless this device made
 *   the account and still holds its unwritten record (the pending slot), which says
 *   the same thing as the record would.
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
import type { PasskeyAttachment } from "./passkey-account.js";

export type PasskeyRecordVerdict = "proceed" | "mismatch" | "backup";

/** What a record read says about one (credential, account) pair. */
export type PasskeyRecordReading = "match" | "mismatch" | "backup" | "absent" | "unreadable" | "unknown-format";

/** What a sign-in does next: commit, or which refusal to show. */
export type SignInRecordOutcome = "proceed" | "mismatch" | "backup" | "other-device" | "unreadable";

/** A just-created account's record, still waiting on this device to be written. */
export interface PendingPasskeyRecord {
  credentialId: string;
  parent: string;
}

/** The passkey's record names a different account than this sign-in derived. */
export class PasskeyRecordMismatchError extends Error {
  constructor() {
    super("This passkey didn't open your account on this device. Sign in on the device where you usually use it.");
    this.name = "PasskeyRecordMismatchError";
  }
}

/** We could not read the record of a passkey that answered from another device. */
export class PasskeyRecordUnreadableError extends Error {
  constructor() {
    super("Couldn't check that passkey just now - try again in a moment.");
    this.name = "PasskeyRecordUnreadableError";
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

/** Classify a record read for one (credential, account) pair. Pure. */
export function classifyPasskeyRecord(
  read: ContentFeedResult<unknown>,
  credentialId: Uint8Array,
  parent: string,
): PasskeyRecordReading {
  if (read.status === "absent") return "absent";
  if (read.status !== "found") return "unreadable";
  const record = parsePasskeyRecord(read.value);
  if (!record) return "unknown-format";
  if (record.kind === "backup") return "backup";
  return record.commit === passkeyRecordCommit(parent, credentialId) ? "match" : "mismatch";
}

/**
 * The lenient rule. Pure. Refuses on a record that names a different account or
 * marks a backup; everything else - no record, an unreadable one, a format this
 * build does not know - proceeds as before.
 */
export function passkeyRecordVerdict(
  read: ContentFeedResult<unknown>,
  credentialId: Uint8Array,
  parent: string,
): PasskeyRecordVerdict {
  const reading = classifyPasskeyRecord(read, credentialId, parent);
  return reading === "backup" || reading === "mismatch" ? reading : "proceed";
}

/** Whether this device's pending slot names exactly this credential and account. */
export function pendingRecordMatches(
  pending: PendingPasskeyRecord | null | undefined,
  credentialId: string,
  parent: string,
): boolean {
  return !!pending && pending.credentialId === credentialId && pending.parent.toLowerCase() === parent.toLowerCase();
}

/**
 * What a sign-in does with a reading. Pure. A backup is refused however it answered.
 * From another device, only a match - or this device's own pending record for the
 * same pair - commits; a record that exists and names another account wins over the
 * pending slot. A future record format refuses too: an older build cannot confirm it.
 */
export function signInRecordOutcome(
  reading: PasskeyRecordReading,
  attachment: PasskeyAttachment,
  pendingMatches: boolean,
): SignInRecordOutcome {
  if (reading === "backup") return "backup";
  if (reading === "match") return "proceed";
  if (attachment !== "cross-platform") return reading === "mismatch" ? "mismatch" : "proceed";
  if (reading === "mismatch") return "other-device";
  if (pendingMatches) return "proceed";
  return reading === "unreadable" ? "unreadable" : "other-device";
}

export interface PasskeyRecordDeps {
  read: (credentialId: Uint8Array, opts?: { thorough?: boolean }) => Promise<ContentFeedResult<unknown>>;
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
 * Version 0 of a credential's record, the only version anyone reads. `thorough` only
 * where an absent REFUSES (a passkey from another device): our gateway's 404 or gate
 * 403 is not proof for a record stamped on Etherna. Elsewhere a false absent only
 * misses a refusal, and thorough would add a server round trip to every cold sign-in
 * on a passkey that has no record.
 */
export async function readPasskeyRecord(
  credentialId: Uint8Array,
  opts: { thorough?: boolean } = {},
): Promise<ContentFeedResult<unknown>> {
  const { address } = passkeyRecordOwnerKey(credentialId);
  const { readContentFeedAtVersion } = await import("../swarm/content-feed.js");
  return readContentFeedAtVersion(address, PASSKEY_RECORD_TOPIC, 0, {
    route: await routeFor(),
    thorough: opts.thorough === true,
  });
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
 * otherwise. `attachment` is required so a call site cannot drop it into the
 * lenient rule by omission; `pending` is this device's unwritten record, if any.
 */
export async function guardPasskeyRecord(
  credentialId: string,
  parent: string,
  attachment: PasskeyAttachment,
  deps: { read?: PasskeyRecordDeps["read"]; pending?: PendingPasskeyRecord | null } = {},
): Promise<void> {
  const strict = attachment === "cross-platform";
  const id = credentialIdBytes(credentialId);
  const read = deps.read ?? DEFAULT_DEPS.read;
  let result: ContentFeedResult<unknown>;
  try {
    result = strict ? await read(id, { thorough: true }) : await read(id);
  } catch (e) {
    // A network exception from the reader is an unreadable record, not an absent one.
    console.warn("[auth] passkey record read failed:", e);
    result = { status: "unavailable", reason: String(e) };
  }
  const outcome = signInRecordOutcome(
    classifyPasskeyRecord(result, id, parent),
    attachment,
    pendingRecordMatches(deps.pending, credentialId, parent),
  );
  if (outcome === "proceed") return;
  if (outcome === "mismatch") throw new PasskeyRecordMismatchError();
  if (outcome === "unreadable") throw new PasskeyRecordUnreadableError();
  const { PasskeyIsBackupError, PasskeyFromAnotherDeviceError } = await import("./passkey-account.js");
  throw outcome === "backup" ? new PasskeyIsBackupError() : new PasskeyFromAnotherDeviceError();
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
