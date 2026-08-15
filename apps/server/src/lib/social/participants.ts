/**
 * Who to read — the participant registry.
 *
 * A tally is a function of the statements ingested, and ingesting requires
 * knowing whose feeds to open. Feed topics resolve inside an OWNER's address
 * space (`chunk address = keccak256(identifier || owner)`), so the same topic
 * string names a different chunk per person: without a set of owners there is
 * no address to read, and the count is not "empty", it is uncomputable.
 *
 * HOW OWNERS GET HERE, and why it needs no new trust. The relay sees every
 * client-signed SOC it stamps, but only as (owner, identifier, bytes) — the
 * identifier is a hash, so the topic cannot be inverted from it. The payload,
 * however, is self-describing: a public statement carries its own `format` and
 * `subject`, which is everything needed to recompute the topic later. So the
 * registry is populated by READING what we were already asked to store, not by
 * trusting a client-supplied label.
 *
 * ENCRYPTED STATEMENTS ARE REFUSED STRUCTURALLY, not incidentally — see
 * {@link looksSealed}. It is tempting to say an encrypted payload is opaque to
 * us and therefore stops here by itself. That is false, and believing it is how
 * the privacy property would later be lost.
 *
 * REBUILDABILITY (commitment 6). This file is a cache, not truth. Losing it
 * shrinks the index to whoever writes next — bad, not fatal, and honest to say
 * out loud. The intended recovery is the `participants` list inside an evidence
 * manifest, which is why that field exists.
 *
 * State that honestly, though: nothing durably PUBLISHES a manifest today.
 * `/api/social/manifest` computes one on demand from this very registry, so if
 * this file is lost the manifest can no longer name what was lost either.
 * Recovery therefore depends on someone having fetched and kept a manifest
 * while the registry was intact. Publishing manifests to Swarm is the
 * `SWARM_SOCIAL_PLAN` P1.5 step; until it lands, "published" means "served".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const STORE_FILE = join(process.cwd(), ".data", "social-participants.json");

/** format -> subject -> feed owners known to have written about it. */
type Registry = Record<string, Record<string, string[]>>;

/** Statement formats the relay may register. Public types only. */
const INDEXABLE_FORMATS = new Set(["woco.like.v1", "woco.follow.v1", "woco.credit.v1"]);

/**
 * A sealed statement must NEVER be registered — registering one publishes the
 * (subject, feed owner) pair through the manifest's participant list, which is
 * precisely the participation fact the salted private topic exists to hide.
 *
 * This is a STRUCTURAL refusal, and it needs to be. It would be easy to assume
 * an encrypted payload is simply unreadable to us and stops here on its own —
 * it does not. A `SealedBox` is `{ephemeralPublicKey, iv, ciphertext}`: plain
 * JSON that parses perfectly well. Today it is filtered only because it happens
 * to carry no `format` key, which is a coincidence of the envelope's shape
 * rather than a property anyone guaranteed. Add a cleartext routing hint to
 * that envelope — a reasonable-looking change for client-side dispatch — and
 * every private credit would start flowing into the registry silently, with the
 * counts still perfectly correct and the privacy property simply gone.
 *
 * So the sealed shape is recognised and rejected on its own terms, before any
 * format check, and this stays true whatever fields the envelope later grows.
 */
function looksSealed(o: Record<string, unknown>): boolean {
  return typeof o.ephemeralPublicKey === "string" && typeof o.ciphertext === "string" && typeof o.iv === "string";
}

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;
const OWNER_RE = /^0x[0-9a-f]{40}$/;

/**
 * Capacity bounds. This registry grows with participation and never shrinks, so
 * "it is only a cache" is not on its own a reason to leave it open-ended: an
 * unbounded in-memory structure that is also rewritten to disk has two costs
 * that both scale with it.
 *
 * The numbers are sized well above any plausible pilot (a stream-day audience
 * is thousands, not tens of thousands) and are a CEILING, not a target. Hitting
 * one is a signal worth logging rather than a condition to handle silently —
 * and the consequence of hitting it is a smaller index, never a failed write.
 */
const MAX_PARTICIPANTS_PER_SUBJECT = 50_000;
const MAX_SUBJECTS_PER_FORMAT = 10_000;

/**
 * Minimum gap between disk writes. Persisting on EVERY new participant means a
 * full rewrite of the whole registry per first-time write for a subject, which
 * is quadratic in the number of participants across a busy day. Coalescing
 * costs at most this long of in-memory-ahead-of-disk, which for a rebuildable
 * cache is the right trade.
 */
const PERSIST_DEBOUNCE_MS = 2_000;

let registry: Registry = load();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistPending = false;
/**
 * Serialises the disk writes themselves. There is no read-modify-write of the
 * FILE to protect — the in-memory registry is the single authority and
 * `persist` writes a snapshot of it — so the hazard is narrower and different:
 * two overlapping async writes could land out of order, leaving an OLDER
 * snapshot on disk than one already written. Chaining orders them.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function load(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Registry) : {};
  } catch {
    // Absent on first boot, and unreadable is treated the same way ON PURPOSE:
    // there is nothing to protect here, and refusing to start over a cache
    // would be worse than rebuilding it from the next writes.
    return {};
  }
}

/**
 * Register a feed owner as having written about a subject, if the bytes we were
 * asked to stamp turn out to be a public statement.
 *
 * Never throws and never blocks the write it observes. This is bookkeeping for
 * a view-plane cache; a failure here must not fail a user's like.
 */
export function observeStatementBytes(ownerHex: string, payload: Uint8Array): void {
  try {
    const owner = (ownerHex.startsWith("0x") ? ownerHex : `0x${ownerHex}`).toLowerCase();
    if (!OWNER_RE.test(owner)) return;

    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (!parsed || typeof parsed !== "object") return;
    const o = parsed as Record<string, unknown>;

    if (looksSealed(o)) return; // see looksSealed — checked BEFORE format

    const format = o.format;
    const subject = o.subject;
    if (typeof format !== "string" || !INDEXABLE_FORMATS.has(format)) return;
    if (typeof subject !== "string" || !SUBJECT_RE.test(subject)) return;

    const owners = registry[format]?.[subject];
    if (owners?.includes(owner)) return; // already known — no write, no churn

    registry[format] ??= {};
    const bySubject = registry[format]!;

    // Refuse to grow past the ceilings rather than trimming: dropping a subject
    // or an owner already in the set would silently un-index someone who is
    // genuinely there, which is worse than declining to add one more.
    if (!bySubject[subject] && Object.keys(bySubject).length >= MAX_SUBJECTS_PER_FORMAT) {
      console.warn(`[social] subject ceiling reached for ${format} — not indexing ${subject}`);
      return;
    }
    const list = (bySubject[subject] ??= []);
    if (list.length >= MAX_PARTICIPANTS_PER_SUBJECT) {
      console.warn(`[social] participant ceiling reached for ${format} ${subject} — not indexing ${owner}`);
      return;
    }

    list.push(owner);
    schedulePersist();
  } catch {
    // Not JSON, sealed, or malformed — all mean "not an indexable statement".
  }
}

/**
 * Coalesced write. Never awaited by a caller: this observes a user's write and
 * must not extend it, so a slow or failing disk costs index freshness rather
 * than the write it was watching. `writeJsonAtomic` already reports its own
 * failures loudly and returns false rather than throwing.
 */
function schedulePersist(): void {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (!persistPending) return;
    persistPending = false;
    persist();
  }, PERSIST_DEBOUNCE_MS);
  // Do not hold the process open for a cache flush.
  persistTimer.unref?.();
}

function persist(): void {
  const snapshot: Registry = JSON.parse(JSON.stringify(registry));
  writeChain = writeChain
    .catch(() => undefined)
    .then(() => {
      writeJsonAtomic(STORE_FILE, snapshot, "social-participants");
    });
}

/** Feed owners known to have written about `subject` under `format`. */
export function participantsFor(format: string, subject: string): string[] {
  return [...(registry[format]?.[subject.toLowerCase()] ?? [])].sort();
}

/** Every subject we hold participants for, under a format. */
export function knownSubjects(format: string): string[] {
  return Object.keys(registry[format] ?? {}).sort();
}

/**
 * Merge participants recovered from a published evidence manifest. This is the
 * rebuild path: an operator (or another indexer) can restore the input set from
 * public data rather than from our disk.
 */
export function mergeParticipants(format: string, subject: string, owners: readonly string[]): number {
  if (!INDEXABLE_FORMATS.has(format) || !SUBJECT_RE.test(subject)) return 0;
  registry[format] ??= {};
  const bySubject = registry[format]!;

  // The SAME ceilings the relay path enforces. An operator restoring several
  // manifests is exactly how the declared bound would otherwise be exceeded,
  // and a ceiling one entry point ignores is not a ceiling — it is a comment.
  if (!bySubject[subject] && Object.keys(bySubject).length >= MAX_SUBJECTS_PER_FORMAT) {
    console.warn(`[social] subject ceiling reached for ${format} — refusing to restore ${subject}`);
    return 0;
  }
  const list = (bySubject[subject] ??= []);

  // Set membership rather than `Array.includes` in the loop: a restore is the
  // one path that arrives with thousands of addresses at once, which is where
  // the quadratic scan would actually bite.
  const seen = new Set(list);
  let added = 0;
  for (const raw of owners) {
    if (list.length >= MAX_PARTICIPANTS_PER_SUBJECT) {
      console.warn(`[social] participant ceiling reached for ${format} ${subject} — restore truncated`);
      break;
    }
    const owner = raw.toLowerCase();
    if (!OWNER_RE.test(owner) || seen.has(owner)) continue;
    seen.add(owner);
    list.push(owner);
    added++;
  }
  if (added > 0) schedulePersist();
  return added;
}

/** Test seam — resets in-memory state without touching disk. */
export function __resetParticipants(next: Registry = {}): void {
  registry = next;
}
