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
 */

import {
  broadcastQueueHealth,
  finishJob,
  isTerminal,
  jobSignal,
  readChunk,
  recordChunkDrained,
  runnableJobs,
  sweep,
  type BroadcastJob,
} from "./broadcast-jobs.js";
import {
  sendMarketingBatch,
  type MarketingSendDeps,
  type MarketingSendResult,
} from "./marketing-send.js";
import { resendAbandoned } from "./send.js";
import { hashEmail } from "../event/claim-service.js";
import { bumpRetry, listFailures, resolveFailure } from "./failure-ledger.js";
import { reconcileReservation } from "../marketing/send-cap.js";
import { forgetRetries, requeue, takeDue, retryQueueStats } from "./retry-queue.js";

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
 * recipient addresses pass `EMAIL_RE` and domains `HOSTNAME_RE`, neither of
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
  state: "completed" | "died" | "expired" | "cancelled",
  reason?: string,
): void {
  finishJob(job, state, reason);
  settleReservation(job);
}

async function drainOneChunk(job: BroadcastJob): Promise<void> {
  lastServed = job.id;

  if (Date.parse(job.expiresAt) <= Date.now()) {
    settle(job, "expired", "Ran past its time limit — the remaining recipients were destroyed");
    return;
  }

  const index = job.nextChunk;
  const recipients = readChunk(job.id, index);
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
  // anyone already delivered to must be dropped here rather than mailed twice.
  const alreadySent = new Set(job.sentHashes);
  const fresh = recipients.filter((r) => !alreadySent.has(hashEmail(r.email)));

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
        // Stops between in-flight groups, so a cancel or a TTL expiry takes
        // effect within ten messages instead of after the whole chunk.
        ...(jobSignal(job.id) ? { signal: jobSignal(job.id)! } : {}),
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
  const persisted = recordChunkDrained(job, {
    sent: result.sent,
    suppressed: result.suppressed,
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

  if (job.nextChunk >= job.chunkCount) {
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
