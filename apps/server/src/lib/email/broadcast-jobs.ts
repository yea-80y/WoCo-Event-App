/**
 * Broadcast job store — recipients held server-side while a bulk send drains.
 *
 * WHY THIS EXISTS. A broadcast cannot run inside an HTTP request. At the
 * account send rate (12/s) a 1,000-recipient send takes ~83s against
 * Cloudflare's 125s origin timeout, and our own 20,000 list cap takes ~28
 * minutes. Raising limits does not help: the 524 is Enterprise-only to raise,
 * and even at 100/s — 7× the SES grant — a full-list send exceeds the timeout.
 * There is no send rate at which a bulk send fits inside a request.
 *
 * WHY IT HOLDS PLAINTEXT. Contact lists are ECIES-sealed CLIENT-SIDE to the
 * organiser's X25519 key. The server holds an opaque blob plus HMAC hashes and
 * cannot decrypt, so "send to list N and let the server enumerate" is not
 * buildable — the client posting plaintext recipients is not an accident of the
 * design, it is the only party that can. A background job therefore has to hold
 * those addresses until it drains, turning a per-request exposure into a
 * first-party copy that lives for up to ~an hour. That is defensible where the
 * rejected third-party version was not (we are the processor the organiser
 * already instructed, same data, same purpose, bounded in time) — but only
 * under the conditions this module implements:
 *
 *   1. Chunks are AES-256-GCM ciphertext under a key generated at process start
 *      and NEVER written down. The point is not the running VM — an attacker
 *      with `.data/` also has `server.env`. The point is BACKUPS: any rsync, VM
 *      snapshot or disk image that catches a chunk file catches ciphertext
 *      nobody will ever hold the key for, including us.
 *   2. A chunk is deleted the moment it has drained, not at job completion.
 *   3. A hard TTL destroys the payload whether or not the job finished, and it
 *      is a FORMULA (2× expected drain time) rather than a number that would
 *      fossilise today's list cap.
 *   4. `sentHashes` is durable and hash-only, so a job killed by a restart can
 *      report "died with N unsent" and be resumed without mailing anyone twice.
 *
 * Consequence of (1), stated plainly: a restart kills every in-flight job. That
 * is the cost of the property, and it is why `died` is surfaced loudly rather
 * than left for an organiser to notice.
 *
 * See docs/SES_MIGRATION_HANDOVER.md §6 and docs/legal/DATA_INVENTORY.md §3.1.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeJsonAtomic } from "../marketing/persist.js";
import { effectiveSendRate } from "./rate-limiter.js";

const DATA_DIR = join(process.cwd(), ".data");
const JOBS_DIR = join(DATA_DIR, "broadcast-jobs");
const CHUNKS_DIR = join(DATA_DIR, "broadcast-chunks");

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Recipients per chunk upload. Also the blast radius of a mid-chunk crash. */
export const MAX_CHUNK_RECIPIENTS = 500;
/** Chunks per job — 200 × 500 = 100,000, comfortably above the 20k list cap. */
export const MAX_CHUNKS = 200;

/**
 * How long a half-uploaded job may keep plaintext before it is destroyed.
 *
 * Without this, an organiser who uploads three chunks and closes the tab leaves
 * recipient data on disk until the next restart — unbounded in time, which is
 * exactly what the TTL condition exists to prevent. Refreshed on every chunk,
 * so a slow upload is not punished.
 */
const DRAFT_TTL_MS = 15 * 60_000;

/** Floor on the drain TTL — a small job still needs room to be scheduled. */
const MIN_DRAIN_TTL_MS = 15 * 60_000;
/**
 * Ceiling. NOT generous on purpose: the legal position is "bounded in time",
 * and the only way to reach hours here is someone turning the send rate right
 * down for warm-up — precisely when we least want plaintext lingering. If a job
 * legitimately needs longer than this, the rate config is the thing to fix.
 */
const MAX_DRAIN_TTL_MS = 4 * 60 * 60_000;

/** How long the hash-only record survives after the payload is gone. Resume window. */
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Records kept per organiser, newest first, on top of the retention window. */
const RECORDS_PER_ORG = 20;

/** Persisted per-recipient error strings. Hash-prefixed, never plaintext. */
const MAX_STORED_ERRORS = 20;

// ---------------------------------------------------------------------------
// Payload encryption
// ---------------------------------------------------------------------------

/**
 * Generated once per process, held in memory, never persisted. Losing it on
 * restart is the designed behaviour, not an oversight — see the header.
 */
const PAYLOAD_KEY = randomBytes(32);
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * `iv || tag || ciphertext`, with the job id and chunk index as additional
 * authenticated data. The AAD is what stops a chunk file being renamed into
 * another slot — or another job — and decrypting cleanly.
 */
function sealChunk(jobId: string, index: number, recipients: JobRecipient[]): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", PAYLOAD_KEY, iv);
  cipher.setAAD(Buffer.from(`${jobId}:${index}`, "utf-8"));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(recipients), "utf-8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openChunk(jobId: string, index: number, blob: Buffer): JobRecipient[] {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", PAYLOAD_KEY, iv);
  decipher.setAAD(Buffer.from(`${jobId}:${index}`, "utf-8"));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf-8")) as JobRecipient[];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobRecipient {
  email: string;
  name?: string;
}

export type BroadcastJobKind = "marketing" | "event";

export type BroadcastJobState =
  | "draft"      // accepting chunks
  | "queued"     // sealed, waiting for the worker
  | "running"    // at least one chunk drained
  | "completed"  // every chunk drained
  | "cancelled"  // organiser stopped it
  | "died"       // process restarted mid-flight; payload is unrecoverable
  | "expired";   // TTL destroyed the payload

/** States in which no payload exists and nothing further will be sent. */
export const TERMINAL_STATES: readonly BroadcastJobState[] = [
  "completed",
  "cancelled",
  "died",
  "expired",
];

export interface BroadcastJob {
  id: string;
  /** Lowercased organiser wallet address — the verified parentAddress. */
  org: string;
  kind: BroadcastJobKind;
  eventId?: string;
  state: BroadcastJobState;

  subject: string;
  html: string;
  fromDisplayName: string;
  fromAddress: string;

  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** When the payload is destroyed regardless of progress. */
  expiresAt: string;

  /** Chunks uploaded (while `draft`), then the sealed count. */
  chunkCount: number;
  /** Next chunk the worker will drain. */
  nextChunk: number;

  accepted: number;
  /** Duplicates within the job, plus recipients already sent by a resumed job. */
  skipped: number;
  sent: number;
  suppressed: number;
  failed: number;

  /**
   * Delivered recipients, hash-only. Durable so a resume can skip them.
   *
   * DELIBERATELY NOT ERASED under Art. 17. Removing a subject's hash here would
   * make a resumed job mail the person who asked to be forgotten — the
   * mechanical opposite of the request. Erasure is effective against a live job
   * by a different route: `eraseSubject` suppresses first, and suppression is
   * re-checked per recipient at send time. See DATA_INVENTORY.md §3.1.
   */
  sentHashes: string[];

  /** Hash-prefixed, never plaintext — the marketing PLAINTEXT POLICY applies. */
  errors: string[];

  /** Job whose `sentHashes` this one inherits, so a resume cannot double-send. */
  resumeOf?: string;
  /** Recipients reserved against the daily cap at start; reconciled at the end. */
  reserved?: number;
  /** Human-readable reason for a non-`completed` terminal state. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const jobs = new Map<string, BroadcastJob>();

/**
 * Hashes accepted so far, per DRAFT job. Memory-only and dropped at seal: it
 * exists to dedupe ACROSS chunks (`sendMarketingBatch` only dedupes within one
 * call, so the same address in chunk 3 and chunk 17 would be mailed twice), and
 * a draft cannot survive a restart anyway. A Set, not a scan of an array — at
 * 20k recipients the linear version is quadratic.
 */
const acceptedHashes = new Map<string, Set<string>>();

/**
 * Attendee membership snapshot for `event` jobs, taken ONCE at job creation.
 *
 * Re-deriving it per chunk would mean a Swarm read per series per chunk, and a
 * transient failure mid-upload would make real attendees look like strangers.
 * Snapshot-once is also the honest semantic: the organiser is mailing the
 * audience as it stood when they pressed send.
 */
export interface AttendeeSnapshot {
  /** Email hashes proven to hold a ticket for this event. */
  hashes: Set<string>;
  /**
   * Whether recipients absent from `hashes` may still be mailed. True only when
   * the event has an on-chain series whose claimers the server cannot see AND
   * the organiser is Stripe-verified — the same narrow fallback the inline
   * route used, not a general escape hatch.
   */
  allowUnproven: boolean;
}
const attendeeSnapshots = new Map<string, AttendeeSnapshot>();

let loaded = false;

// ---------------------------------------------------------------------------
// Persistence — one file per job
// ---------------------------------------------------------------------------

/**
 * One file per job rather than one aggregate.
 *
 * A 20k job's `sentHashes` is over a megabyte of JSON. In a single file, every
 * chunk drain would rewrite and fsync the union of every live job, and one
 * organiser's broadcast would make every other organiser's write O(total).
 */
function jobFile(id: string): string {
  return join(JOBS_DIR, `${id}.json`);
}

function chunkFile(id: string, index: number): string {
  return join(CHUNKS_DIR, `${id}.${index}.bin`);
}

/** New `.data` stores land at the process umask (0644). Tighten every write. */
function tighten(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Non-fatal: the record landing matters more than the mode, and the
    // operator sweep in CLAUDE.local.md catches a file that stayed readable.
  }
}

function persist(job: BroadcastJob): boolean {
  job.updatedAt = new Date().toISOString();
  const ok = writeJsonAtomic(jobFile(job.id), job, "broadcast-jobs");
  if (ok) tighten(jobFile(job.id));
  return ok;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  mkdirSync(JOBS_DIR, { recursive: true });
  mkdirSync(CHUNKS_DIR, { recursive: true });
  let names: string[] = [];
  try {
    names = readdirSync(JOBS_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const job = JSON.parse(readFileSync(join(JOBS_DIR, name), "utf-8")) as BroadcastJob;
      if (job?.id) jobs.set(job.id, job);
    } catch {
      // A single unparseable record must not stop the rest loading. It holds no
      // plaintext, so the worst case is one job's send accounting being lost.
      console.warn(`[broadcast-jobs] Skipping unreadable job record ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

/**
 * 2× the expected drain, floored and capped. A formula rather than a constant
 * because a fixed number would encode today's list cap as if it were a fact.
 */
export function drainTtlMs(recipients: number, ratePerSecond = effectiveSendRate()): number {
  const expected = (recipients / Math.max(1, ratePerSecond)) * 1000;
  return Math.min(MAX_DRAIN_TTL_MS, Math.max(MIN_DRAIN_TTL_MS, Math.ceil(expected * 2)));
}

// ---------------------------------------------------------------------------
// Per-job serialisation
// ---------------------------------------------------------------------------

/**
 * Chunk indices are server-assigned, so two concurrent uploads must not race
 * the numbering — the AES-GCM AAD binds a chunk to its index, and a duplicated
 * index would silently overwrite a chunk of real recipients.
 */
const jobLocks = new Map<string, Promise<unknown>>();

export function withJobLock<T>(jobId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  const next = prev.then(() => fn());
  jobLocks.set(jobId, next.then(() => {}, () => {}));
  return next as Promise<T>;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getJob(id: string): BroadcastJob | null {
  ensureLoaded();
  return jobs.get(id) ?? null;
}

/** The organiser's own jobs, newest first. Ownership is checked by the caller. */
export function listJobsForOrg(org: string, limit = 20): BroadcastJob[] {
  ensureLoaded();
  return [...jobs.values()]
    .filter((j) => j.org === org.toLowerCase())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function isTerminal(job: BroadcastJob): boolean {
  return TERMINAL_STATES.includes(job.state);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  org: string;
  kind: BroadcastJobKind;
  eventId?: string;
  subject: string;
  html: string;
  fromDisplayName: string;
  fromAddress: string;
  /** Membership snapshot for `event` jobs — taken once, by the caller. */
  attendees?: AttendeeSnapshot;
  /** Prior job whose delivered recipients this one must not mail again. */
  resumeOf?: string;
}

export function createJob(input: CreateJobInput): BroadcastJob {
  ensureLoaded();
  const now = Date.now();
  const job: BroadcastJob = {
    id: randomUUID(),
    org: input.org.toLowerCase(),
    kind: input.kind,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    state: "draft",
    subject: input.subject,
    html: input.html,
    fromDisplayName: input.fromDisplayName,
    fromAddress: input.fromAddress,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DRAFT_TTL_MS).toISOString(),
    chunkCount: 0,
    nextChunk: 0,
    accepted: 0,
    skipped: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    sentHashes: [],
    errors: [],
    ...(input.resumeOf ? { resumeOf: input.resumeOf } : {}),
  };

  // A resumed job starts with the prior job's delivered set already "accepted",
  // so those addresses are skipped at upload time and never reach a chunk.
  const seed = new Set<string>();
  if (input.resumeOf) {
    for (const h of getJob(input.resumeOf)?.sentHashes ?? []) seed.add(h);
  }
  acceptedHashes.set(job.id, seed);
  if (input.attendees) attendeeSnapshots.set(job.id, input.attendees);

  jobs.set(job.id, job);
  persist(job);
  return job;
}

/** The membership snapshot taken when an `event` job was created. */
export function attendeeSnapshot(jobId: string): AttendeeSnapshot | null {
  return attendeeSnapshots.get(jobId) ?? null;
}

// ---------------------------------------------------------------------------
// Chunk upload
// ---------------------------------------------------------------------------

export interface AppendChunkResult {
  chunkIndex: number;
  accepted: number;
  /** Already accepted by this job, or already delivered by the job it resumes. */
  skipped: number;
  totalAccepted: number;
  chunkCount: number;
}

/**
 * Append one chunk of recipients. MUST be called under `withJobLock`.
 *
 * `hashOf` is injected rather than imported so this module stays free of the
 * claim-service dependency chain; production passes `hashEmail`.
 */
export function appendChunk(
  jobId: string,
  recipients: JobRecipient[],
  hashOf: (email: string) => string,
): AppendChunkResult {
  const job = mustDraft(jobId);
  if (job.chunkCount >= MAX_CHUNKS) {
    throw new BroadcastJobError(`Too many chunks (max ${MAX_CHUNKS})`, "TOO_MANY_CHUNKS");
  }

  const seen = acceptedHashes.get(jobId) ?? new Set<string>();
  acceptedHashes.set(jobId, seen);

  const fresh: JobRecipient[] = [];
  let skipped = 0;
  for (const r of recipients) {
    const hash = hashOf(r.email);
    if (seen.has(hash)) {
      skipped++;
      continue;
    }
    seen.add(hash);
    fresh.push(r);
  }

  const index = job.chunkCount;
  if (fresh.length > 0) {
    mkdirSync(CHUNKS_DIR, { recursive: true });
    const file = chunkFile(jobId, index);
    writeFileSync(file, sealChunk(jobId, index, fresh), { mode: 0o600 });
    tighten(file);
    job.chunkCount++;
  }

  job.accepted += fresh.length;
  job.skipped += skipped;
  // Refresh the draft TTL: a slow multi-chunk upload is legitimate, an
  // abandoned one is what the TTL is for.
  job.expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
  persist(job);

  return {
    chunkIndex: index,
    accepted: fresh.length,
    skipped,
    totalAccepted: job.accepted,
    chunkCount: job.chunkCount,
  };
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

export class BroadcastJobError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "BroadcastJobError";
  }
}

function mustDraft(jobId: string): BroadcastJob {
  const job = getJob(jobId);
  if (!job) throw new BroadcastJobError("No such job", "NOT_FOUND");
  if (job.state !== "draft") {
    throw new BroadcastJobError(`Job is ${job.state}, not accepting recipients`, "NOT_DRAFT");
  }
  return job;
}

/**
 * Seal the job and hand it to the worker.
 *
 * The caller states what it uploaded and we refuse on mismatch. Without this a
 * lost chunk POST — a network blip, a closed tab — produces a job that drains
 * happily, completes, and reports success while an entire chunk of people were
 * never mailed. "Told 'sent' for mail that never went" is the failure class
 * this whole branch exists to eliminate, and it would have been rebuilt here.
 *
 * Idempotent: a retried or double-clicked start returns the job as it stands
 * rather than queueing it twice.
 */
export function sealAndQueue(
  jobId: string,
  expected: { chunkCount: number; totalRecipients: number },
): BroadcastJob {
  const job = getJob(jobId);
  if (!job) throw new BroadcastJobError("No such job", "NOT_FOUND");
  if (job.state === "queued" || job.state === "running") return job;
  if (job.state !== "draft") {
    throw new BroadcastJobError(`Job is ${job.state} and cannot be started`, "NOT_DRAFT");
  }
  if (job.accepted === 0) {
    throw new BroadcastJobError("No recipients were uploaded", "EMPTY");
  }
  if (expected.chunkCount !== job.chunkCount || expected.totalRecipients !== job.accepted) {
    throw new BroadcastJobError(
      `Upload incomplete — you sent ${expected.totalRecipients} recipient(s) in ` +
        `${expected.chunkCount} chunk(s), the server holds ${job.accepted} in ${job.chunkCount}. ` +
        `Nothing has been sent; start again.`,
      "INCOMPLETE",
    );
  }

  job.state = "queued";
  job.startedAt = new Date().toISOString();
  job.expiresAt = new Date(Date.now() + drainTtlMs(job.accepted)).toISOString();
  // The draft-time dedupe set has done its job; drop a 20k-entry Set per job.
  acceptedHashes.delete(jobId);
  persist(job);
  return job;
}

/**
 * Note the daily-cap allowance claimed for this job, so the worker can correct
 * it to what was really sent when the job ends. Persisted immediately: a
 * reservation the record does not know about is one nothing will ever release.
 */
export function markReserved(job: BroadcastJob, count: number): void {
  job.reserved = count;
  persist(job);
}

// ---------------------------------------------------------------------------
// Worker-facing
// ---------------------------------------------------------------------------

/** Jobs with a chunk still to drain, in a stable order. */
export function runnableJobs(now = Date.now()): BroadcastJob[] {
  ensureLoaded();
  return [...jobs.values()]
    .filter(
      (j) =>
        (j.state === "queued" || j.state === "running") &&
        j.nextChunk < j.chunkCount &&
        Date.parse(j.expiresAt) > now,
    )
    .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));
}

export function readChunk(jobId: string, index: number): JobRecipient[] | null {
  const file = chunkFile(jobId, index);
  if (!existsSync(file)) return null;
  return openChunk(jobId, index, readFileSync(file));
}

export function deleteChunk(jobId: string, index: number): void {
  try {
    unlinkSync(chunkFile(jobId, index));
  } catch {
    // Already gone. The point is that it is not there, not that we removed it.
  }
}

/** Every remaining chunk. Used by cancel, expiry and boot. */
export function destroyPayload(jobId: string): number {
  let removed = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const file = chunkFile(jobId, i);
    if (!existsSync(file)) continue;
    try {
      unlinkSync(file);
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

export interface ChunkOutcome {
  sent: number;
  suppressed: number;
  failed: number;
  sentHashes: string[];
  errors: string[];
}

/**
 * Record a drained chunk, THEN delete it. The order is load-bearing.
 *
 * Deleting first and crashing before the persist would lose the record of who
 * was mailed while the chunk itself is already gone — and a resume, which skips
 * on `sentHashes`, would then re-deliver up to a full chunk. The reverse
 * failure (persisted, not yet unlinked) leaves an orphan ciphertext file that
 * the boot sweep removes, and costs nothing.
 */
export function recordChunkDrained(job: BroadcastJob, outcome: ChunkOutcome): void {
  const index = job.nextChunk;
  job.sent += outcome.sent;
  job.suppressed += outcome.suppressed;
  job.failed += outcome.failed;
  job.sentHashes.push(...outcome.sentHashes);
  job.errors = [...job.errors, ...outcome.errors].slice(0, MAX_STORED_ERRORS);
  job.nextChunk = index + 1;
  if (job.state === "queued") job.state = "running";
  persist(job);
  deleteChunk(job.id, index);
}

/**
 * Move a job to a terminal state and destroy whatever payload is left.
 *
 * `onFinish` is where the daily-cap reservation is reconciled; injected so this
 * module does not depend on the marketing stores.
 */
export function finishJob(
  job: BroadcastJob,
  state: Extract<BroadcastJobState, "completed" | "cancelled" | "died" | "expired">,
  reason?: string,
): void {
  job.state = state;
  job.finishedAt = new Date().toISOString();
  if (reason) job.reason = reason;
  persist(job);
  destroyPayload(job.id);
  acceptedHashes.delete(job.id);
  attendeeSnapshots.delete(job.id);
}

/**
 * Organiser-requested stop. Destroys the remaining chunks IMMEDIATELY rather
 * than waiting for the worker to notice — "cancel" that leaves recipient data
 * on disk for another chunk's worth of time is not a cancel.
 */
export function cancelJob(job: BroadcastJob, reason = "Cancelled by the organiser"): void {
  finishJob(job, "cancelled", reason);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Called once at boot. Every chunk on disk is ciphertext under a key that died
 * with the previous process, so there is nothing to recover: wipe the payload
 * and mark the jobs that were in flight.
 *
 * @returns the jobs that were killed, so the caller can reconcile their cap
 *   reservations and log loudly.
 */
export function reconcileOnBoot(): BroadcastJob[] {
  ensureLoaded();
  try {
    rmSync(CHUNKS_DIR, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
  mkdirSync(CHUNKS_DIR, { recursive: true });

  const killed: BroadcastJob[] = [];
  for (const job of jobs.values()) {
    if (isTerminal(job)) continue;
    const wasDraft = job.state === "draft";
    const unsent = Math.max(0, job.accepted - job.sent - job.suppressed - job.failed);
    job.state = "died";
    job.finishedAt = new Date().toISOString();
    job.reason = wasDraft
      ? "The server restarted before this broadcast was started"
      : `The server restarted mid-send — ${unsent} recipient(s) were not mailed`;
    persist(job);
    killed.push(job);
  }
  if (killed.length) {
    console.error(
      `[broadcast-jobs] ${killed.length} broadcast job(s) did not survive the restart — ` +
        `their recipients are unrecoverable by design and the organiser must resume them`,
    );
  }
  return killed;
}

/**
 * Expire whatever has run out of time, and drop records past retention.
 *
 * Draft jobs matter most here: nothing else visits them, so without this an
 * abandoned upload keeps plaintext on disk indefinitely.
 *
 * @returns jobs newly expired, for cap reconciliation.
 */
export function sweep(now = Date.now()): BroadcastJob[] {
  ensureLoaded();
  const expired: BroadcastJob[] = [];

  for (const job of jobs.values()) {
    if (isTerminal(job)) continue;
    if (Date.parse(job.expiresAt) > now) continue;
    const reason =
      job.state === "draft"
        ? "Abandoned before it was started — the recipients were destroyed"
        : "Ran past its time limit — the remaining recipients were destroyed";
    finishJob(job, "expired", reason);
    expired.push(job);
  }

  // Records only from here down: the payload is already gone for anything
  // terminal, so this is bounding hash-only accounting, not personal data.
  const byOrg = new Map<string, BroadcastJob[]>();
  for (const job of jobs.values()) {
    if (!isTerminal(job)) continue;
    const list = byOrg.get(job.org) ?? [];
    list.push(job);
    byOrg.set(job.org, list);
  }
  for (const list of byOrg.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    list.forEach((job, i) => {
      const tooOld = now - Date.parse(job.createdAt) > RECORD_RETENTION_MS;
      if (!tooOld && i < RECORDS_PER_ORG) return;
      jobs.delete(job.id);
      try {
        unlinkSync(jobFile(job.id));
      } catch { /* already gone */ }
    });
  }

  return expired;
}

export interface BroadcastQueueHealth {
  /** False when a job died on a restart and nobody has resumed it. */
  ok: boolean;
  queued: number;
  running: number;
  /** Jobs killed by a restart in the last 24h that were never resumed. */
  diedUnresumed: number;
  pendingRecipients: number;
}

/**
 * For /api/health. A `died` job is an organiser whose announcement stopped
 * halfway and who does not know it — the #98 silent-failure shape at broadcast
 * scale — so it alarms rather than being a statistic. Counts only; this
 * endpoint is public.
 */
export function broadcastQueueHealth(now = Date.now()): BroadcastQueueHealth {
  ensureLoaded();
  const all = [...jobs.values()];
  const resumed = new Set(all.map((j) => j.resumeOf).filter(Boolean) as string[]);
  const diedUnresumed = all.filter(
    (j) =>
      j.state === "died" &&
      !resumed.has(j.id) &&
      now - Date.parse(j.createdAt) < 24 * 60 * 60_000,
  ).length;
  const live = all.filter((j) => j.state === "queued" || j.state === "running");
  return {
    ok: diedUnresumed === 0,
    queued: all.filter((j) => j.state === "queued").length,
    running: all.filter((j) => j.state === "running").length,
    diedUnresumed,
    pendingRecipients: live.reduce(
      (n, j) => n + Math.max(0, j.accepted - j.sent - j.suppressed - j.failed),
      0,
    ),
  };
}

/** Tests only — clears memory and disk so suites start from empty. */
export function _resetForTest(): void {
  jobs.clear();
  acceptedHashes.clear();
  attendeeSnapshots.clear();
  jobLocks.clear();
  loaded = true;
  try {
    rmSync(JOBS_DIR, { recursive: true, force: true });
    rmSync(CHUNKS_DIR, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
  mkdirSync(JOBS_DIR, { recursive: true });
  mkdirSync(CHUNKS_DIR, { recursive: true });
}

/** Tests only — drops the in-memory copy WITHOUT touching disk. Models a restart. */
export function _reloadForTest(): void {
  jobs.clear();
  acceptedHashes.clear();
  attendeeSnapshots.clear();
  loaded = false;
}
