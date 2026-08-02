/**
 * /api/broadcasts — the chunked job API that replaced inline broadcast sending.
 *
 * WHY CHUNKED. The organiser's contact list is sealed to their own key and
 * decrypted in their browser, so the recipients can only ever arrive from the
 * client. Taking them as one array in one request is what capped a broadcast at
 * whatever fits in an HTTP timeout. Against a job id
 * (`POST /jobs` → `POST /jobs/:id/chunk` → `POST /jobs/:id/start`) there is no
 * per-request ceiling, and the same shape works unchanged if sealed lists later
 * arrive in pages — so it does not force the list-cap decision (#101) either
 * way.
 *
 * ONE SURFACE, TWO KINDS. `marketing` mails an imported audience;
 * `event` mails the attendees of one event. They differ only in who may be
 * mailed and what bounds it, and both end up in the same worker through the
 * same compliance path (`sendMarketingBatch` — suppression, RFC 8058 headers,
 * provenance footer, postal address, all unconditional).
 *
 * WHERE THE GATES RUN. Per-RECIPIENT gates run per chunk, at upload:
 * membership of the imported list, or of the event's attendee snapshot.
 * Per-BROADCAST gates — the hourly rate window and the daily send cap — run at
 * `start`, under the organiser mutex, because that is the last moment before
 * anything is sent and the first at which the total is known.
 *
 * THE DRAIN NEVER TAKES THAT MUTEX. `withOrgLock` is a promise chain: anything
 * queued behind a 28-minute occupant waits 28 minutes. Holding it across a
 * drain would hang the organiser's own list, suppress and check calls until
 * Cloudflare killed them. It is held for gate-check + reserve + state-flip only.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { getEventForOwner } from "../lib/event/service.js";
import { getAttendeeEmailHashes } from "../lib/event/attendee-emails.js";
import { isVerifiedOrganiser } from "../lib/stripe/verification.js";
import { getList, withOrgLock } from "../lib/marketing/list-store.js";
import { capRemaining, reserveSend } from "../lib/marketing/send-cap.js";
import { resolveMarketingFrom } from "../lib/marketing/sending-domain-store.js";
import { RateWindow } from "../lib/marketing/rate-window.js";
import { checkEmailProviderConfig } from "../lib/email/send.js";
import { kickDrainWorker, settleReservation } from "../lib/email/drain-worker.js";
import {
  appendChunk,
  attendeeSnapshot,
  BroadcastJobError,
  cancelJob,
  createJob,
  getJob,
  isTerminal,
  listJobsForOrg,
  markReserved,
  MAX_CHUNK_RECIPIENTS,
  MAX_JOB_RECIPIENTS,
  sealAndQueue,
  withJobLock,
  type BroadcastJob,
  type BroadcastJobKind,
  type JobRecipient,
} from "../lib/email/broadcast-jobs.js";

const broadcastJobs = new Hono<AppEnv>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Unchanged from the inline routes: 2 marketing / 5 attendee broadcasts an hour. */
const MARKETING_PER_HOUR = 2;
const EVENT_PER_HOUR = 5;
const RATE_WINDOW_MS = 3_600_000;
const marketingRate = new RateWindow(MARKETING_PER_HOUR, RATE_WINDOW_MS);
const eventRate = new RateWindow(EVENT_PER_HOUR, RATE_WINDOW_MS);

// The former per-request caps (1,000 marketing, 500 attendee) existed only
// because the send ran inside the request; with a queue they measure nothing.
// What bounds a broadcast now is who may be mailed — the attendee snapshot, or
// the organiser's own stored list — and MAX_JOB_RECIPIENTS, which the job store
// derives from the single list-cap constant rather than inventing a second one.

/** What the organiser is shown. No plaintext, and no `html` — they wrote it. */
function jobView(job: BroadcastJob) {
  return {
    jobId: job.id,
    kind: job.kind,
    ...(job.eventId ? { eventId: job.eventId } : {}),
    state: job.state,
    subject: job.subject,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    expiresAt: job.expiresAt,
    accepted: job.accepted,
    sent: job.sent,
    suppressed: job.suppressed,
    failed: job.failed,
    skipped: job.skipped,
    remaining: Math.max(0, job.accepted - job.sent - job.suppressed - job.failed),
    chunkCount: job.chunkCount,
    drainedChunks: job.nextChunk,
    ...(job.reason ? { reason: job.reason } : {}),
    ...(job.resumeOf ? { resumeOf: job.resumeOf } : {}),
    ...(job.errors.length ? { errors: job.errors.slice(0, 10) } : {}),
    /**
     * Failed recipients are absent from `sentHashes`, so resuming this job
     * retries exactly the remainder. That is the remediation path — the stored
     * errors are hash-prefixed and tell the organiser nothing they can act on
     * directly, by design.
     */
    resumable: isTerminal(job) && job.state !== "cancelled" && job.sent < job.accepted,
  };
}

/** Ownership is checked here, never inferred from the job id. */
function ownedJob(id: string, org: string): BroadcastJob | null {
  const job = getJob(id);
  return job && job.org === org.toLowerCase() ? job : null;
}

function jobErrorStatus(code: string): 400 | 404 | 409 {
  if (code === "NOT_FOUND") return 404;
  if (code === "INCOMPLETE" || code === "NOT_DRAFT") return 409;
  return 400;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

broadcastJobs.post("/jobs", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;

  // The ACTIVE provider's config, not Resend's. Post-cutover, checking for
  // RESEND_API_KEY would 500 every broadcast while SES sends perfectly well.
  const providerConfig = checkEmailProviderConfig();
  if (!providerConfig.ok) {
    return c.json(
      { ok: false, error: `Email is not configured (${providerConfig.missing.join(", ")})` },
      500,
    );
  }

  const kind = body.kind as BroadcastJobKind;
  if (kind !== "marketing" && kind !== "event") {
    return c.json({ ok: false, error: "kind must be 'marketing' or 'event'" }, 400);
  }

  // A resume inherits the prior job's delivered set, so it must be the SAME
  // organiser's job — otherwise a stranger's job id would seed one broadcast's
  // skip list from another's, which is both a leak and a way to silently
  // suppress recipients.
  const resumeOf = typeof body.resumeOf === "string" ? body.resumeOf : undefined;
  let prior: BroadcastJob | null = null;
  if (resumeOf) {
    prior = ownedJob(resumeOf, org);
    if (!prior) return c.json({ ok: false, error: "No such broadcast to resume" }, 404);
    if (!isTerminal(prior)) {
      return c.json({ ok: false, error: "That broadcast is still running" }, 409);
    }
    if (prior.kind !== kind) {
      return c.json({ ok: false, error: "Cannot resume a broadcast of a different kind" }, 400);
    }
  }

  // A resume is the SAME message, always: the content comes from the job being
  // resumed and anything supplied is ignored. Two reasons. The client cleared
  // its compose box the moment the first job queued — it has nothing left to
  // send — and, more importantly, a resume carries the prior job's delivered
  // set as a skip list. Letting a different body ride that skip list would be a
  // way to send a message while silently excluding chosen recipients.
  const subject = prior ? prior.subject : typeof body.subject === "string" ? body.subject.trim() : "";
  const htmlBody = prior ? prior.html : typeof body.htmlBody === "string" ? body.htmlBody : "";
  if (!subject || subject.length > 200) {
    return c.json({ ok: false, error: "Subject required (max 200 chars)" }, 400);
  }
  if (!htmlBody || htmlBody.length > 50_000) {
    return c.json({ ok: false, error: "Body required (max 50KB)" }, 400);
  }

  let fromDisplayName: string;
  let job: BroadcastJob;

  if (kind === "marketing") {
    // Sending on WoCo's reputation requires a Stripe-verified organiser (#59).
    // Attendee mail is deliberately NOT gated this way — see the event branch.
    if (!(await isVerifiedOrganiser(org))) {
      return c.json(
        {
          ok: false,
          error:
            "Connect and verify a Stripe account to send marketing (free — it verifies your identity and protects everyone's deliverability)",
          code: "STRIPE_VERIFICATION_REQUIRED",
        },
        403,
      );
    }
    fromDisplayName = prior
      ? prior.fromDisplayName
      : typeof body.fromName === "string" ? body.fromName.trim() : "";
    if (!fromDisplayName || fromDisplayName.length > 100) {
      return c.json({ ok: false, error: "fromName required (max 100 chars)" }, 400);
    }
    if (!getList(org)) {
      return c.json({ ok: false, error: "Import an audience before broadcasting" }, 400);
    }
    job = createJob({
      org,
      kind,
      subject,
      html: htmlBody,
      fromDisplayName,
      fromAddress: resolveMarketingFrom(org),
      ...(resumeOf ? { resumeOf } : {}),
    });
  } else {
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    if (!eventId) return c.json({ ok: false, error: "eventId required" }, 400);

    const event = await getEventForOwner(eventId, org);
    if (!event) return c.json({ ok: false, error: "Event not found" }, 404);
    if (event.creatorAddress.toLowerCase() !== org) {
      return c.json({ ok: false, error: "Only the event organiser can send broadcasts" }, 403);
    }

    // Snapshot the audience ONCE. Re-deriving it per chunk would be a Swarm read
    // per series per chunk, and a blip midway would make real attendees look
    // like strangers — "an unreadable page is not an empty page" all over again.
    const { hashes, unverifiableSeries, unreadableSeries } = await getAttendeeEmailHashes(event);
    if (unreadableSeries > 0) {
      // Refuse rather than bake a partial snapshot into a half-hour send.
      return c.json(
        {
          ok: false,
          error:
            "Could not read your attendee list just now — nothing has been sent. Try again in a moment.",
          code: "ATTENDEES_UNREADABLE",
        },
        503,
      );
    }

    // An on-chain series records the claimer only inside the sealed order blob,
    // so membership is unprovable server-side for those recipients. Fall back to
    // the marketing abuse gate for the unproven remainder only — in practice a
    // no-op, since an on-chain series is a paid Stripe series.
    const allowUnproven = unverifiableSeries > 0 && (await isVerifiedOrganiser(org));

    fromDisplayName = event.title;
    job = createJob({
      org,
      kind,
      eventId,
      subject,
      html: htmlBody,
      fromDisplayName,
      fromAddress: resolveMarketingFrom(org),
      attendees: { hashes, allowUnproven, hasUnverifiableSeries: unverifiableSeries > 0 },
      ...(resumeOf ? { resumeOf } : {}),
    });
  }

  return c.json({
    ok: true,
    data: { ...jobView(job), maxChunkRecipients: MAX_CHUNK_RECIPIENTS },
  });
});

// ---------------------------------------------------------------------------
// Chunk upload
// ---------------------------------------------------------------------------

broadcastJobs.post("/jobs/:id/chunk", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;
  const job = ownedJob(c.req.param("id"), org);
  if (!job) return c.json({ ok: false, error: "No such broadcast" }, 404);
  // State BEFORE membership. A job killed by a restart would otherwise fall
  // through to the membership check — whose snapshot died with it — and be told
  // its recipients are strangers, which is both false and unactionable.
  if (job.state !== "draft") {
    return c.json(
      {
        ok: false,
        error:
          job.state === "died"
            ? "This broadcast was interrupted before it started. Start a new one."
            : `This broadcast is ${job.state} and is no longer taking recipients.`,
        code: "NOT_DRAFT",
      },
      409,
    );
  }

  const raw = body.recipients;
  if (!Array.isArray(raw) || raw.length === 0) {
    return c.json({ ok: false, error: "At least one recipient required" }, 400);
  }
  if (raw.length > MAX_CHUNK_RECIPIENTS) {
    return c.json(
      { ok: false, error: `Maximum ${MAX_CHUNK_RECIPIENTS} recipients per chunk` },
      400,
    );
  }

  const recipients: JobRecipient[] = [];
  for (const r of raw as Array<{ email?: unknown; name?: unknown }>) {
    const email = typeof r?.email === "string" ? r.email.trim() : "";
    if (!email || !EMAIL_RE.test(email)) {
      return c.json({ ok: false, error: `Invalid email: ${String(r?.email)}` }, 400);
    }
    recipients.push({ email, ...(typeof r.name === "string" ? { name: r.name } : {}) });
  }

  if (job.accepted + recipients.length > MAX_JOB_RECIPIENTS) {
    return c.json(
      { ok: false, error: `A single broadcast cannot exceed ${MAX_JOB_RECIPIENTS} recipients` },
      400,
    );
  }

  // Membership. Rejecting the whole chunk rather than skipping the strangers in
  // it is deliberate: a silent skip would move a consent boundary into a number
  // nobody reads. The count is echoed, never the addresses — that would turn a
  // rejection into an oracle for "does this person hold a ticket".
  //
  // The predicate is built ONCE per chunk. Resolving the member set per
  // recipient rebuilds a 20,000-entry Set five hundred times per request.
  const isMember = memberTest(job);
  const unproven = recipients.filter((r) => !isMember(r.email));
  if (unproven.length > 0) {
    return job.kind === "marketing"
      ? c.json(
          {
            ok: false,
            error: `${unproven.length} recipient(s) are not in your imported audience — import them first`,
            code: "RECIPIENTS_NOT_IN_AUDIENCE",
          },
          403,
        )
      : attendeeSnapshot(job.id)?.hasUnverifiableSeries
        ? c.json(
            {
              ok: false,
              error:
                "Broadcasts for on-chain ticket series require a verified Stripe account — " +
                "this event has a series whose ticket holders we cannot check for you.",
              code: "STRIPE_VERIFICATION_REQUIRED",
            },
            403,
          )
        : c.json(
            {
              ok: false,
              error:
                `${unproven.length} of ${recipients.length} recipients have not claimed a ticket for ` +
                `this event. Event broadcasts can only go to your attendees — use your marketing ` +
                `audience for everyone else.`,
              code: "RECIPIENTS_NOT_ATTENDEES",
            },
            403,
          );
  }

  try {
    // Under the job lock: chunk indices are server-assigned and the AES-GCM AAD
    // binds a chunk to its index, so two concurrent uploads racing the numbering
    // would have one silently overwrite the other's recipients.
    const result = await withJobLock(job.id, () => appendChunk(job.id, recipients, hashEmail));
    return c.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof BroadcastJobError) {
      return c.json({ ok: false, error: err.message, code: err.code }, jobErrorStatus(err.code));
    }
    throw err;
  }
});

/**
 * Who this job may mail. Resolved once, then applied per recipient.
 *
 * Marketing reads the organiser's stored list index; event reads the attendee
 * snapshot taken when the job was created. Both are point-in-time by design —
 * the organiser is mailing the audience as it stood when they pressed send.
 */
function memberTest(job: BroadcastJob): (email: string) => boolean {
  if (job.kind === "marketing") {
    const members = new Set(getList(job.org)?.emailHashes ?? []);
    return (email) => members.has(hashEmail(email));
  }
  const snapshot = attendeeSnapshot(job.id);
  // Snapshot lost to a restart. The job is dead and the guard above has already
  // said so, but fail closed rather than waving recipients through.
  if (!snapshot) return () => false;
  if (snapshot.allowUnproven) return () => true;
  return (email) => snapshot.hashes.has(hashEmail(email));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

broadcastJobs.post("/jobs/:id/start", requireAuth, async (c) => {
  const org = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as Record<string, unknown>;
  const job = ownedJob(c.req.param("id"), org);
  if (!job) return c.json({ ok: false, error: "No such broadcast" }, 404);

  // The client states what it uploaded and we refuse on mismatch. Without this
  // a lost chunk POST — a flaky connection, a closed tab — produces a job that
  // drains, completes and reports success while a whole chunk of people were
  // never mailed. "Told 'sent' for mail that never went" is the failure this
  // work exists to eliminate; it would be a poor showing to rebuild it here.
  const chunkCount = Number(body.chunkCount);
  const totalRecipients = Number(body.totalRecipients);
  if (!Number.isInteger(chunkCount) || !Number.isInteger(totalRecipients)) {
    return c.json(
      { ok: false, error: "chunkCount and totalRecipients are required to start a broadcast" },
      400,
    );
  }

  const rate = job.kind === "marketing" ? marketingRate : eventRate;
  const perHour = job.kind === "marketing" ? MARKETING_PER_HOUR : EVENT_PER_HOUR;

  try {
    // Rate window, daily cap and the state flip together, so two concurrent
    // starts cannot both pass a check the other invalidates. Nothing slow runs
    // in here — the drain happens on the worker, outside the lock.
    const outcome = await withOrgLock(org, () => {
      if (rate.isLimited(org)) {
        return { rejected: `Rate limit exceeded (${perHour} broadcasts per hour)`, status: 429 } as const;
      }

      if (job.kind === "marketing") {
        // The cap has to bind BEFORE a half-hour send begins, so the whole
        // accepted count is reserved up front and corrected to what actually
        // went out when the job finishes (see reserveSend).
        const listSize = getList(org)?.emailHashes.length ?? 0;
        const remaining = capRemaining(org, listSize);
        if (job.accepted > remaining) {
          return {
            rejected: `Daily marketing send cap reached (${remaining} of your daily allowance remaining). Try a smaller batch or wait.`,
            status: 429,
          } as const;
        }
      }

      // `sealAndQueue` is idempotent, but everything after it is not: a client
      // retry after a lost response — or a second tab — would otherwise burn
      // the hourly window again AND append a second reservation under the same
      // jobId, only the first of which `reconcileReservation` can find. Do the
      // side effects only on the transition.
      const wasDraft = job.state === "draft";
      const queued = sealAndQueue(job.id, { chunkCount, totalRecipients });
      if (wasDraft) {
        rate.record(org);
        if (queued.kind === "marketing") {
          reserveSend(org, queued.accepted, queued.id);
          markReserved(queued, queued.accepted);
        }
      }
      return { queued } as const;
    });

    if ("rejected" in outcome) {
      return c.json({ ok: false, error: outcome.rejected }, outcome.status);
    }

    // Start draining now rather than on the next tick — an organiser watching
    // the progress bar should see it move immediately.
    kickDrainWorker();
    console.log(
      `[broadcasts] queued job=${outcome.queued.id} kind=${outcome.queued.kind} ` +
        `org=${org} recipients=${outcome.queued.accepted}`,
    );
    return c.json({ ok: true, data: jobView(outcome.queued) });
  } catch (err) {
    if (err instanceof BroadcastJobError) {
      return c.json({ ok: false, error: err.message, code: err.code }, jobErrorStatus(err.code));
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Status / cancel
// ---------------------------------------------------------------------------

broadcastJobs.get("/jobs", requireAuth, (c) => {
  const org = c.get("parentAddress").toLowerCase();
  return c.json({ ok: true, data: { jobs: listJobsForOrg(org).map(jobView) } });
});

broadcastJobs.get("/jobs/:id", requireAuth, (c) => {
  const job = ownedJob(c.req.param("id"), c.get("parentAddress"));
  if (!job) return c.json({ ok: false, error: "No such broadcast" }, 404);
  return c.json({ ok: true, data: jobView(job) });
});

broadcastJobs.post("/jobs/:id/cancel", requireAuth, (c) => {
  const job = ownedJob(c.req.param("id"), c.get("parentAddress"));
  if (!job) return c.json({ ok: false, error: "No such broadcast" }, 404);
  if (isTerminal(job)) return c.json({ ok: true, data: jobView(job) });

  // Stops what has not been sent. Mail already handed to SES cannot be
  // recalled, and the response says so rather than implying otherwise.
  cancelJob(job);
  // And hands back the unspent allowance. Without this a cancel at 5% leaves
  // the full reservation standing for 24 hours and every later broadcast is
  // refused — the organiser punished for stopping a send they got wrong, which
  // is the same "accounting blocks its own remedy" trap the died/expired paths
  // already close.
  settleReservation(job);
  return c.json({
    ok: true,
    data: {
      ...jobView(job),
      note: `${job.sent} message(s) had already been sent and cannot be recalled.`,
    },
  });
});

export { broadcastJobs };
