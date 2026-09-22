/**
 * The background sender. Two jobs, one worker, because they are the same
 * machinery: drain queued broadcasts, and re-send what the send path gave up on.
 *
 * SCHEDULING. One chunk at a time, globally. The rate limiter is account-wide,
 * so running two jobs at once buys no throughput — only memory and confusing
 * progress. What it does buy is FAIRNESS, and that is why the rotation is at
 * chunk granularity rather than job granularity: strict FIFO would park a
 * 200-attendee "the doors have moved" notice behind a stranger's 20,000-contact
 * marketing blast for half an hour. Event broadcasts go first within the
 * rotation for the same reason ticket email outranks marketing in the limiter —
 * attendee mail is closer to operational than promotional.
 *
 * WHAT IT WILL NOT DO. It cannot recall a message already handed to SES. Cancel
 * and TTL stop what has not been sent; every ESP that publishes its semantics
 * says the same, and promising otherwise would be a lie an organiser acts on.
 *
 * PACING (#619). A marketing job's contacts were split at seal into those the
 * sender has already reached (`p`, drained straight away) and those new to the
 * platform (`u`, released in batches). Before each new batch the worker asks
 * `sender-pacing` for permission; between batches the job simply is not
 * runnable until `nextBatchAt`. Holding, waiting and stopping are decided
 * there, not here — this loop only does what it is told.
 */

import { PACING_CHUNK } from "@woco/shared";
import {
  broadcastQueueHealth,
  finishJob,
  hasChunksLeft,
  isTerminal,
  jobSignal,
  liveJobsFor,
  readChunk,
  recordChunkDrained,
  runnableJobs,
  saveJob,
  sweep,
  type BroadcastJob,
  type JobWaiting,
} from "./broadcast-jobs.js";

type JobWaitingKind = JobWaiting["for"];
import {
  sendMarketingBatch,
  type MarketingSendDeps,
  type MarketingSendResult,
} from "./marketing-send.js";
import { resendAbandoned } from "./send.js";
import { hashEmail } from "../event/claim-service.js";
import { bumpRetry, listFailures, resolveFailure } from "./failure-ledger.js";
import { reconcileReservation, recordSend } from "../marketing/send-cap.js";
import { isGloballySuppressed } from "../marketing/suppression-store.js";
import { forgetRetries, requeue, takeDue, retryQueueStats } from "./retry-queue.js";
import {
  admit,
  mayDrain,
  openBatch,
  onPacingStateChange,
  pacingState,
  pacingWindow,
  recordAccepted,
  sweepPacing,
  type PacingState,
} from "../sender-pacing/index.js";
import { pacingNotice, stoppedMessage } from "./pacing-copy.js";

/** The daily-cap reservation made at start stops counting after this. */
const CAP_WINDOW_MS = 24 * 60 * 60_000;

/** How often the worker looks for something to do when it is otherwise idle. */
const TICK_MS = 2_000;

/**
 * Outbound seam, matching `MarketingSendDeps` elsewhere in this directory.
 * Production is `undefined`, which makes `sendMarketingBatch` use the real
 * chokepoint; tests substitute a recorder so a full multi-chunk drain can be
 * asserted without AWS credentials or real time passing.
 */
let sendDeps: MarketingSendDeps | undefined;

/**
 * Failures that mean the ACCOUNT cannot send, not that this message was bad.
 *
 * Grinding through 19,000 more recipients against a paused account or an
 * exhausted daily quota burns the retry budget, fills the ledger with identical
 * entries, and delays the only thing that helps — an operator noticing. AWS's
 * own guidance on a daily-quota rejection is to wait, not to retry.
 */
const ACCOUNT_LEVEL_STOP =
  /SendingPausedException|AccountSuspendedException|ACCOUNT_SENDING_PAUSED|Daily message quota exceeded|ACCOUNT_DAILY_QUOTA_EXCEEDED/i;

/**
 * The from-address is not a sending identity the provider will accept.
 *
 * Same "no recipient in this job can succeed" shape as the account-level stops,
 * different cause and different fix, so it carries its own message rather than
 * telling an operator to wait for a quota that was never the problem.
 *
 * `MailFromDomainNotVerifiedException` is SES's named exception ("The message
 * can't be sent because the sending domain isn't verified"); an unverified
 * address surfaces instead as `MessageRejected` carrying "Email address is not
 * verified", so match that text rather than the exception name — plain
 * `MessageRejected` also covers genuinely per-message content rejections.
 *
 * `domain is not verified` covers Resend, which words it differently ("The X
 * domain is not verified. Please, add and verify your domain"). Resend is the
 * rollback lever and is scheduled for deletion, but a stop that silently stops
 * working the moment you pull the lever is worse than no stop.
 *
 * Every alternative contains a space, which is what makes them unforgeable:
 * recipient addresses pass `MAILABLE_EMAIL_RE` and domains `HOSTNAME_RE`, neither of
 * which admits whitespace, so no organiser-supplied token echoed into a
 * provider error can match.
 *
 * This became reachable when the marketing from-address turned mandatory (#96):
 * the guard there checks that a value is PRESENT, and presence is not
 * verification. A typo, or setting it before DNS propagates, lands here.
 */
const FROM_IDENTITY_STOP =
  /MailFromDomainNotVerifiedException|Email address is not verified|domain is not verified/i;

/**
 * A failure every attempted recipient shares is an outage, not bad addresses —
 * one such failure among many successes is noise. Grinding the remaining 19,000
 * recipients through it burns the retry budget, fills the ledger with identical
 * entries, and delays the only thing that helps: an operator noticing.
 *
 * Returns the organiser-facing reason to settle the job with, or null to carry on.
 */
function stopReason(result: MarketingSendResult): string | null {
  if (result.failed === 0 || result.sent > 0) return null;
  const all = (re: RegExp) => result.failures.every((f) => re.test(f.message));

  if (all(ACCOUNT_LEVEL_STOP)) {
    return (
      "Sending is paused on the account or the daily quota is exhausted — " +
      "the broadcast was stopped rather than run into a wall. Resume it once sending is restored."
    );
  }
  if (all(FROM_IDENTITY_STOP)) {
    return (
      "The address this broadcast sends from is not verified with our email provider, so " +
      "every message was rejected. Nothing further was sent. Resume it once the sending " +
      "address is verified."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Broadcast draining
// ---------------------------------------------------------------------------

/** Last job served, so the rotation advances instead of re-picking the same one. */
let lastServed: string | null = null;

function pickNext(): BroadcastJob | null {
  const runnable = runnableJobs();
  if (runnable.length === 0) return null;
  const events = runnable.filter((j) => j.kind === "event");
  const pool = events.length > 0 ? events : runnable;
  const at = pool.findIndex((j) => j.id === lastServed);
  return pool[(at + 1) % pool.length]!;
}

/** Reconcile a finished job's daily-cap reservation down to what it really sent. */
export function settleReservation(job: BroadcastJob): void {
  if (job.kind !== "marketing" || !job.reserved) return;
  reconcileReservation(job.org, job.id, job.sent);
}

function settle(
  job: BroadcastJob,
  state: "completed" | "died" | "expired" | "cancelled" | "stopped",
  reason?: string,
): void {
  finishJob(job, state, reason);
  settleReservation(job);
}

/** Park a job until `until`, saying why. The worker will not pick it before then. */
function wait(job: BroadcastJob, kind: JobWaitingKind, until: number, message?: string): void {
  const at = new Date(until).toISOString();
  job.nextBatchAt = at;
  job.waiting = { for: kind, until: at, ...(message ? { message } : {}) };
  saveJob(job);
}

function holdKind(state: PacingState): JobWaitingKind {
  return state.kind === "held" && state.scope === "all" ? "complaint-hold" : "bounce-hold";
}

/**
 * A stop ends every live marketing job of that sender at once — between
 * groups of ten via the abort signal, with the payload destroyed and the
 * reservation settled. The job stays resumable; the resume's start is refused
 * until an operator lifts the stop.
 */
onPacingStateChange((sender, state) => {
  if (state.kind !== "stopped") return;
  const reason = stoppedMessage(state, pacingWindow(sender)) ?? "Stopped";
  for (const job of liveJobsFor(sender)) {
    if (job.kind !== "marketing") continue;
    settle(job, "stopped", reason);
    console.error(`[drain-worker] job ${job.id} stopped: sender ${sender} was stopped`);
  }
});

/**
 * A run is going again: whatever the job was waiting for is over, so the view
 * must stop saying "Paused" (Fable sign-off R3).
 */
function resumed(job: BroadcastJob, run: "p" | "u"): "p" | "u" {
  if (job.waiting || job.nextBatchAt) {
    delete job.waiting;
    delete job.nextBatchAt;
    saveJob(job);
  }
  return run;
}

/**
 * Which run to drain next, opening a batch of new contacts when one is due —
 * or null, having parked the job, when nothing may go yet.
 */
function nextRun(job: BroadcastJob): "p" | "u" | null {
  const paced = job.kind === "marketing";
  if (job.nextP < job.pChunks) {
    if (paced && !mayDrain(job.org, "p")) {
      const state = pacingState(job.org);
      wait(job, holdKind(state), Date.now() + 60_000, pacingNotice(state, pacingWindow(job.org)) ?? undefined);
      return null;
    }
    return resumed(job, "p");
  }
  if (job.nextU >= job.uChunks) return null;

  if (job.batch && job.batch.chunksLeft > 0) {
    if (!mayDrain(job.org, "u")) {
      const state = pacingState(job.org);
      wait(job, holdKind(state), Date.now() + 60_000, pacingNotice(state, pacingWindow(job.org)) ?? undefined);
      return null;
    }
    return resumed(job, "u");
  }

  const n = job.batchesStarted + 1;
  const remaining = job.unproven - job.nextU * PACING_CHUNK;
  const now = Date.now();
  const r = admit(job.org, `${job.id}:u${n}`, remaining, now);
  if (!r.ok) {
    const state = pacingState(job.org, now);
    switch (r.code) {
      case "STOPPED":
        settle(job, "stopped", stoppedMessage(state, pacingWindow(job.org, now)) ?? "Stopped");
        return null;
      case "HELD":
        wait(job, holdKind(state), r.retryAt ?? now + 60_000, pacingNotice(state, pacingWindow(job.org, now)) ?? undefined);
        return null;
      case "TOO_SOON":
        wait(job, "next-batch", r.retryAt ?? now + 60_000);
        return null;
      case "DAY_EXHAUSTED":
        wait(job, "day-ceiling", r.retryAt ?? now + 60 * 60_000);
        return null;
    }
  }
  job.batchesStarted = n;
  job.batch = { n, chunksLeft: Math.ceil(r.size / PACING_CHUNK), startedAt: new Date(now).toISOString() };
  delete job.waiting;
  delete job.nextBatchAt;
  // The start-time reservation ages out of the rolling 24h cap after a day, so
  // a batch sent after that would count for nothing. Record it instead.
  if (job.reservedAt && now - Date.parse(job.reservedAt) > CAP_WINDOW_MS) recordSend(job.org, r.size);
  saveJob(job);
  return "u";
}

async function drainOneChunk(job: BroadcastJob): Promise<void> {
  lastServed = job.id;

  if (Date.parse(job.expiresAt) <= Date.now()) {
    settle(job, "expired", "Ran past its time limit — the remaining recipients were destroyed");
    return;
  }

  const seq = nextRun(job);
  if (!seq) return;

  const index = seq === "p" ? job.nextP : job.nextU;
  const batchTag = seq === "p" ? "p" : `u${job.batch!.n}`;
  const recipients = readChunk(job.id, seq, index);
  if (!recipients) {
    // The payload is gone but the job is not finished: a restart wiped it, or
    // the TTL sweep beat us here. Either way there is nothing left to send, and
    // saying so is better than looping on a missing file.
    const unsent = Math.max(0, job.accepted - job.sent - job.suppressed - job.failed);
    settle(job, "died", `The recipients are no longer available — ${unsent} were not mailed`);
    return;
  }

  // Belt and braces against a double-send: the chunk was written before any of
  // it was sent, so if this job is a resume — or if a crash replayed a chunk —
  // anyone already delivered to, by this job or any it resumes, must be dropped
  // here rather than mailed twice.
  const alreadySent = new Set([...job.sentHashes, ...job.priorDelivered]);
  const fresh = recipients.filter((r) => !alreadySent.has(hashEmail(r.email)));

  // The record must exist before the first message goes: a hard bounce that
  // arrives mid-chunk and finds none is dropped (Fable sign-off R2).
  if (job.kind === "marketing") openBatch(job.org, `${job.id}:${batchTag}`, seq);

  let result: MarketingSendResult;
  try {
    result = await sendMarketingBatch(
      {
        organiserAddress: job.org,
        fromDisplayName: job.fromDisplayName,
        fromAddress: job.fromAddress,
        subject: job.subject,
        html: job.html,
        recipients: fresh,
        // Set from the job's fixed category, never from chunk content. A job
        // without one behaves exactly as before: suppression is absolute.
        ...(job.serviceType ? { serviceNotice: true as const } : {}),
        // Stops between in-flight groups, so a cancel or a TTL expiry takes
        // effect within ten messages instead of after the whole chunk.
        ...(jobSignal(job.id) ? { signal: jobSignal(job.id)! } : {}),
        attribution: { job: job.id, batch: batchTag },
      },
      sendDeps,
    );
  } catch (err) {
    // sendMarketingBatch only throws when it CANNOT be compliant (no public API
    // base, no postal address). Retrying that per chunk would mail nobody and
    // never stop, so end the job and say why.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[drain-worker] job ${job.id} cannot send compliantly: ${msg}`);
    settle(job, "died", `Sending is misconfigured and the broadcast was stopped: ${msg}`);
    return;
  }

  // Recorded even if the job was cancelled mid-chunk: those messages really did
  // go out, and a counter that omitted them would tell the organiser fewer
  // people were mailed than actually were.
  const persisted = recordChunkDrained(job, seq, {
    sent: result.sent,
    suppressed: result.suppressed,
    crossed: result.crossed,
    failed: result.failed,
    sentHashes: result.sentHashes,
    // Hash-prefixed. The organiser is the controller of these addresses, but a
    // job record persists, and the marketing path's whole posture is that a
    // stored broadcast never becomes a plaintext copy of the list.
    errors: result.failures.map((f) => `${f.hash.slice(0, 8)}…: ${f.message}`),
  });

  if (!persisted) {
    // The sent record did not reach disk, so continuing would widen the gap
    // between what we sent and what we can prove. Stop and say so.
    settle(job, "died", "Could not record what was sent — the broadcast was stopped to avoid duplicates");
    return;
  }

  if (job.kind === "marketing") recordAccepted(job.org, `${job.id}:${batchTag}`, seq, result.sentHashes);
  if (seq === "u" && job.batch) {
    job.batch.chunksLeft--;
    // A finished batch just closes. The wait before the next one is the
    // ledger's to say — the next pick asks `admit`, which answers TOO_SOON with
    // the time — so the gap has exactly one source.
    if (job.batch.chunksLeft <= 0) delete job.batch;
    saveJob(job);
  }

  // A cancel (or a TTL expiry) may have landed while this chunk was in flight.
  // `finishJob` sets state unconditionally, so falling through to the completed
  // branch below would overwrite "cancelled" and tell the organiser the send
  // they stopped had finished normally.
  if (isTerminal(job)) return;

  const stop = stopReason(result);
  if (stop) {
    settle(job, "died", stop);
    console.error(`[drain-worker] job ${job.id} stopped: ${stop}`);
    return;
  }

  if (!hasChunksLeft(job)) {
    settle(job, "completed");
    console.log(
      `[drain-worker] job ${job.id} finished — sent=${job.sent} suppressed=${job.suppressed} ` +
        `failed=${job.failed} skipped=${job.skipped}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ledger retries
// ---------------------------------------------------------------------------

async function runDueRetries(): Promise<void> {
  const due = takeDue();
  if (due.length === 0) return;
  // An operator may have resolved an entry by hand in the window between it
  // becoming due and this loop reaching it. `forgetRetries` cannot help there —
  // the item has already left the queue — so the entry is re-read here, and a
  // resolved one is dropped rather than re-sent on top of a manual resend.
  const unresolved = new Set(
    listFailures({ limit: Number.MAX_SAFE_INTEGER }).map((e) => e.id),
  );

  for (const item of due) {
    if (!unresolved.has(item.entryId)) continue;
    const failure = await resendAbandoned(item.msg, item.priority);
    if (!failure) {
      resolveFailure(item.entryId, "drain-worker");
      forgetRetries(item.entryId);
      console.log(`[drain-worker] Retry delivered ledger entry ${item.entryId}`);
      continue;
    }

    bumpRetry(item.entryId, failure.message);

    // A failure that turned permanent between attempts (address now rejected,
    // domain unverified) will not become deliverable by waiting.
    if (!failure.retryable || !requeue(item)) {
      console.error(
        `[drain-worker] Giving up on ledger entry ${item.entryId} after ${item.attempt + 1} ` +
          `retr${item.attempt === 0 ? "y" : "ies"} — it stays unresolved for /api/ops/email-failures`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let pumping = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  // Draft jobs are why this exists at all: nothing else ever visits a
  // half-uploaded broadcast, so without a sweep its plaintext recipients would
  // sit on disk until the next restart, well past the TTL the inventory states.
  for (const expired of sweep(now)) settleReservation(expired);
  // Proof promotion, the 7-day window, and holds lifting with time.
  sweepPacing(isGloballySuppressed, now);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    // BETWEEN EVERY CHUNK, not once per tick. A 20,000-recipient job occupies
    // this loop for ~28 minutes; running the sweep and the ticket retries only
    // on entry meant an abandoned draft outlived its 15-minute TTL exactly when
    // the system was busiest, and a paid buyer's ticket retry due in 60 seconds
    // waited half an hour behind a marketing blast — inverting the one rule
    // this whole subsystem is built on.
    for (;;) {
      maybeSweep();
      await runDueRetries();
      const job = pickNext();
      if (!job || isTerminal(job)) break;
      await drainOneChunk(job);
    }
  } catch (err) {
    // The worker must survive anything one job can throw. A crash here would
    // stop every other organiser's broadcast and every pending ticket retry.
    console.error("[drain-worker] tick threw:", err);
  } finally {
    pumping = false;
  }
}

/** Run the loop now — called when a job is started, so it does not wait a tick. */
export function kickDrainWorker(): void {
  void pump();
}

export function startDrainWorker(): void {
  if (timer) return;
  timer = setInterval(() => void pump(), TICK_MS);
  timer.unref?.();
  console.log("[drain-worker] Background broadcast + retry worker started");
}

export function stopDrainWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** For /api/health. Counts only — this endpoint is public. */
export function drainWorkerHealth() {
  return { ...broadcastQueueHealth(), retries: retryQueueStats() };
}

/** Tests only — one pass of the loop, awaited. */
export async function _pumpOnceForTest(): Promise<void> {
  await pump();
}

/** Tests only — clears the rotation cursor between cases. */
export function _resetDrainWorkerForTest(deps?: MarketingSendDeps): void {
  lastServed = null;
  lastSweep = Date.now();
  sendDeps = deps;
}
