/**
 * Durable record of email that we gave up on.
 *
 * The failure this exists for: `stripe.ts` fired ticket email with
 * `.catch(err => console.error(...))`. A buyer paid, the send failed, the
 * evidence went to docker logs, and nobody found out until the buyer complained
 * at the door. Retries (see `send.ts`) handle the transient case; this handles
 * the case where retries are exhausted or the failure is permanent, so an
 * undelivered ticket is a queryable fact instead of a log line.
 *
 * PLAINTEXT POLICY. `transactional` entries keep the recipient address;
 * `marketing` entries keep only the HMAC hash.
 *
 * The split is deliberate and not merely conservative. Remediating a failed
 * TICKET means contacting the buyer, and nothing else on disk can recover their
 * address — the claimers feed stores `emailHash` too, so a hash-only record
 * would be unactionable and the person who paid would simply never get their
 * ticket. That processing is Art. 6(1)(b) (performance of the contract they just
 * entered). A failed MARKETING send has no such duty: the organiser still holds
 * the list, so the hash is enough to identify the gap without us keeping a
 * plaintext copy the rest of the marketing path deliberately avoids.
 *
 * MUST survive restarts, and is chmod 0600 — same class as the other `.data`
 * compliance stores (see docs/PAYOUTS.md §8).
 */

import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";

const DATA_DIR = join(process.cwd(), ".data");
const STORE_FILE = join(DATA_DIR, "email-failures.json");

/** Newest-first cap. Bounds the file; older detail is in the logs. */
const DEFAULT_MAX_ENTRIES = 1000;
let MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
/** Entries older than this are pruned on write. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type FailureKind = "transactional" | "marketing";

/**
 * One addressee of a failed message.
 *
 * A pair rather than two parallel arrays because erasure has to remove ONE
 * subject's plaintext from a message that may have had several: with parallel
 * arrays the index alignment is an invariant nothing enforces, and getting it
 * wrong deletes the wrong person's address while reporting success.
 */
export interface FailureRecipient {
  hash: string;
  /** Present for `transactional` only — see PLAINTEXT POLICY above. */
  address?: string;
}

export interface EmailFailure {
  id: string;
  ts: string;
  kind: FailureKind;
  /**
   * EVERY addressee, not just the first. `msg.to` is an array and a
   * multi-recipient transactional send (one order, two ticket holders) would
   * otherwise record recipient 1 and lose 2..n — an evidence record that is
   * quietly incomplete is worse than one that is obviously missing.
   */
  recipients: FailureRecipient[];
  subject: string;
  provider: string;
  /** Provider error name/code where available, e.g. `MessageRejected`. */
  code?: string;
  error: string;
  /** Real provider calls made, summed across the primary and any failover. */
  attempts: number;
  /** Whether the classifier thought a later retry could succeed. */
  retryable: boolean;
  /** Free-form breadcrumbs from the caller, e.g. `{ eventId, seriesId }`. */
  context?: Record<string, string>;
  /** Automatic retries the drain worker has made since the entry was written. */
  retries?: number;
  lastRetryAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

/** Pre-2026-08 on-disk shape: one recipient per entry, in two flat fields. */
interface LegacyEmailFailure extends Omit<EmailFailure, "recipients"> {
  recipients?: FailureRecipient[];
  recipient?: string;
  recipientHash?: string;
}

/**
 * Bring a record written by the single-recipient version forward.
 *
 * Done on read rather than by a migration script because the file is live in
 * production and a loader that treats an old entry as malformed would drop
 * evidence of an undelivered paid ticket at exactly the moment it is needed.
 */
function normalise(raw: LegacyEmailFailure): EmailFailure {
  const { recipient, recipientHash, ...rest } = raw;
  if (Array.isArray(raw.recipients)) return rest as EmailFailure;
  return {
    ...(rest as Omit<EmailFailure, "recipients">),
    recipients: recipientHash
      ? [{ hash: recipientHash, ...(recipient ? { address: recipient } : {}) }]
      : [],
  };
}

/**
 * Anything email-shaped inside a provider diagnostic.
 *
 * Provider error strings quote the address back at us — SES returns
 * `smtp; 550 5.1.1 <user@example.com>: Recipient address rejected`, and
 * `MessageRejected` names the unverified address. Left alone that plaintext
 * reaches three places it must not: a `marketing` entry, which the PLAINTEXT
 * POLICY above says holds only the hash; the `console.error` below, which
 * `routes/ses-webhook.ts` promises never logs plaintext; and
 * `GET /api/ops/email-failures`, whose whole design is that the LIST is
 * redacted and plaintext costs a second, logged request.
 *
 * It also defeats erasure: `eraseRecipient` deletes `recipients[].address` and
 * cannot reach a copy embedded in `error`, so an Art. 17 request would report
 * success while the address survived in the same record.
 *
 * Transactional entries lose nothing — the address is in `recipients[].address`,
 * which is the field erasure knows how to remove.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function redactAddresses(text: string): string {
  return text.replace(EMAIL_IN_TEXT, "[address-redacted]");
}

let entries: EmailFailure[] = [];
let loaded = false;
/** Monotonic suffix so two failures inside the same millisecond cannot collide. */
let seq = 0;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as unknown;
    entries = Array.isArray(parsed) ? (parsed as LegacyEmailFailure[]).map(normalise) : [];
    if (entries.length) {
      console.warn(
        `[email-failures] Loaded ${entries.length} undelivered email record(s) from disk — ` +
          `${entries.filter((e) => !e.resolvedAt).length} unresolved`,
      );
    }
  } catch {
    entries = [];
  }
}

function persist(): boolean {
  const ok = writeJsonAtomic(STORE_FILE, entries, "email-failures");
  if (ok) {
    // writeJsonAtomic creates the temp file at the process umask (0644 in the
    // container). This file holds buyer addresses; tighten it every write rather
    // than relying on an ops step that has been missed before.
    try {
      chmodSync(STORE_FILE, 0o600);
    } catch {
      // Non-fatal: the record landing matters more than the mode. An operator
      // sweep (CLAUDE.local.md) catches a file that somehow stayed readable.
    }
  }
  return ok;
}

/**
 * Age out old entries, then cap the file — but NEVER evict an unresolved
 * transactional failure by size.
 *
 * A plain newest-1000 slice had a nasty property: one failed 1,000-recipient
 * broadcast (SES account paused — exactly when transactional sends are failing
 * too) writes 1,000 marketing entries, pushes every prior transactional entry
 * out, and `failureHealth()` flips back to `ok: true`. Unrelated bulk failures
 * would silently clear the alarm for "somebody paid and has no ticket".
 *
 * Retention still applies to everything: an unresolved entry ages out at 90
 * days like any other, so this cannot grow without bound.
 */
function prune(nowMs: number): void {
  const cutoff = nowMs - RETENTION_MS;
  entries = entries.filter((e) => Date.parse(e.ts) >= cutoff);
  if (entries.length <= MAX_ENTRIES) return;

  const protectedEntries: EmailFailure[] = [];
  const evictable: EmailFailure[] = [];
  for (const e of entries) {
    (e.kind === "transactional" && !e.resolvedAt ? protectedEntries : evictable).push(e);
  }
  const room = Math.max(0, MAX_ENTRIES - protectedEntries.length);
  // Rebuild newest-first across both groups so the file stays chronological.
  entries = [...protectedEntries, ...evictable.slice(0, room)].sort(
    (a, b) => Date.parse(b.ts) - Date.parse(a.ts),
  );
}

export interface RecordFailureInput {
  kind: FailureKind;
  /** Plaintext addresses, in `msg.to` order. Stored only for `transactional`. */
  recipients: string[];
  /** HMAC hashes, index-aligned with `recipients`. */
  recipientHashes: string[];
  subject: string;
  provider: string;
  error: string;
  code?: string;
  attempts: number;
  retryable: boolean;
  context?: Record<string, string>;
}

/**
 * Record an email we could not deliver.
 *
 * Returns the stored entry. Never throws: this is the last line of the error
 * path, and an exception here would replace a recorded failure with an
 * unrecorded one.
 */
export function recordFailure(input: RecordFailureInput): EmailFailure {
  ensureLoaded();
  const nowMs = Date.now();
  const error = redactAddresses(input.error);
  const entry: EmailFailure = {
    id: `${nowMs.toString(36)}-${(seq++).toString(36)}`,
    ts: new Date(nowMs).toISOString(),
    kind: input.kind,
    recipients: input.recipientHashes.map((hash, i) => ({
      hash,
      ...(input.kind === "transactional" && input.recipients[i]
        ? { address: input.recipients[i]! }
        : {}),
    })),
    subject: input.subject.slice(0, 200),
    provider: input.provider,
    ...(input.code ? { code: input.code } : {}),
    error: error.slice(0, 500),
    attempts: input.attempts,
    retryable: input.retryable,
    ...(input.context ? { context: input.context } : {}),
  };

  entries.unshift(entry);
  prune(nowMs);

  // Loud, and with the hash not the address: docker logs outlive the send.
  const who = entry.recipients.map((r) => `${r.hash.slice(0, 8)}…`).join(", ") || "(no recipient)";
  console.error(
    `[email-failures] ${input.kind} email to ${who} ` +
      `abandoned after ${input.attempts} attempt(s) via ${input.provider}: ${error}`,
  );

  persist();
  return entry;
}

/** Unresolved failures, newest first. Backs the ops view and /api/health. */
export function listFailures(opts: { includeResolved?: boolean; limit?: number } = {}): EmailFailure[] {
  ensureLoaded();
  const rows = opts.includeResolved ? entries : entries.filter((e) => !e.resolvedAt);
  return rows.slice(0, opts.limit ?? 100);
}

/**
 * Record that the drain worker tried this entry again and failed.
 *
 * Updates the EXISTING entry rather than writing a new one. A retry that went
 * back through `sendVia` would append a fresh failure per attempt: five backoff
 * rounds over a thirty-message outage is 150 records, each transactional one
 * holding another plaintext copy of the buyer's address, and each exempt from
 * the size cap because unresolved transactional entries are protected from
 * eviction. One incident has to stay one row.
 */
export function bumpRetry(id: string, error: string): boolean {
  ensureLoaded();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.resolvedAt) return false;
  entry.retries = (entry.retries ?? 0) + 1;
  entry.lastRetryAt = new Date().toISOString();
  entry.attempts += 1;
  entry.error = redactAddresses(error).slice(0, 500);
  return persist();
}

/** Mark an entry handled (resent by hand, buyer contacted, address dead). */
export function resolveFailure(id: string, by: string): boolean {
  ensureLoaded();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.resolvedAt) return false;
  entry.resolvedAt = new Date().toISOString();
  entry.resolvedBy = by;
  return persist();
}

export interface FailureHealth {
  ok: boolean;
  unresolved: number;
  unresolvedTransactional: number;
  oldestUnresolved?: string;
}

/**
 * For /api/health. `ok` goes false on ANY unresolved transactional failure —
 * one person who paid and has no ticket is already a production incident.
 */
export function failureHealth(): FailureHealth {
  ensureLoaded();
  const unresolved = entries.filter((e) => !e.resolvedAt);
  const transactional = unresolved.filter((e) => e.kind === "transactional");
  return {
    ok: transactional.length === 0,
    unresolved: unresolved.length,
    unresolvedTransactional: transactional.length,
    ...(unresolved.length ? { oldestUnresolved: unresolved[unresolved.length - 1]!.ts } : {}),
  };
}

/**
 * Art. 17 erasure: strip the plaintext recipient from every entry for this
 * address, keeping the hash and the operational record.
 *
 * Redaction rather than deletion, for the same reason suppression marks are
 * never deleted: the fact that a delivery failed is an operational record we
 * are entitled to keep, while the address is the personal data the subject
 * asked us to erase. Keeping the hash also means a later erasure request for
 * the same address still matches. Entries are marked resolved because the
 * remediation path — contacting the buyer — is exactly what erasure forecloses.
 *
 * @returns how many entries were redacted.
 */
export function eraseRecipient(emailHash: string): number {
  ensureLoaded();
  let redacted = 0;
  for (const entry of entries) {
    const match = entry.recipients.find((r) => r.hash === emailHash && r.address !== undefined);
    if (!match) continue;
    // Only THIS subject's address. A co-addressee of the same message made no
    // erasure request, and their ticket is still undelivered.
    delete match.address;
    if (!entry.resolvedAt) {
      entry.resolvedAt = new Date().toISOString();
      entry.resolvedBy = "erasure";
    }
    redacted++;
  }
  if (redacted) persist();
  return redacted;
}

/** Every entry naming this address, whether or not the plaintext survives. */
export function failuresForHash(emailHash: string): EmailFailure[] {
  ensureLoaded();
  return entries.filter((e) => e.recipients.some((r) => r.hash === emailHash));
}

/** Tests only — clears memory AND disk, so suites start from empty. */
export function _resetForTest(): void {
  entries = [];
  loaded = true;
  seq = 0;
  MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
  persist();
}

/**
 * Tests only — shrink the cap so eviction behaviour can be exercised without
 * writing 1,000+ entries. Each write is an fsync over the whole array, so
 * flooding at the real cap is O(n²) and takes ~100s.
 */
export function _setMaxEntriesForTest(n: number): void {
  MAX_ENTRIES = n;
}

/**
 * Tests only — drops the in-memory copy WITHOUT touching disk, so the next read
 * reloads from the file. Models a process restart.
 */
export function _reloadForTest(): void {
  entries = [];
  loaded = false;
}
