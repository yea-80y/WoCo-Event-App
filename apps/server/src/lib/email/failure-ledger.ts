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
const MAX_ENTRIES = 1000;
/** Entries older than this are pruned on write. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type FailureKind = "transactional" | "marketing";

export interface EmailFailure {
  id: string;
  ts: string;
  kind: FailureKind;
  /** Present for `transactional` only — see PLAINTEXT POLICY above. */
  recipient?: string;
  recipientHash: string;
  subject: string;
  provider: string;
  /** Provider error name/code where available, e.g. `MessageRejected`. */
  code?: string;
  error: string;
  attempts: number;
  /** Whether the classifier thought a later retry could succeed. */
  retryable: boolean;
  /** Free-form breadcrumbs from the caller, e.g. `{ eventId, seriesId }`. */
  context?: Record<string, string>;
  resolvedAt?: string;
  resolvedBy?: string;
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
    entries = Array.isArray(parsed) ? (parsed as EmailFailure[]) : [];
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

function prune(nowMs: number): void {
  const cutoff = nowMs - RETENTION_MS;
  entries = entries.filter((e) => Date.parse(e.ts) >= cutoff);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
}

export interface RecordFailureInput {
  kind: FailureKind;
  recipient: string;
  recipientHash: string;
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
  const entry: EmailFailure = {
    id: `${nowMs.toString(36)}-${(seq++).toString(36)}`,
    ts: new Date(nowMs).toISOString(),
    kind: input.kind,
    ...(input.kind === "transactional" ? { recipient: input.recipient } : {}),
    recipientHash: input.recipientHash,
    subject: input.subject.slice(0, 200),
    provider: input.provider,
    ...(input.code ? { code: input.code } : {}),
    error: input.error.slice(0, 500),
    attempts: input.attempts,
    retryable: input.retryable,
    ...(input.context ? { context: input.context } : {}),
  };

  entries.unshift(entry);
  prune(nowMs);

  // Loud, and with the hash not the address: docker logs outlive the send.
  console.error(
    `[email-failures] ${input.kind} email to ${input.recipientHash.slice(0, 8)}… ` +
      `abandoned after ${input.attempts} attempt(s) via ${input.provider}: ${input.error}`,
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

/** Tests only — clears memory AND disk, so suites start from empty. */
export function _resetForTest(): void {
  entries = [];
  loaded = true;
  seq = 0;
  persist();
}

/**
 * Tests only — drops the in-memory copy WITHOUT touching disk, so the next read
 * reloads from the file. Models a process restart.
 */
export function _reloadForTest(): void {
  entries = [];
  loaded = false;
}
