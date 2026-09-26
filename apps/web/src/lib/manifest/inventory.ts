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
  looksLikeNewerSelfSealedEnvelope,
  type UserManifest,
  type BackupInventoryEntry,
  type ManifestFeedEntry,
  type ManifestFeedKind,
  type SelfSealedEnvelope,
} from "@woco/shared";
import {
  readContentFeedAtVersion,
  readContentFeedResult,
  writeContentFeed,
  type ContentFeedResult,
  type SocTransport,
} from "../swarm/content-feed.js";
import { FEED_ROUTES, type FeedRoute } from "../swarm/gateways.js";
import { openFromSelf, sealToSelf } from "./self-seal.js";
import { mergeFeedEntry, removeFeedEntry, restoreFeedEntry, retireBackupEntries, retireOneBackupEntry } from "./ops.js";

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
  | {
      status: "found";
      manifest: UserManifest;
      /**
       * Whether the version scan that chose this copy was conclusive. False = the
       * newest copy this read could REACH, not necessarily the newest: a
       * read-modify-write must refuse it, or the rewrite erases what the
       * unreachable version held (#651).
       */
      scanClean: boolean;
    }
  | { status: "absent" }
  | {
      status: "unavailable";
      reason?: string;
      /**
       * The feed version that exists and will never open. Set = the refusal above
       * is PERMANENT, so every mutator stays refused forever and the only way out
       * is to write past this version (`rebuildManifest`). Unset = we could not
       * read it this time, which a retry may well fix — and which must never
       * offer a repair, since the manifest it would overwrite may be intact.
       */
      unusableAt?: number;
      /**
       * The payload is a self-sealed envelope from a LATER format than this build
       * understands. Not damage: the data is fine and a newer app can read it, so
       * this must never be repaired — rebuilding would destroy it.
       */
      newerFormat?: boolean;
    };

/**
 * Read the manifest. ALWAYS thorough - there is no other kind of manifest read.
 *
 * Every reader either rewrites the whole manifest from what it read, or shows
 * the backup list, a surface that must not guess (#166). A non-thorough read
 * trusts our gateway's "not found", and neither can afford that: a gate refusal
 * reads as ABSENT, and since the manifest moved to Etherna (#689) our bee sees a
 * new version minutes after it is written, so a read that does not ask Etherna
 * returns the PREVIOUS version, marked clean. A rewrite built on that erases the
 * newer one while reporting success.
 */
export async function readUserManifestResult(args: {
  signer: ManifestSigner;
  parentAddress: string;
  /** Test seam — production always takes the real feed read. */
  readFeed?: (owner: string, topic: string, opts: { route: FeedRoute; thorough: true }) => Promise<ContentFeedResult<unknown>>;
}): Promise<ManifestReadResult> {
  const readFeed = args.readFeed ??
    ((owner, topic, opts) => readContentFeedResult<unknown>(owner, topic, opts));
  const read = await readFeed(args.signer.address, USER_MANIFEST_TOPIC, { route: FEED_ROUTES.manifest, thorough: true })
    .catch((e: unknown): ContentFeedResult<unknown> => ({ status: "unavailable", reason: String(e) }));
  if (read.status === "unavailable") {
    return { status: "unavailable", reason: read.reason, unusableAt: read.unusableAt };
  }
  if (read.status === "absent") return { status: "absent" };
  // Everything below this line read REAL BYTES at a KNOWN version, so each refusal
  // is definitive at that version — `unusableAt` says so, and without it these
  // three would keep presenting as "try again later" forever (#190).
  //
  // Only when the scan was clean, though. A dirty scan stopped at the newest copy
  // it could reach, and a newer one may be sitting unread on Etherna; calling the
  // reachable one frozen would offer a repair that writes over the newer copy.
  const unusable = (reason: string, newerFormat?: boolean): ManifestReadResult =>
    read.scanClean
      ? { status: "unavailable", reason, unusableAt: read.version, ...(newerFormat === undefined ? {} : { newerFormat }) }
      : { status: "unavailable", reason: `${reason}, and the scan could not confirm it is the newest version` };
  if (!isSelfSealedEnvelope(read.value)) {
    return unusable("feed payload is not a self-sealed envelope", looksLikeNewerSelfSealedEnvelope(read.value));
  }
  try {
    const manifest = openFromSelf<UserManifest>({
      feedSignerPrivKey: args.signer.privKey,
      parentAddress: args.parentAddress,
      envelope: read.value as SelfSealedEnvelope,
    });
    if (typeof manifest?.updatedAt !== "number" || !Array.isArray(manifest?.backups)) {
      return unusable("decoded payload is not a usable manifest");
    }
    return { status: "found", manifest, scanClean: read.scanClean };
  } catch (e) {
    return unusable(`manifest did not open: ${String(e)}`);
  }
}

/**
 * The manifest a read-modify-write may build on, or why it must not proceed.
 *
 * Every mutator rewrites the WHOLE manifest, so the base must be the newest
 * copy. Two ways it can fail to be, both of which succeed silently if allowed:
 * merging onto a null base that only meant "couldn't read" drops every entry the
 * user already had (#171), and merging onto a copy found by an inconclusive scan
 * reverts whatever the unreachable newer version held (#651).
 */
async function readManifestBase(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<{ ok: true; base: UserManifest | null } | { ok: false; reason: string }> {
  const read = await readUserManifestResult(args);
  if (read.status === "unavailable") return { ok: false, reason: `manifest unreadable (${read.reason ?? "unknown"})` };
  if (read.status === "absent") return { ok: true, base: null };
  if (!read.scanClean) return { ok: false, reason: "could not confirm this is the newest manifest" };
  return { ok: true, base: read.manifest };
}

/** `readManifestBase` for the mutators that throw. Callers are fire-and-forget
 *  comfort-layer paths that already log and swallow, so throwing here just means
 *  "skip this update". */
async function manifestBaseForWrite(args: {
  signer: ManifestSigner;
  parentAddress: string;
}): Promise<UserManifest | null> {
  const read = await readManifestBase(args);
  if (!read.ok) throw new Error(`${read.reason} — refusing to rewrite it`);
  return read.base;
}

/**
 * How long one manifest read-modify-write may hold the lock. Generous: the
 * server already retries a stuck upload with backoff. Past it the caller gets an
 * error and the next edit runs; the abandoned upload may still land, which the
 * next edit's own version probe then sees.
 */
export const MANIFEST_EDIT_TIMEOUT_MS = 120_000;

/** The part of the Web Locks API used here. */
export interface ManifestLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

const chains = new Map<string, Promise<unknown>>();

/**
 * One read-modify-write of `owner`'s manifest at a time.
 *
 * Each edit reads the whole manifest and writes the whole manifest, so two
 * running at once build on the same base and the second erases the first's
 * change. That is routine, not rare: one profile Save with a new avatar logs two
 * feeds back to back, fire-and-forget. Web Locks extend this across the
 * account's open tabs where the browser has them; otherwise a per-owner chain
 * covers this tab. Another DEVICE can still race; the thorough base read
 * narrows that, it cannot close it.
 *
 * Exported for tests; `opts` are test seams.
 */
export function withManifestLock<T>(
  owner: string,
  edit: () => Promise<T>,
  opts: { timeoutMs?: number; locks?: ManifestLocks | null } = {},
): Promise<T> {
  const name = `woco:manifest:${owner.toLowerCase()}`;
  const timeoutMs = opts.timeoutMs ?? MANIFEST_EDIT_TIMEOUT_MS;
  const bounded = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`manifest update did not finish within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
      edit().then(resolve, reject).finally(() => clearTimeout(timer));
    });
  const locks = opts.locks === undefined
    ? (globalThis as { navigator?: { locks?: ManifestLocks } }).navigator?.locks
    : opts.locks;
  if (locks) return locks.request(name, bounded);

  const run = (chains.get(name) ?? Promise.resolve()).then(bounded, bounded);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(name, tail);
  void tail.then(() => {
    if (chains.get(name) === tail) chains.delete(name);
  });
  return run;
}

// Backup reads live in backup-inventory.ts (#166 item 4): every consumer of the
// backup list is a security surface, so the lenient collapsed-to-[] readers that
// used to sit here are gone — there is only the tri-state read.

/** Seal + write a manifest to the user's SOC (the shared tail of every mutation).
 *  Returns the feed version written — `rebuildManifest` reports it. */
async function writeUserManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  manifest: UserManifest;
  transport?: SocTransport;
}): Promise<number> {
  const envelope = sealToSelf({
    feedSignerPrivKey: args.signer.privKey,
    parentAddress: args.parentAddress,
    data: args.manifest,
  });
  return writeContentFeed({
    signerPrivKey: args.signer.privKey,
    topic: USER_MANIFEST_TOPIC,
    data: envelope,
    route: FEED_ROUTES.manifest,
    transport: args.transport,
  });
}

// ── Repair path for a FROZEN manifest (#190) ────────────────────────────────
// Every mutator above refuses on `unavailable`, which is right — but when the
// refusal is permanent (`unusableAt`), refusing forever leaves the user with a
// manifest nothing can move: no backup list, no keep-list edits, and a message
// telling them to check their connection. These two primitives are the only way
// out, and they are deliberately split: DIAGNOSE reads and concludes nothing,
// REBUILD writes and is the one destructive step, so the UI can show the user
// what they are about to lose before anything is written.

/**
 * How far back the seed walk looks for a readable copy. A ceiling exists because
 * each step is a real exact-address read: bounded work for a bounded payoff, since
 * a manifest older than a few dozen edits is a poor seed anyway. Every version
 * below the floor is still there — the user just isn't offered it.
 */
export const MANIFEST_REPAIR_WALK_LIMIT = 32;

/**
 * What is wrong with this account's manifest, and what a repair would have to
 * work from.
 *
 * `transient` and `frozen` are the distinction the whole issue is about: only
 * `frozen` may be repaired, because only `frozen` proves the bytes at the latest
 * version will never open. Repairing a `transient` would write a fresh manifest
 * over one that is probably intact — the #171 data loss, entered through the door
 * built to fix it.
 */
export type ManifestDiagnosis =
  | { kind: "ok" }
  | { kind: "absent" }
  | { kind: "transient"; reason?: string }
  | {
      kind: "frozen";
      /** The version that will never open. */
      unusableAt: number;
      /** A later envelope format, not damage — the app is old, so DON'T repair. */
      newerFormat: boolean;
      /** The newest older version that still opens, or null if none was found. */
      seed: { version: number; manifest: UserManifest } | null;
      /** How many versions the walk actually read (0 when it could not run). */
      walked: number;
    };

/**
 * The usability bar a walked candidate must clear — deliberately the SAME bar
 * `readUserManifestResult` applies to the head, so a repair can never seed itself
 * from something the normal read would have rejected. Returns null for anything
 * that read would have called unusable.
 */
function openManifestCandidate(args: {
  signer: ManifestSigner;
  parentAddress: string;
  value: unknown;
}): UserManifest | null {
  if (!isSelfSealedEnvelope(args.value)) return null;
  try {
    const manifest = openFromSelf<UserManifest>({
      feedSignerPrivKey: args.signer.privKey,
      parentAddress: args.parentAddress,
      envelope: args.value as SelfSealedEnvelope,
    });
    if (typeof manifest?.updatedAt !== "number" || !Array.isArray(manifest?.backups)) return null;
    return manifest;
  } catch {
    return null;
  }
}

/** Injected reads (tests only) — production takes the real feed readers. */
type ManifestReader = (args: {
  signer: ManifestSigner;
  parentAddress: string;
}) => Promise<ManifestReadResult>;
type VersionReader = (
  owner: string,
  topic: string,
  version: number,
  opts: { route: FeedRoute; thorough?: boolean },
) => Promise<ContentFeedResult<unknown>>;

/**
 * Classify the manifest, and on a frozen one find the newest older version that
 * still opens. Reads only — nothing here writes, so it is safe to run the moment
 * a read fails.
 *
 * The walk runs ONLY for `frozen`. On a transient fault the versions below the
 * head are just as likely to be unreadable, so walking would spend a pile of
 * network reads to learn nothing — and, worse, would hand the UI a "seed" it
 * could offer as a repair over a manifest that is merely offline.
 */
export async function diagnoseManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  /** Test seam — production always takes the real manifest read. */
  readManifest?: ManifestReader;
  /** Test seam — production always takes the real exact-version read. */
  readAt?: VersionReader;
}): Promise<ManifestDiagnosis> {
  // Thorough, as every manifest read is: a gateway gate refusal reads as ABSENT,
  // and "absent" here would be diagnosed as "nothing to repair".
  const read = await (args.readManifest ?? readUserManifestResult)({
    signer: args.signer,
    parentAddress: args.parentAddress,
  });
  if (read.status === "found") return { kind: "ok" };
  if (read.status === "absent") return { kind: "absent" };
  if (read.unusableAt === undefined) return { kind: "transient", reason: read.reason };

  const unusableAt = read.unusableAt;
  const newerFormat = read.newerFormat === true;
  // Nothing below version 0 exists to walk back to, and the legacy (pre-versioning)
  // stamp is negative for the same reason: there is no earlier copy.
  if (unusableAt < 1) return { kind: "frozen", unusableAt, newerFormat, seed: null, walked: 0 };

  const readAt: VersionReader = args.readAt ??
    ((owner, topic, version, opts) => readContentFeedAtVersion<unknown>(owner, topic, version, opts));
  const floor = Math.max(0, unusableAt - MANIFEST_REPAIR_WALK_LIMIT);
  let walked = 0;
  for (let v = unusableAt - 1; v >= floor; v--) {
    walked++;
    const at = await readAt(args.signer.address, USER_MANIFEST_TOPIC, v, { route: FEED_ROUTES.manifest, thorough: true })
      .catch((e: unknown) => ({ status: "unavailable" as const, reason: String(e) }));
    if (at.status !== "found") continue;
    const manifest = openManifestCandidate({
      signer: args.signer,
      parentAddress: args.parentAddress,
      value: at.value,
    });
    if (manifest) return { kind: "frozen", unusableAt, newerFormat, seed: { version: v, manifest }, walked };
  }
  return { kind: "frozen", unusableAt, newerFormat, seed: null, walked };
}

/**
 * Write a fresh manifest PAST the frozen version, seeded with the copy the user
 * was shown (or empty when there was none). Returns the version written.
 *
 * The re-read is not a formality and must not be optimised away: `diagnoseManifest`
 * and the user's click are separated by however long they spent reading the
 * warning, and in that window the feed may have become readable (a whitelist
 * entry restored, another device's write landing) or merely gone offline. Writing
 * in either case is the #171 loss — a whole-object overwrite of a manifest we
 * never read. Only "still permanently unreadable" authorises this.
 */
export async function rebuildManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  /** The seed `diagnoseManifest` found, or null to start an empty list. */
  seed: UserManifest | null;
  /** Test seam — production always takes the real manifest read. */
  readManifest?: ManifestReader;
  /** Test seam — production always takes the real seal-and-write. */
  write?: (a: { signer: ManifestSigner; parentAddress: string; manifest: UserManifest }) => Promise<number>;
}): Promise<number> {
  return withManifestLock(args.signer.address, () => rebuildManifestNow(args));
}

async function rebuildManifestNow(args: Parameters<typeof rebuildManifest>[0]): Promise<number> {
  const read = await (args.readManifest ?? readUserManifestResult)({
    signer: args.signer,
    parentAddress: args.parentAddress,
  });
  if (read.status !== "unavailable") {
    throw new Error("Your backup list reads fine now, so nothing was rebuilt. Reload the page to see it.");
  }
  if (read.unusableAt === undefined) {
    throw new Error(
      `Couldn't confirm the saved copy is damaged, so nothing was rebuilt (${read.reason ?? "read failed"}). Try again.`,
    );
  }
  // Not damage: a newer app wrote a manifest this build cannot open. Writing a
  // v1 body past it would destroy data the newer client reads fine, so the
  // primitive refuses on its own — the panel's reload-only branch is a courtesy,
  // not the guard.
  if (read.newerFormat) {
    throw new Error(
      "Your backup list was saved by a newer version of WoCo. Reload to update this app. Nothing was rebuilt.",
    );
  }

  const manifest: UserManifest = {
    ...(args.seed ?? { backups: [] }),
    v: USER_MANIFEST_VERSION,
    updatedAt: Date.now(),
  };
  return (args.write ?? writeUserManifest)({
    signer: args.signer,
    parentAddress: args.parentAddress,
    manifest,
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
  /** Test seam — production always posts to our server. */
  transport?: SocTransport;
}): Promise<void> {
  await withManifestLock(args.signer.address, async () => {
    const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
    const g = args.entry.guardianAddress.toLowerCase();
    const kept = (existing?.backups ?? []).filter((b) => b.guardianAddress.toLowerCase() !== g);

    const manifest: UserManifest = {
      ...(existing ?? {}),
      v: USER_MANIFEST_VERSION,
      updatedAt: Date.now(),
      backups: [...kept, { ...args.entry, guardianAddress: g }],
    };
    await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest, transport: args.transport });
  });
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
  /** Test seam — production always posts to our server. */
  transport?: SocTransport;
}): Promise<RetireBackupsResult> {
  return withManifestLock(args.signer.address, async () => {
    const res = await readManifestBase({ signer: args.signer, parentAddress: args.parentAddress });
    if (!res.ok) return "unavailable";
    if (!res.base) return "nothing-to-retire";
    if (!res.base.backups.some((b) => !b.revoked)) return "nothing-to-retire"; // don't churn the feed
    await writeUserManifest({
      signer: args.signer,
      parentAddress: args.parentAddress,
      manifest: retireBackupEntries(res.base),
      transport: args.transport,
    });
    return "retired";
  });
}

/**
 * Retire ONE backup entry after a per-guardian on-chain revoke (#164). Same
 * contract as `retireBackupInventory`: call it only once the revoke is proven
 * on-chain; an unreadable manifest is `"unavailable"`, never a silent success;
 * a manifest that does not list the guardian (or already retired it) is left
 * untouched rather than churned.
 */
export async function retireOneBackup(args: {
  signer: ManifestSigner;
  parentAddress: string;
  guardianAddress: string;
  /** Test seam — production always posts to our server. */
  transport?: SocTransport;
}): Promise<RetireBackupsResult> {
  return withManifestLock(args.signer.address, async () => {
    const res = await readManifestBase({ signer: args.signer, parentAddress: args.parentAddress });
    if (!res.ok) return "unavailable";
    if (!res.base) return "nothing-to-retire";
    const g = args.guardianAddress.toLowerCase();
    if (!res.base.backups.some((b) => b.guardianAddress.toLowerCase() === g && !b.revoked)) {
      return "nothing-to-retire";
    }
    await writeUserManifest({
      signer: args.signer,
      parentAddress: args.parentAddress,
      manifest: retireOneBackupEntry(res.base, g),
      transport: args.transport,
    });
    return "retired";
  });
}

// ── Feed log + trash (Phase 4 — active client-owned content) ────────────────
// Pure transforms live in ops.ts; these wrap them in the read→seal→write cycle.
// All best-effort comfort-layer semantics: callers treat failures as non-fatal.

/** Upsert an active-feed entry; displaced refs move to trash (see ops.ts). */
export async function upsertFeedEntry(args: {
  signer: ManifestSigner;
  parentAddress: string;
  entry: ManifestFeedEntry;
  /** Test seam — production always posts to our server. */
  transport?: SocTransport;
}): Promise<void> {
  await withManifestLock(args.signer.address, async () => {
    const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
    const manifest = mergeFeedEntry(existing, args.entry);
    await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest, transport: args.transport });
  });
}

/** Move a whole feed entry to trash (restorable until the old batch dies). */
export async function trashFeedEntryOnManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  kind: ManifestFeedKind;
  topic: string;
  /** Test seam — production always posts to our server. */
  transport?: SocTransport;
}): Promise<void> {
  await withManifestLock(args.signer.address, async () => {
    const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
    const manifest = removeFeedEntry(existing, args.kind, args.topic);
    await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest, transport: args.transport });
  });
}

/** Restore a whole-feed trash entry back into the active log. */
export async function restoreFeedEntryOnManifest(args: {
  signer: ManifestSigner;
  parentAddress: string;
  kind: ManifestFeedKind;
  topic: string;
  /** Test seam — production always posts to our server. */
  transport?: SocTransport;
}): Promise<void> {
  await withManifestLock(args.signer.address, async () => {
    const existing = await manifestBaseForWrite({ signer: args.signer, parentAddress: args.parentAddress });
    const manifest = restoreFeedEntry(existing, args.kind, args.topic);
    await writeUserManifest({ signer: args.signer, parentAddress: args.parentAddress, manifest, transport: args.transport });
  });
}
