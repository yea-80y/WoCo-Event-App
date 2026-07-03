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
  type SelfSealedEnvelope,
} from "@woco/shared";
import { readContentFeed, writeContentFeed } from "../swarm/content-feed.js";
import { openFromSelf, sealToSelf } from "./self-seal.js";

/** The feed-signer material the manifest is owned by + sealed to. */
export interface ManifestSigner {
  /** Content-feed signer private key (0x-prefixed) — signs the SOC + seeds the seal key. */
  privKey: string;
  /** Content-feed signer address — the SOC owner readers resolve. */
  address: string;
}

/**
 * Read + decrypt the user's manifest, or null if none exists yet / it can't be
 * opened. A decrypt failure (tampered, or an incompatible future format) is
 * swallowed to null: this is a comfort layer, never a hard gate.
 */
export async function readUserManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<UserManifest | null> {
  const raw = await readContentFeed<unknown>(args.signer.address, USER_MANIFEST_TOPIC);
  if (!raw || !isSelfSealedEnvelope(raw)) return null;
  try {
    const manifest = openFromSelf<UserManifest>({
      feedSignerPrivKey: args.signer.privKey,
      parentAddress: args.parentAddress,
      envelope: raw as SelfSealedEnvelope,
    });
    if (typeof manifest?.updatedAt !== "number" || !Array.isArray(manifest?.backups)) return null;
    return manifest;
  } catch {
    return null;
  }
}

/** Convenience: just the backup inventory (empty if no manifest). */
export async function readBackupInventory(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<BackupInventoryEntry[]> {
  const manifest = await readUserManifest(args);
  return manifest?.backups ?? [];
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
  const existing = await readUserManifest({ signer: args.signer, parentAddress: args.parentAddress });
  const g = args.entry.guardianAddress.toLowerCase();
  const kept = (existing?.backups ?? []).filter((b) => b.guardianAddress.toLowerCase() !== g);

  const manifest: UserManifest = {
    ...(existing ?? {}),
    v: USER_MANIFEST_VERSION,
    updatedAt: Date.now(),
    backups: [...kept, { ...args.entry, guardianAddress: g }],
  };

  const envelope = sealToSelf({
    feedSignerPrivKey: args.signer.privKey,
    parentAddress: args.parentAddress,
    data: manifest,
  });
  await writeContentFeed({
    signerPrivKey: args.signer.privKey,
    topic: USER_MANIFEST_TOPIC,
    data: envelope,
  });
}
