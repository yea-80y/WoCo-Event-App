/**
 * User manifest — a single client-owned, encrypted-to-SELF feed per account
 * (Recovery Increment 3a; seeds the Phase-4 content manifest).
 *
 * The manifest is a Single-Owner Chunk signed by the user's own content-feed
 * signer (`swarm/content-feed.ts`), so the USER owns the storage slot and the
 * platform only stamps postage. Its payload is a `SelfSealedEnvelope`: the JSON
 * body encrypted under a key ONLY the user can derive (from their feed-signer
 * secret), so the server — and any feed reader — sees ciphertext only. This is a
 * private, LOGGED-IN comfort layer, NOT a recovery-time artefact: recovery with
 * no key still self-discovers via the guardian-owned recovery SOC.
 *
 * v1 carries the BACKUP INVENTORY (which recovery backups the user configured, so
 * a signed-in user can SEE and manage them). It holds NO secrets — the sealed
 * recovery envelope stays in the guardian SOC (`swarm/recovery-feed.ts`); this is
 * only self-describing metadata.
 *
 * FORWARD DESIGN (Phase 4, additive — no version bump, just a new optional field):
 * the same manifest will also hold the user's ACTIVE feed-hash log. That enables
 * (a) deletion-by-omission — dropping a hash means the app stops surfacing it and
 * it is NOT re-pinned on the next postage-batch migration, so it dies with the old
 * batch's TTL (doubles as a GDPR-erasure story); and (b) clean batch migration —
 * only the manifest's still-listed hashes are ported to a fresh batch, so the new
 * batch carries no dead weight. Keep new sections OPTIONAL so old readers ignore
 * what they don't understand.
 */

/** Fixed topic for the per-account user manifest. Owner (feed signer) disambiguates. */
export const USER_MANIFEST_TOPIC = "woco/manifest/v1";

/** Current manifest schema version. Bump only on a NON-additive change. */
export const USER_MANIFEST_VERSION = 1 as const;

/** How a recovery backup was added — mirrors the setup UI's method choices. */
export type BackupMethod = "email" | "passkey" | "wallet";

/**
 * One configured recovery backup, as the user's own private record. Contains NO
 * secret material — the guardian address is public (installed on-chain) and the
 * labels are non-PII memory-jogs. `maskedEmail` is an OPTIONAL, opt-in hint that
 * lives ONLY inside this encrypted-to-self envelope (never on our server); it is
 * left unset by default (owner: don't over-build the "see your email later" path).
 */
export interface BackupInventoryEntry {
  /** The method the user chose at setup. */
  method: BackupMethod;
  /**
   * Category label for the "which one did I use again?" memory-jog — e.g.
   * "google", "email_passwordless", "passkey", "wallet". A PROVIDER CATEGORY, not
   * PII; for email/social it comes from Web3Auth `typeOfLogin`.
   */
  providerLabel?: string;
  /**
   * Lowercased DERIVED guardian address that `setupAccountRecovery` installed
   * on-chain (the same value the recovery index is keyed by). The natural
   * de-duplication key: re-adding the same guardian replaces its entry.
   */
  guardianAddress: string;
  /** Unix ms when this backup was added. */
  addedAt: number;
  /** Optional user-only masked hint (e.g. "n•••@gmail.com"). Never a secret. */
  maskedEmail?: string;
}

/**
 * What kind of content a `ManifestFeedEntry` describes. `collection`/`ticket`
 * are reserved for the attendee rollout (profile + ticket collection) so the
 * schema doesn't move when that lands.
 */
export type ManifestFeedKind = "profile" | "avatar" | "event" | "site" | "collection" | "ticket";

/**
 * One ACTIVE client-owned feed in the user's content log (Phase 4 of the
 * manifest design — see the header). The durable identity of a mutable feed is
 * its TOPIC (the SOC owner is the user's feed signer; the SOC address derives
 * from both and survives edits AND batch migration), so that — never a latest
 * payload hash — is what we log. `refs` lists immutable content the feed
 * depends on (an avatar image, a deployed site collection) where recording it
 * here is what makes REPLACEMENT detectable: when an upsert drops a ref, the
 * displaced ref moves to `trash` (restorable until the old batch dies).
 * Batch migration = re-stamp every entry's SOC + refs on the new batch;
 * anything not listed dies with the old batch's TTL (deletion-by-omission).
 */
export interface ManifestFeedEntry {
  kind: ManifestFeedKind;
  /** Content-feed topic string (e.g. `woco/event/{eventId}`). Dedup key with `kind`. */
  topic: string;
  /** Non-PII memory-jog shown in the user's own storage panel (event title, brand name). */
  label?: string;
  /** Immutable content refs (hex, no 0x) this feed depends on. */
  refs?: string[];
  /** Sites only: the live deploy pointers (replaced contentHash → trash). */
  siteMeta?: { feedManifestHash?: string; contentHash?: string };
  /** Which gateway/batch family the content is stamped on. */
  target?: "woco" | "etherna";
  /** Unix ms of the last upsert. */
  updatedAt: number;
}

/**
 * A deleted/displaced item, kept ONLY as a restore-window courtesy: on Swarm,
 * anything the manifest stops listing already dies with its batch (deletion is
 * by omission and eventual — never promise immediate erasure). Entries here are
 * restorable until a batch migration/TTL actually kills the chunks.
 */
export interface ManifestTrashEntry {
  kind: ManifestFeedKind;
  /** Present when a whole feed was deleted (vs just displaced refs). */
  topic?: string;
  /** Displaced immutable refs (old avatar image, superseded site build). */
  refs?: string[];
  label?: string;
  /** Unix ms of the delete/displacement. */
  deletedAt: number;
}

/**
 * The decrypted manifest body (what a `SelfSealedEnvelope` wraps). v1 = the backup
 * inventory. New sections (e.g. `feeds`) are added as OPTIONAL fields.
 */
export interface UserManifest {
  v: typeof USER_MANIFEST_VERSION;
  /** Unix ms of the last write. */
  updatedAt: number;
  /** Recovery backups the user has configured. */
  backups: BackupInventoryEntry[];
  /** Active client-owned feed log (Phase 4) — the batch-migration keep-list. */
  feeds?: ManifestFeedEntry[];
  /** Deleted/displaced items, restorable until the old batch dies. */
  trash?: ManifestTrashEntry[];
}

/**
 * Encrypt-to-self envelope stored as the manifest SOC payload. The plaintext is
 * the JSON `UserManifest`, sealed with XChaCha20-Poly1305 under a key HKDF-derived
 * from the user's feed-signer secret (client-only), with the account address bound
 * as additional-data so a copied envelope cannot be replayed under another
 * account. See `apps/web/src/lib/manifest/self-seal.ts`.
 */
export interface SelfSealedEnvelope {
  /** Envelope-format version (implies the AEAD suite). */
  v: 1;
  /** XChaCha20-Poly1305 nonce (hex, 24 bytes). */
  nonce: string;
  /** Ciphertext (hex). */
  ct: string;
}

/** Narrow an unknown feed payload to a `SelfSealedEnvelope`. */
export function isSelfSealedEnvelope(x: unknown): x is SelfSealedEnvelope {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as SelfSealedEnvelope).v === 1 &&
    typeof (x as SelfSealedEnvelope).nonce === "string" &&
    typeof (x as SelfSealedEnvelope).ct === "string"
  );
}
