/**
 * Likes index — server projection of on-chain EAS truth.
 *
 * The chain is authoritative: a like is an EAS attestation, an unlike is a
 * revoke. This store is a fast read cache the UI hits instead of scanning the
 * chain. It's only ever written AFTER the route has verified the attestation
 * on-chain (`EAS.getAttestation` — attester == authenticated parent, schema +
 * subject match). Mirrors the reconciled `.data/sub-ens-owners.json` pattern.
 *
 * Storage: in-memory Map (composite key `subject:attester`) backed by a JSON
 * file so the projection survives restarts. Mutators are serialised per-subject
 * via an in-memory mutex (same shape as reservation-store's per-series lock) so
 * concurrent record/remove for one subject can't corrupt its attester set.
 *
 * We store only ACTIVE likes — unlike DELETES the entry. The on-chain
 * Attested/Revoked log is the durable audit trail; the projection just needs
 * the current edge set. The composite key structurally enforces "one active
 * like per (attester, subject)" (dedup-on-count).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hex0x, LikeSubject, LikeCount, TrendingSubject } from "@woco/shared";
import { SubjectType } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "likes-index.json");

interface StoredLike {
  subject: Hex0x; // lowercase bytes32
  subjectType: SubjectType;
  attester: Hex0x; // lowercase address
  uid: Hex0x; // lowercase bytes32 — the EAS attestation UID
  createdAt: string;
}

const likes = new Map<string, StoredLike>();
let loaded = false;

const key = (subject: string, attester: string) =>
  `${subject.toLowerCase()}:${attester.toLowerCase()}`;
const lower = (s: string) => s.toLowerCase() as Hex0x;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const arr = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as StoredLike[];
    for (const l of arr) likes.set(key(l.subject, l.attester), l);
    console.log(`[likes] Loaded ${likes.size} likes from disk`);
  } catch {
    // File doesn't exist yet — fine.
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify([...likes.values()]), "utf-8");
  } catch (err) {
    console.error("[likes] Failed to persist to disk:", err);
  }
}

/** Per-subject mutex: serialises record/remove for a single subject. */
const subjectLocks = new Map<string, Promise<void>>();
function withSubjectLock<T>(subject: string, fn: () => Promise<T> | T): Promise<T> {
  const k = subject.toLowerCase();
  const prev = subjectLocks.get(k) ?? Promise.resolve();
  const next = prev.then(() => fn());
  subjectLocks.set(k, next.then(() => {}, () => {}));
  return next as Promise<T>;
}

/** True if this attester already has an active like on this subject. */
export function hasActiveLike(subject: string, attester: string): boolean {
  ensureLoaded();
  return likes.has(key(subject, attester));
}

/**
 * Record (or refresh) an active like. Upsert keyed by (subject, attester), so
 * a re-record from the same attester just refreshes the stored uid rather than
 * duplicating. Caller MUST have verified the attestation on-chain first.
 */
export function recordLike(input: {
  subject: string;
  subjectType: SubjectType;
  attester: string;
  uid: string;
}): Promise<void> {
  ensureLoaded();
  return withSubjectLock(input.subject, () => {
    likes.set(key(input.subject, input.attester), {
      subject: lower(input.subject),
      subjectType: input.subjectType,
      attester: lower(input.attester),
      uid: lower(input.uid),
      createdAt: new Date().toISOString(),
    });
    persistToDisk();
  });
}

/**
 * Replace the entire projection with the active edge set returned by an
 * on-chain reconcile. The chain is authoritative, so a reconcile is allowed to
 * drop locally-cached edges that no longer exist on-chain. Used by the
 * decentralisation backstop (eas-onchain.reconcileFromChain).
 */
export function reconcileInto(
  active: { subject: string; subjectType: SubjectType; attester: string; uid: string }[],
): void {
  ensureLoaded();
  likes.clear();
  const now = new Date().toISOString();
  for (const l of active) {
    likes.set(key(l.subject, l.attester), {
      subject: lower(l.subject),
      subjectType: l.subjectType,
      attester: lower(l.attester),
      uid: lower(l.uid),
      createdAt: now,
    });
  }
  persistToDisk();
}

/** Remove an attester's active like on a subject (unlike). Idempotent. */
export function removeLike(subject: string, attester: string): Promise<void> {
  ensureLoaded();
  return withSubjectLock(subject, () => {
    if (likes.delete(key(subject, attester))) persistToDisk();
  });
}

/** Look up the stored UID for an attester's active like (needed to revoke). */
export function getLikeUid(subject: string, attester: string): Hex0x | null {
  ensureLoaded();
  return likes.get(key(subject, attester))?.uid ?? null;
}

/** Count + viewer state for one subject. */
export function getLikeCount(subject: string, viewer?: string): LikeCount {
  ensureLoaded();
  const s = subject.toLowerCase();
  let count = 0;
  let subjectType: SubjectType = SubjectType.Profile;
  for (const l of likes.values()) {
    if (l.subject === s) {
      count++;
      subjectType = l.subjectType;
    }
  }
  return {
    subject: lower(subject),
    subjectType,
    count,
    likedByViewer: viewer ? hasActiveLike(subject, viewer) : false,
  };
}

/** Subjects liked by an address (the "Following" view). */
export function getFollowing(attester: string): LikeSubject[] {
  ensureLoaded();
  const a = attester.toLowerCase();
  const out: LikeSubject[] = [];
  for (const l of likes.values()) {
    if (l.attester === a) out.push({ type: l.subjectType, id: l.subject });
  }
  return out;
}

/**
 * Top subjects by like count (server projection; Stylus #5 is the trustless
 * version). Optionally filtered by subjectType.
 */
export function getTrending(subjectType?: SubjectType, limit = 20): TrendingSubject[] {
  ensureLoaded();
  const counts = new Map<string, { subjectType: SubjectType; count: number }>();
  for (const l of likes.values()) {
    if (subjectType !== undefined && l.subjectType !== subjectType) continue;
    const cur = counts.get(l.subject);
    if (cur) cur.count++;
    else counts.set(l.subject, { subjectType: l.subjectType, count: 1 });
  }
  return [...counts.entries()]
    .map(([subject, v]) => ({ subject: lower(subject), subjectType: v.subjectType, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
