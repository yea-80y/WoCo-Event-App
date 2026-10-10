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
 * first-party copy that lives for the life of the send — under an hour for most,
 * days for a paced first send to a large new list. That is defensible where the
 * rejected third-party version was not (we are the processor the organiser
 * already instructed, same data, same purpose, bounded in time) — but only
 * under the conditions this module implements:
 *
 *   1. Chunks are AES-256-GCM ciphertext under a key generated PER JOB, held
 *      only in process memory and NEVER written down. The point is not the
 *      running VM — an attacker with `.data/` also has `server.env`. The point
 *      is BACKUPS: any rsync, VM snapshot or disk image that catches a chunk
 *      file catches ciphertext nobody will ever hold the key for, including
 *      us. Per job rather than per process because a paced send (#619) holds
 *      its recipients for hours or days: the key is dropped the moment the job
 *      ends, so a chunk file that outlives its job is unreadable at once
 *      (cryptographic erase, NIST SP 800-88 Rev. 1 §2.6), not at the next
 *      restart.
 *   2. A chunk is deleted the moment it has drained, not at job completion.
 *      New contacts in a paced send sit in chunks of 100, so each is on disk
 *      only until their own batch goes.
 *   3. A hard TTL destroys the payload whether or not the job finished, and it
 *      is a FORMULA rather than a number that would fossilise today's list cap:
 *      2× the expected drain for an unpaced send, the planned schedule plus a
 *      day (at most 7 days) for a paced one — set by the caller at seal time.
 *   4. `sentHashes` is durable and hash-only, so a job killed by a restart can
 *      report "died with N unsent" and be resumed without mailing anyone twice
 *      — and `priorDelivered` carries every earlier job's deliveries forward,
 *      so a resume of a resume cannot either (#620).
 *
 * Consequence of (1), stated plainly: a restart kills every in-flight job. That
 * is the cost of the property, and it is why `died` is surfaced loudly rather
 * than left for an organiser to notice. Paced sends make it likelier, not
 * different: the resume is still one press, and still exact.
 *
 * See docs/SES_MIGRATION_HANDOVER.md §6 and docs/legal/DATA_INVENTORY.md §3.1.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { MARKETING_MAX_LIST_EMAILS, PACING_CHUNK, type ServiceNoticeType } from "@woco/shared";
import { writeJsonAtomic } from "../marketing/persist.js";
import { effectiveSendRate } from "./rate-limiter.js";

const DATA_DIR = join(process.cwd(), ".data");
const JOBS_DIR = join(DATA_DIR, "broadcast-jobs");
const CHUNKS_DIR = join(DATA_DIR, "broadcast-chunks");

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The ONE recipient ceiling in this system, and it is not this module's to set.
 *
 * `MARKETING_MAX_LIST_EMAILS` is the organiser's list cap, which
 * docs/SES_MIGRATION_HANDOVER.md §6 records as stale conservatism — it predates
 * payload compression, and the real storage ceiling is nearer 175,000. Raising
 * it is #101's job. Deriving from it here means that when it moves, this moves,
 * instead of leaving a lower ceiling buried in the queue for someone to
 * rediscover the hard way.
 */
export const MAX_JOB_RECIPIENTS = MARKETING_MAX_LIST_EMAILS;

/** Recipients per chunk upload. Also the blast radius of a mid-chunk crash. */
export const MAX_CHUNK_RECIPIENTS = 500;

/**
 * Chunk-count bound — a guard against a client uploading one recipient per
 * request, not a limit on how many people can be mailed. Derived from the
 * recipient cap with 4x headroom, so a client sending smaller chunks than the
 * maximum is not punished and nothing here binds before the cap above does.
 */
export const MAX_CHUNKS = Math.ceil(MAX_JOB_RECIPIENTS / MAX_CHUNK_RECIPIENTS) * 4;

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
 * Ceiling for an UNPACED send. NOT generous on purpose: the legal position is
 * "bounded in time", and nothing unpaced should need hours. A paced send
 * (#619) is the one deliberate exception — the organiser chose to have its new
 * contacts go out over hours or days rather than keep a tab open — and its
 * bound is the pacing schedule's, set by the caller at seal time.
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
 * One key per job, generated at creation, held in memory, never persisted, and
 * dropped when the job ends. Losing every key on restart is the designed
 * behaviour, not an oversight — see the header.
 */
const jobKeys = new Map<string, Buffer>();
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Which run of chunks a file belongs to: `in` as uploaded, then — once the job
 * is sealed — `p` for contacts already proven deliverable and `u` for contacts
 * new to the platform, which a paced send releases in batches.
 */
export type ChunkSeq = "in" | "p" | "u";

function aad(jobId: string, seq: ChunkSeq, index: number): Buffer {
  return Buffer.from(`${jobId}:${seq}:${index}`, "utf-8");
}

/**
 * `iv || tag || ciphertext`, with the job id, sequence and chunk index as
 * additional authenticated data. The AAD is what stops a chunk file being
 * renamed into another slot, another job — or from the paced `u` run into the
 * unpaced `p` run, which would skip pacing — and decrypting cleanly.
 */
function sealChunk(jobId: string, seq: ChunkSeq, index: number, recipients: JobRecipient[]): Buffer {
  const key = jobKeys.get(jobId);
  if (!key) throw new BroadcastJobError("This broadcast's key is gone — start again", "NO_KEY");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(jobId, seq, index));
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(recipients), "utf-8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openChunk(jobId: string, seq: ChunkSeq, index: number, blob: Buffer): JobRecipient[] {
  const key = jobKeys.get(jobId);
  if (!key) throw new Error("no key");
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(jobId, seq, index));
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
  /**
   * Set at upload: false for a contact the sender has never had mail delivered
   * to through us, which a paced send releases in batches (#619). Only the
   * sealed upload chunks carry it; the partition at seal consumes it.
   */
  proven?: boolean;
}

export type BroadcastJobKind = "marketing" | "event";

export type BroadcastJobState =
  | "draft"      // accepting chunks
  | "queued"     // sealed, waiting for the worker
  | "running"    // at least one chunk drained
  | "completed"  // every chunk drained
  | "cancelled"  // organiser stopped it
  | "died"       // process restarted mid-flight; payload is unrecoverable
  | "expired"    // TTL destroyed the payload
  | "stopped";   // the sender's sending was stopped (#619); resumable once lifted

/** States in which no payload exists and nothing further will be sent. */
export const TERMINAL_STATES: readonly BroadcastJobState[] = [
  "completed",
  "cancelled",
  "died",
  "expired",
  "stopped",
];

/** Why a live paced job is not sending right now. Shown to the organiser. */
export interface JobWaiting {
  for: "next-batch" | "day-ceiling" | "bounce-hold" | "complaint-hold";
  until?: string;
  /** For a pause: the organiser-facing explanation, with its numbers. */
  message?: string;
}

export interface BroadcastJob {
  id: string;
  /** Lowercased organiser wallet address — the verified parentAddress. */
  org: string;
  kind: BroadcastJobKind;
  eventId?: string;
  state: BroadcastJobState;
  /**
   * Present only on an `event` job the platform composed as a service notice
   * (#60 item 1). Its presence is what permits the send to cross a CONSENT
   * suppression mark, so it is set from a fixed enum at job creation and never
   * from anything the organiser can type.
   */
  serviceType?: ServiceNoticeType;

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

  /** Chunks uploaded while `draft`. The partition at seal replaces them. */
  chunkCount: number;
  /** Proven-contact chunks after the seal, and the next one to drain. */
  pChunks: number;
  nextP: number;
  /** New-contact chunks (100 each) after the seal, and the next one to drain. */
  uChunks: number;
  nextU: number;
  /** Accepted recipients by class — `proven + unproven === accepted`. */
  proven: number;
  unproven: number;
  sentProven: number;
  sentUnproven: number;
  /** New-contact batches opened so far; names the next one `u${n}`. */
  batchesStarted: number;
  /** The open batch of new contacts: chunks still to drain from it. */
  batch?: { n: number; chunksLeft: number; startedAt: string };
  /** The worker does not pick this job before then. */
  nextBatchAt?: string;
  waiting?: JobWaiting;

  accepted: number;
  /** Duplicates within the job, plus recipients already sent by a resumed job. */
  skipped: number;
  sent: number;
  suppressed: number;
  /**
   * ADMITTED PAST an active suppression mark, because this job is a service
   * notice — counted at the gate, so it includes a crossing whose message then
   * failed (#391). Kept out of `sent` deliberately: this is the number that has
   * to be answerable later, and one folded into a total cannot be.
   */
  crossed: number;
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
  /**
   * Everyone every job this one resumes had already reached — the parent's
   * `sentHashes` plus the parent's own `priorDelivered` (#620). Seeding from
   * the parent's `sentHashes` alone lost the grandparent's deliveries, so a
   * resume of a resume mailed them again. Kept apart from `sentHashes` so an
   * Art. 15 report names only the job that actually reached someone.
   */
  priorDelivered: string[];

  /** Hash-prefixed, never plaintext — the marketing PLAINTEXT POLICY applies. */
  errors: string[];

  /** Job whose deliveries this one inherits, so a resume cannot double-send. */
  resumeOf?: string;
  /** Recipients reserved against the daily cap at start; reconciled at the end. */
  reserved?: number;
  /** When the reservation was made — it ages out of the 24h cap window. */
  reservedAt?: string;
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
   * Whether the event has an on-chain series registered before the attendee
   * index existed (#387), so some of its real buyers are not in `hashes`.
   *
   * DIAGNOSTIC ONLY — it selects the wording of a rejection, never whether one
   * happens. It replaced an `allowUnproven` flag that DID grant permission, and
   * that flag is why a Stripe-verified organiser could mail arbitrary strangers
   * for a month: its data source was deleted by #207 while it stayed true. Do
   * not let this field regain the power to widen the recipient set.
   */
  hasUnverifiableSeries: boolean;
}
const attendeeSnapshots = new Map<string, AttendeeSnapshot>();

/**
 * Fired when a job stops. The worker hands the signal to `sendMarketingBatch`,
 * which checks it between in-flight groups, so a cancel takes effect within ten
 * messages rather than after the whole chunk — up to 500 more sends, ~42s at the
 * account rate, all of them after the organiser was told it had stopped.
 */
const jobAborts = new Map<string, AbortController>();

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

function chunkFile(id: string, seq: ChunkSeq, index: number): string {
  return join(CHUNKS_DIR, `${id}.${seq}.${index}.bin`);
}

/**
 * New `.data` stores land at the process umask, which is 0644 in the container
 * — `marketing-lists.json` shipped that way. The operator sweep in
 * CLAUDE.local.md exists because that has been missed before, so both the
 * directories and every file written into them are tightened here rather than
 * left to it.
 */
function ensureDirs(): void {
  mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CHUNKS_DIR, { recursive: true, mode: 0o700 });
  // `recursive: true` does NOT apply the mode to a directory that already
  // exists, so an upgrade from an earlier deploy would keep 0755 without this.
  for (const dir of [JOBS_DIR, CHUNKS_DIR]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort — the per-file mode is the control that matters */
    }
  }
}

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
  ensureDirs();
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

/** Every started, unfinished job of one organiser, however long it has to wait. */
export function liveJobsFor(org: string): BroadcastJob[] {
  ensureLoaded();
  const o = org.toLowerCase();
  return [...jobs.values()].filter((j) => j.org === o && (j.state === "queued" || j.state === "running"));
}

export interface BroadcastRecord {
  jobId: string;
  org: string;
  kind: BroadcastJobKind;
  ts: string;
  state: BroadcastJobState;
}

/**
 * Art. 15 — every broadcast record naming this address.
 *
 * `reportSubject` claims to cover everything we hold about a subject, so a
 * store it cannot see makes the access report wrong rather than incomplete.
 * The record is hash-only: it says an organiser's broadcast reached this
 * address on this date, which is the fact the subject is entitled to.
 *
 * There is deliberately NO erasure counterpart. Removing a hash from
 * `sentHashes` would make a resumed job mail the person who asked to be
 * forgotten — the mechanical opposite of the request. Erasure is effective by a
 * different route: `eraseSubject` suppresses FIRST, and suppression is
 * re-checked per recipient at send time, so a live job stops mailing them
 * immediately. The record itself ages out with the 7-day retention.
 */
export function broadcastsContaining(emailHash: string): BroadcastRecord[] {
  ensureLoaded();
  return [...jobs.values()]
    .filter((j) => j.sentHashes.includes(emailHash))
    .map((j) => ({
      jobId: j.id,
      org: j.org,
      kind: j.kind,
      ts: j.startedAt ?? j.createdAt,
      state: j.state,
    }));
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
  /** Fixed service-notice category; see `BroadcastJob.serviceType`. */
  serviceType?: ServiceNoticeType;
  /** Prior job whose delivered recipients this one must not mail again. */
  resumeOf?: string;
}

export function createJob(input: CreateJobInput): BroadcastJob {
  ensureLoaded();
  // A job with no from-address is unsendable, and the drain worker is the wrong
  // place to find that out — by then the recipients are encrypted on disk and
  // the organiser has been told the send is queued. `resolveMarketingFrom` can
  // now answer null (#96), so this refuses the coercion that would otherwise
  // paper over it (`?? ""`) rather than trusting every future call site.
  if (!input.fromAddress.trim()) {
    throw new Error("createJob: fromAddress is required — a job with no sender cannot be sent");
  }
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
    pChunks: 0,
    nextP: 0,
    uChunks: 0,
    nextU: 0,
    proven: 0,
    unproven: 0,
    sentProven: 0,
    sentUnproven: 0,
    batchesStarted: 0,
    accepted: 0,
    skipped: 0,
    sent: 0,
    suppressed: 0,
    crossed: 0,
    failed: 0,
    sentHashes: [],
    priorDelivered: [],
    errors: [],
    ...(input.serviceType ? { serviceType: input.serviceType } : {}),
    ...(input.resumeOf ? { resumeOf: input.resumeOf } : {}),
  };

  // A resumed job starts with EVERY earlier job's deliveries already
  // "accepted", so those addresses are skipped at upload time and never reach
  // a chunk. Only the parent is read: it already carries its own ancestors in
  // `priorDelivered`, so pruning an ancestor's record loses nothing (#620).
  const seed = new Set<string>();
  if (input.resumeOf) {
    const prior = getJob(input.resumeOf);
    for (const h of prior?.priorDelivered ?? []) seed.add(h);
    for (const h of prior?.sentHashes ?? []) seed.add(h);
  }
  job.priorDelivered = [...seed];
  acceptedHashes.set(job.id, seed);
  jobKeys.set(job.id, randomBytes(32));
  if (input.attendees) attendeeSnapshots.set(job.id, input.attendees);

  jobs.set(job.id, job);
  persist(job);
  return job;
}

/** Aborts between in-flight groups once the job stops. Null if it never started. */
export function jobSignal(jobId: string): AbortSignal | undefined {
  return jobAborts.get(jobId)?.signal;
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
 * claim-service dependency chain; production passes `hashEmail`. `isProven`
 * classifies a contact for pacing; omitted, everyone is treated as proven,
 * which is right for attendee mail and for any sender that is not paced.
 */
export function appendChunk(
  jobId: string,
  recipients: JobRecipient[],
  hashOf: (email: string) => string,
  isProven?: (hash: string) => boolean,
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
    const proven = isProven ? isProven(hash) : true;
    fresh.push({ email: r.email, ...(r.name !== undefined ? { name: r.name } : {}), proven });
    if (proven) job.proven++;
    else job.unproven++;
  }

  const index = job.chunkCount;
  if (fresh.length > 0) {
    ensureDirs();
    const file = chunkFile(jobId, "in", index);
    writeFileSync(file, sealChunk(jobId, "in", index, fresh), { mode: 0o600 });
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
  opts: { holdUntil?: number } = {},
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

  partition(job);

  job.state = "queued";
  job.startedAt = new Date().toISOString();
  jobAborts.set(job.id, new AbortController());
  // A paced send is bounded by its schedule, which only the caller knows;
  // everything else keeps the drain formula.
  job.expiresAt = new Date(
    job.uChunks > 0 && opts.holdUntil !== undefined
      ? opts.holdUntil
      : Date.now() + drainTtlMs(job.accepted),
  ).toISOString();
  // The draft-time dedupe set has done its job; drop a 20k-entry Set per job.
  acceptedHashes.delete(jobId);
  persist(job);
  return job;
}

/**
 * Re-cut the uploaded chunks into proven (`p`, up to 500) and new (`u`, exactly
 * 100 but the last) runs, then delete the uploads.
 *
 * At seal rather than at upload because uploads arrive in any mix and any size,
 * and a `u` chunk has to be exactly one pacing unit: every batch size is a
 * multiple of 100, so a batch is always whole chunks and delete-as-drained
 * stays exact with no partial chunk ever re-sealed.
 */
function partition(job: BroadcastJob): void {
  const proven: JobRecipient[] = [];
  const fresh: JobRecipient[] = [];
  for (let i = 0; i < job.chunkCount; i++) {
    const rs = readChunk(job.id, "in", i);
    if (!rs) {
      throw new BroadcastJobError(
        "Part of the upload is no longer available. Nothing has been sent; start again.",
        "INCOMPLETE",
      );
    }
    for (const r of rs) {
      const clean = { email: r.email, ...(r.name !== undefined ? { name: r.name } : {}) };
      (r.proven === false ? fresh : proven).push(clean);
    }
  }

  ensureDirs();
  const write = (seq: ChunkSeq, list: JobRecipient[], size: number): number => {
    let n = 0;
    for (let i = 0; i < list.length; i += size) {
      const file = chunkFile(job.id, seq, n);
      writeFileSync(file, sealChunk(job.id, seq, n, list.slice(i, i + size)), { mode: 0o600 });
      tighten(file);
      n++;
    }
    return n;
  };
  job.pChunks = write("p", proven, MAX_CHUNK_RECIPIENTS);
  job.uChunks = write("u", fresh, PACING_CHUNK);
  job.proven = proven.length;
  job.unproven = fresh.length;
  job.nextP = 0;
  job.nextU = 0;
  for (let i = 0; i < job.chunkCount; i++) deleteChunk(job.id, "in", i);
}

/**
 * Note the daily-cap allowance claimed for this job, so the worker can correct
 * it to what was really sent when the job ends. Persisted immediately: a
 * reservation the record does not know about is one nothing will ever release.
 */
export function markReserved(job: BroadcastJob, count: number): void {
  job.reserved = count;
  job.reservedAt = new Date().toISOString();
  persist(job);
}

// ---------------------------------------------------------------------------
// Worker-facing
// ---------------------------------------------------------------------------

export function hasChunksLeft(job: BroadcastJob): boolean {
  return job.nextP < job.pChunks || job.nextU < job.uChunks;
}

/** Jobs with a chunk still to drain and nothing telling them to wait, in a stable order. */
export function runnableJobs(now = Date.now()): BroadcastJob[] {
  ensureLoaded();
  return [...jobs.values()]
    .filter(
      (j) =>
        (j.state === "queued" || j.state === "running") &&
        hasChunksLeft(j) &&
        Date.parse(j.expiresAt) > now &&
        (!j.nextBatchAt || Date.parse(j.nextBatchAt) <= now),
    )
    .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt));
}

/**
 * A chunk's recipients, or null when it cannot be had: the file is gone, or
 * its job's key is (a restart, or the job ended), or it fails authentication.
 * The caller treats all three the same way — the payload is unavailable.
 */
export function readChunk(jobId: string, seq: ChunkSeq, index: number): JobRecipient[] | null {
  const file = chunkFile(jobId, seq, index);
  if (!existsSync(file) || !jobKeys.has(jobId)) return null;
  try {
    return openChunk(jobId, seq, index, readFileSync(file));
  } catch {
    return null;
  }
}

export function deleteChunk(jobId: string, seq: ChunkSeq, index: number): void {
  try {
    unlinkSync(chunkFile(jobId, seq, index));
  } catch {
    // Already gone. The point is that it is not there, not that we removed it.
  }
}

/**
 * Every remaining chunk of a job, whatever run it is in and whatever the
 * record knows about. Used by cancel, expiry, stop and boot.
 *
 * A directory scan rather than a count: `appendChunk` writes the file before
 * it increments the counter, so a crash between the two leaves a chunk the
 * record does not know about, and it holds real recipients.
 */
export function destroyPayload(jobId: string): number {
  let names: string[] = [];
  try {
    names = readdirSync(CHUNKS_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(`${jobId}.`)) continue;
    try {
      unlinkSync(join(CHUNKS_DIR, name));
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

/** Persist a worker's change to a live job (its schedule, its open batch). */
export function saveJob(job: BroadcastJob): boolean {
  return persist(job);
}

export interface ChunkOutcome {
  sent: number;
  suppressed: number;
  /** Admitted past a crossable suppression mark — see `BroadcastJob.crossed`. */
  crossed: number;
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
export function recordChunkDrained(job: BroadcastJob, seq: "p" | "u", outcome: ChunkOutcome): boolean {
  const index = seq === "p" ? job.nextP : job.nextU;
  job.sent += outcome.sent;
  if (seq === "p") job.sentProven += outcome.sent;
  else job.sentUnproven += outcome.sent;
  job.suppressed += outcome.suppressed;
  job.crossed += outcome.crossed;
  job.failed += outcome.failed;
  job.sentHashes.push(...outcome.sentHashes);
  job.errors = [...job.errors, ...outcome.errors].slice(0, MAX_STORED_ERRORS);
  if (seq === "p") job.nextP = index + 1;
  else job.nextU = index + 1;
  // NOT an unconditional assignment: a cancel may have landed while this chunk
  // was in flight, and overwriting `cancelled` with `running` would tell the
  // organiser their stopped broadcast is still going.
  if (job.state === "queued") job.state = "running";

  if (!persist(job)) {
    // Disk full, or worse. The sent record exists only in memory, so deleting
    // the chunk now would leave a restart with no way to know who was mailed —
    // and a resume would re-deliver up to a full chunk. Keeping the ciphertext
    // costs nothing; the boot sweep removes it either way.
    console.error(
      `[broadcast-jobs] Could not persist job ${job.id} after chunk ${seq}${index} — ` +
        `keeping the chunk rather than risking a duplicate send on resume`,
    );
    return false;
  }
  deleteChunk(job.id, seq, index);
  return true;
}

/**
 * Move a job to a terminal state and destroy whatever payload is left.
 *
 * `onFinish` is where the daily-cap reservation is reconciled; injected so this
 * module does not depend on the marketing stores.
 */
export function finishJob(
  job: BroadcastJob,
  state: Extract<BroadcastJobState, "completed" | "cancelled" | "died" | "expired" | "stopped">,
  reason?: string,
): void {
  // Before the state flip, so a worker already inside `sendMarketingBatch`
  // stops at its next group rather than finishing the chunk.
  jobAborts.get(job.id)?.abort();
  jobAborts.delete(job.id);
  job.state = state;
  job.finishedAt = new Date().toISOString();
  if (reason) job.reason = reason;
  delete job.nextBatchAt;
  delete job.waiting;
  delete job.batch;
  persist(job);
  // Key first: from here any chunk file that survives the unlink below — a
  // failed delete, a stray from a crash — is ciphertext for which no key exists.
  jobKeys.delete(job.id);
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
 * Record the death of every live job, at the moment it dies.
 *
 * Called from the SIGTERM/SIGINT handler. Without it the only record of an
 * interrupted broadcast is reconstructed at the NEXT boot — which is fine when
 * the process comes straight back and wrong when it does not: a container that
 * is stopped and not restarted for a day leaves the organiser with a job stuck
 * on "Sending", the health endpoint silent, and no resume button, because
 * nothing has run to say otherwise.
 *
 * Deliberately synchronous and small: it runs inside the shutdown grace period.
 *
 * @returns the jobs it marked, so the caller can settle their cap reservations.
 */
export function recordShutdown(): BroadcastJob[] {
  ensureLoaded();
  const killed: BroadcastJob[] = [];
  for (const job of jobs.values()) {
    if (isTerminal(job)) continue;
    const unsent = Math.max(0, job.accepted - job.sent - job.suppressed - job.failed);
    finishJob(
      job,
      "died",
      job.state === "draft"
        ? "The server was restarted before this broadcast was started"
        : `The server was restarted mid-send — ${unsent} recipient(s) were not mailed. ` +
            `Resume to reach exactly those.`,
    );
    killed.push(job);
  }
  if (killed.length) {
    console.warn(
      `[broadcast-jobs] Shutting down with ${killed.length} live broadcast job(s) — ` +
        `marked died with their unsent counts so the organiser can resume`,
    );
  }
  return killed;
}

/**
 * Called once at boot. Every chunk on disk is ciphertext under a key that died
 * with the previous process, so there is nothing to recover: wipe the payload
 * and mark the jobs that were in flight.
 *
 * `recordShutdown` normally gets there first on a clean stop; this is the path
 * for a kill -9, an OOM, or a power loss, and it must produce the same outcome.
 *
 * @returns the jobs that were killed, so the caller can reconcile their cap
 *   reservations and log loudly.
 */
export function reconcileOnBoot(): BroadcastJob[] {
  ensureLoaded();
  try {
    rmSync(CHUNKS_DIR, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
  ensureDirs();

  const killed: BroadcastJob[] = [];
  for (const job of jobs.values()) {
    if (isTerminal(job)) continue;
    const wasDraft = job.state === "draft";
    const unsent = Math.max(0, job.accepted - job.sent - job.suppressed - job.failed);
    job.state = "died";
    job.finishedAt = new Date().toISOString();
    delete job.nextBatchAt;
    delete job.waiting;
    delete job.batch;
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
  const resumed = new Set(
    [...jobs.values()].map((j) => j.resumeOf).filter(Boolean) as string[],
  );
  for (const list of byOrg.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    list.forEach((job, i) => {
      // Retention runs from the END of the job, not its creation — a job
      // created on Friday and marked dead when the server came back much later
      // gets its full resume window from the death, the same long-outage
      // correction `broadcastQueueHealth` makes for the alarm.
      const tooOld = now - Date.parse(job.finishedAt ?? job.createdAt) > RECORD_RETENTION_MS;
      // A died job nobody has resumed is not bookkeeping. It IS the /api/health
      // alarm, and its `sentHashes` are what a resume needs to skip the people
      // already mailed — evicting it under the per-org cap clears the alarm and
      // destroys the remedy in one stroke. Same rule as the failure ledger's
      // prune: unresolved evidence is exempt from the size bound and limited by
      // retention alone. A stopped or expired paced send that reached anyone is
      // the same remedy: its resume must skip them, so it is kept too.
      const awaitingResume =
        !resumed.has(job.id) &&
        (job.state === "died" || ((job.state === "stopped" || job.state === "expired") && job.sent > 0));
      if (awaitingResume && !tooOld) return;
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
  /** Recipients a deploy right now would leave unsent. Zero = safe to deploy. */
  pendingRecipients: number;
  /** Live jobs still holding new contacts for later batches (#619). */
  pacedJobs: number;
  /** Age of the oldest live job, in hours — how long a deploy's casualty has been running. */
  oldestPendingHours: number;
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
      // `finishedAt`, NOT `createdAt`. A job created on Friday, killed by a
      // crash, and marked dead when the server came back on Monday has a
      // three-day-old creation time — so keying on that made the alarm blind to
      // the long-outage restart, which is the likeliest producer of dead jobs.
      now - Date.parse(j.finishedAt ?? j.createdAt) < 24 * 60 * 60_000,
  ).length;
  const live = all.filter((j) => j.state === "queued" || j.state === "running");
  const oldest = live.reduce(
    (max, j) => Math.max(max, now - Date.parse(j.startedAt ?? j.createdAt)),
    0,
  );
  return {
    ok: diedUnresumed === 0,
    queued: all.filter((j) => j.state === "queued").length,
    running: all.filter((j) => j.state === "running").length,
    diedUnresumed,
    pendingRecipients: live.reduce(
      (n, j) => n + Math.max(0, j.accepted - j.sent - j.suppressed - j.failed),
      0,
    ),
    pacedJobs: live.filter((j) => j.nextU < j.uChunks).length,
    oldestPendingHours: Math.round((oldest / 3_600_000) * 10) / 10,
  };
}

/** Tests only — clears memory and disk so suites start from empty. */
export function _resetForTest(): void {
  jobs.clear();
  jobKeys.clear();
  acceptedHashes.clear();
  attendeeSnapshots.clear();
  jobAborts.clear();
  jobLocks.clear();
  loaded = true;
  try {
    rmSync(JOBS_DIR, { recursive: true, force: true });
    rmSync(CHUNKS_DIR, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
  ensureDirs();
}

/** Tests only — drops the in-memory copy WITHOUT touching disk. Models a restart. */
export function _reloadForTest(): void {
  jobs.clear();
  jobKeys.clear();
  acceptedHashes.clear();
  attendeeSnapshots.clear();
  jobAborts.clear();
  loaded = false;
}
