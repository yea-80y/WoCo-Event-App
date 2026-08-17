/**
 * Backup-inventory manifest (Recovery Increment 3a).
 *
 * A thin read-modify-write layer over the user's encrypted-to-self manifest feed:
 *  - the storage slot is a client-owned SOC at `USER_MANIFEST_TOPIC`, owned +
 *    signed by the user's content-feed signer (`swarm/content-feed.ts`);
 *  - the payload is a `SelfSealedEnvelope` — the JSON manifest sealed to self
 *    (`self-seal.ts`), so the server stores ciphertext only.
 *
 * Every operation takes the resolved feed-signer key/address + account address as
 * arguments (the auth-store owns those secrets) so this module stays free of
 * store/DOM dependencies and is unit-testable in isolation. All of it is a
 * best-effort comfort layer: callers treat failures as non-fatal.
 */

import {
  USER_MANIFEST_TOPIC,
  USER_MANIFEST_VERSION,
  isSelfSealedEnvelope,
  type UserManifest,
  type BackupInventoryEntry,
  type ManifestFeedEntry,
  type ManifestFeedKind,
  type SelfSealedEnvelope,
} from "@woco/shared";
import { readContentFeedResult, writeContentFeed } from "../swarm/content-feed.js";
import { openFromSelf, sealToSelf } from "./self-seal.js";
import { mergeFeedEntry, removeFeedEntry, restoreFeedEntry, retireBackupEntries } from "./ops.js";

/** The feed-signer material the manifest is owned by + sealed to. */
export interface ManifestSigner {
  /** Content-feed signer private key (0x-prefixed) — signs the SOC + seeds the seal key. */
  privKey: string;
  /** Content-feed signer address — the SOC owner readers resolve. */
  address: string;
}

/**
 * Tri-state manifest read: "there isn't one" and "couldn't read it" are different
 * answers, and the WRITE path must act on them oppositely — writing on
 * `unavailable` would clobber a manifest we merely failed to read (#154/#155/#171).
 *
 * `absent` means the feed genuinely holds nothing we recognise as a manifest.
 * Everything else — the network not answering, AND bytes that exist but will not
 * open or do not parse as a manifest — is `unavailable`.
 *
 * THAT LAST PART IS DELIBERATE, and it is where two branches disagreed. Treating a
 * decrypt/parse failure as `absent` (on the reasoning that an unopenable manifest is
 * already lost) is safe for display, but it is exactly what a mutator would act on by
 * writing a FRESH manifest over bytes it could not read — destroying `feeds`, the
 * batch-migration keep-list, which is real content, not a comfort layer. Refusing to
 * write costs the user a stale backup list; guessing costs them their keep-list.
 */
export type ManifestReadResult =
  | { status: "found"; manifest: UserManifest }
  | { status: "absent" }
  | { status: "unavailable"; reason?: string };

export async function readUserManifestResult(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<ManifestReadResult> {
  const read = await readContentFeedResult<unknown>(args.signer.address, USER_MANIFEST_TOPIC)
    .catch((e: unknown) => ({ status: "unavailable" as const, reason: String(e) }));
  if (read.status === "unavailable") return read;
  if (read.status === "absent") return { status: "absent" };
  if (!isSelfSealedEnvelope(read.value)) {
    return { status: "unavailable", reason: "feed payload is not a self-sealed envelope" };
  }
  try {
    const manifest = openFromSelf<UserManifest>({
      feedSignerPrivKey: args.signer.privKey,
      parentAddress: args.parentAddress,
      envelope: read.value as SelfSealedEnvelope,
    });
    if (typeof manifest?.updatedAt !== "number" || !Array.isArray(manifest?.backups)) {
      return { status: "unavailable", reason: "decoded payload is not a usable manifest" };
    }
    return { status: "found", manifest };
  } catch (e) {
    return { status: "unavailable", reason: `manifest did not open: ${String(e)}` };
  }
}

/**
 * Lenient read for DISPLAY paths: the manifest, or null for both "none" and
 * "couldn't read". A read-modify-write must not use this — see
 * {@link readUserManifestResult}.
 */
export async function readUserManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<UserManifest | null> {
  const read = await readUserManifestResult(args);
  return read.status === "found" ? read.manifest : null;
}

/**
 * Load the manifest for a read-modify-write, or throw when we could not read it.
 * Every mutator below rewrites the WHOLE manifest, so merging against a null base
 * that only meant "couldn't read" silently drops every entry the user already had
 * (#171). Callers are all fire-and-forget comfort-layer paths that already log and
 * swallow, so throwing here just means "skip this update".
 */
async function manifestBaseForWrite(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<UserManifest | null> {
  const read = await readUserManifestResult(args);
  if (read.status === "unavailable") {
    throw new Error(`manifest unreadable — refusing to rewrite it (${read.reason ?? "unknown"})`);
  }
  return read.status === "found" ? read.manifest : null;
}

// Backup reads live in backup-inventory.ts (#166 item 4): every consumer of the
// backup list is a security surface, so the lenient collapsed-to-[] readers that
// used to sit here are gone — there is only the tri-state read.

/** Seal + write a manifest to the user's SOC (the shared tail of every mutation). */
async function writeUserManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  manifest: UserManifest;
}): Promise<void> {
  const envelope = sealToSelf({
    feedSignerPrivKey: args.signer.privKey,
    parentAddress: args.parentAddress,
    data: args.manifest,
  });
  await writeContentFeed({
    signerPrivKey: args.signer.privKey,
    topic: USER_MANIFEST_TOPIC,
    data: envelope,
  });
}

/**
 * Upsert a backup entry into the manifest (read → replace-by-guardian → seal →
 * write). Idempotent per guardian address: re-adding the same guardian updates its
 * entry rather than duplicating it. Preserves any other manifest sections a future
 * version added by spreading the decoded manifest.
 */
export async function upsertBackupEntry(args: {
  signer: ManifestSigner;
  parentAddress: string;
  entry: BackupInventoryEntry;
}): Promise<void> {
  const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
  const g = args.entry.guardianAddress.toLowerCase();
  const kept = (existing?.backups ?? []).filter((b) => b.guardianAddress.toLowerCase() !== g);

  const manifest: UserManifest = {
    ...(existing ?? {}),
    v: USER_MANIFEST_VERSION,
    updatedAt: Date.now(),
    backups: [...kept, { ...args.entry, guardianAddress: g }],
  };
  await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest });
}

/**
 * Retire the whole backup inventory after an on-chain "Remove all backups" (#165).
 * Call it ONLY once the removal is proven on-chain — retiring the local record of
 * backups that still work would hide a live takeover route from the user.
 *
 * Reports which of three things happened, because the caller renders a claim about
 * it: an unreadable manifest is `"unavailable"`, never a silent success. Writing on
 * an inconclusive read would also republish a manifest with the feed keep-list
 * missing, so this refuses rather than guesses (#154).
 */
export type RetireBackupsResult = "retired" | "nothing-to-retire" | "unavailable";

export async function retireBackupInventory(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<RetireBackupsResult> {
  const res = await readUserManifestResult({ signer: args.signer, parentAddress: args.parentAddress });
  if (res.status === "unavailable") return "unavailable";
  if (res.status === "absent") return "nothing-to-retire";
  if (!res.manifest.backups.some((b) => !b.revoked)) return "nothing-to-retire"; // don't churn the feed
  await writeUserManifest({
    signer: args.signer,
    parentAddress: args.parentAddress,
    manifest: retireBackupEntries(res.manifest),
  });
  return "retired";
}

// ── Feed log + trash (Phase 4 — active client-owned content) ────────────────
// Pure transforms live in ops.ts; these wrap them in the read→seal→write cycle.
// All best-effort comfort-layer semantics: callers treat failures as non-fatal.

/** Upsert an active-feed entry; displaced refs move to trash (see ops.ts). */
export async function upsertFeedEntry(args: {
  signer: ManifestSigner;
  parentAddress: string;
  entry: ManifestFeedEntry;
}): Promise<void> {
  const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
  const manifest = mergeFeedEntry(existing, args.entry);
  await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest });
}

/** Move a whole feed entry to trash (restorable until the old batch dies). */
export async function trashFeedEntryOnManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  kind: ManifestFeedKind;
  topic: string;
}): Promise<void> {
  const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
  const manifest = removeFeedEntry(existing, args.kind, args.topic);
  await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest });
}

/** Restore a whole-feed trash entry back into the active log. */
export async function restoreFeedEntryOnManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  kind: ManifestFeedKind;
  topic: string;
}): Promise<void> {
  const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
  const manifest = restoreFeedEntry(existing, args.kind, args.topic);
  await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest });
}

/** Convenience read: the active feed log (empty if no manifest yet). */
export async function readFeedLog(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<ManifestFeedEntry[]> {
  const manifest = await readUserManifest(args);
  return manifest?.feeds ?? [];
}
