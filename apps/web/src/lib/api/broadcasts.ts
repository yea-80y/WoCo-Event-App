/**
 * Background broadcast jobs — the client half of `/api/broadcasts`.
 *
 * Recipients only exist in plaintext in this browser: the contact list is
 * ECIES-sealed to the organiser's own key, so the server cannot enumerate it
 * and every send has to start with the client handing over the addresses.
 * Posting them as one array is what used to cap a broadcast at whatever fits in
 * an HTTP timeout; against a job id there is no per-request ceiling.
 *
 * Three calls, in order:
 *   1. `POST /jobs`             — subject, body, kind. Returns a job id.
 *   2. `POST /jobs/:id/chunk`   — up to 500 recipients at a time.
 *   3. `POST /jobs/:id/start`   — with what we uploaded, so the server can
 *                                 refuse a job whose upload was incomplete.
 *
 * Then poll `GET /jobs/:id`. The send outlives the page — closing the tab does
 * not stop it, and reopening shows where it got to.
 */

import { authPost, authGet } from "./client.js";

export type BroadcastJobKind = "marketing" | "event";

export type BroadcastJobState =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "died"
  | "expired";

export interface BroadcastJobStatus {
  jobId: string;
  kind: BroadcastJobKind;
  eventId?: string;
  state: BroadcastJobState;
  subject: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  expiresAt: string;
  accepted: number;
  sent: number;
  suppressed: number;
  failed: number;
  /** Duplicates, and anyone a resumed job had already mailed. */
  skipped: number;
  remaining: number;
  chunkCount: number;
  drainedChunks: number;
  /** Why a job ended without completing. Shown verbatim — it is written for the organiser. */
  reason?: string;
  resumeOf?: string;
  errors?: string[];
  /** True when re-running it would mail exactly the people who were missed. */
  resumable: boolean;
  note?: string;
}

export interface BroadcastRecipient {
  email: string;
  name?: string;
}

/** Matches the server's per-chunk ceiling. */
const CHUNK_SIZE = 500;

export interface StartBroadcastInput {
  kind: BroadcastJobKind;
  /** Omitted on a resume — the server re-sends the message it already holds. */
  subject?: string;
  htmlBody?: string;
  recipients: BroadcastRecipient[];
  /** `marketing` only — the display name the email is from. */
  fromName?: string;
  /** `event` only. */
  eventId?: string;
  /** Re-run a job that died or ended with failures, mailing only the remainder. */
  resumeOf?: string;
  /** Upload progress, so a 20,000-contact list is not a frozen button. */
  onUpload?: (uploaded: number, total: number) => void;
}

/**
 * Create, fill and start a job. Resolves once it is QUEUED, not once it has
 * sent — the whole point is that sending outlives the request.
 */
export async function startBroadcast(input: StartBroadcastInput): Promise<BroadcastJobStatus> {
  const created = await authPost<BroadcastJobStatus>("/api/broadcasts/jobs", {
    kind: input.kind,
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
    ...(input.fromName ? { fromName: input.fromName } : {}),
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.resumeOf ? { resumeOf: input.resumeOf } : {}),
  });
  if (!created.data) throw new Error(created.error || "Could not start the broadcast");
  const jobId = created.data.jobId;

  // Tally what the SERVER said it took, not what we sent. The two are allowed
  // to differ — it drops duplicates and anyone a resumed job already mailed —
  // and it is the server's numbers that `start` is checked against.
  let uploadedChunks = 0;
  let uploadedRecipients = 0;

  for (let i = 0; i < input.recipients.length; i += CHUNK_SIZE) {
    const slice = input.recipients.slice(i, i + CHUNK_SIZE);
    const resp = await authPost<{ accepted: number; skipped: number }>(
      `/api/broadcasts/jobs/${jobId}/chunk`,
      { recipients: slice },
    );
    if (!resp.data) throw new Error(resp.error || "Could not upload your contacts");
    if (resp.data.accepted > 0) {
      uploadedChunks++;
      uploadedRecipients += resp.data.accepted;
    }
    input.onUpload?.(Math.min(i + slice.length, input.recipients.length), input.recipients.length);
  }

  if (uploadedRecipients === 0) {
    throw new Error("Everyone on this list has already received it.");
  }

  const started = await authPost<BroadcastJobStatus>(`/api/broadcasts/jobs/${jobId}/start`, {
    chunkCount: uploadedChunks,
    totalRecipients: uploadedRecipients,
  });
  if (!started.data) throw new Error(started.error || "Could not start the broadcast");
  return started.data;
}

export async function getBroadcastJob(jobId: string): Promise<BroadcastJobStatus> {
  const resp = await authGet<BroadcastJobStatus>(`/api/broadcasts/jobs/${jobId}`);
  if (!resp.data) throw new Error(resp.error || "Could not load the broadcast");
  return resp.data;
}

export async function listBroadcastJobs(): Promise<BroadcastJobStatus[]> {
  const resp = await authGet<{ jobs: BroadcastJobStatus[] }>("/api/broadcasts/jobs");
  return resp.data?.jobs ?? [];
}

/** Stops what has not gone out. Mail already sent cannot be recalled. */
export async function cancelBroadcastJob(jobId: string): Promise<BroadcastJobStatus> {
  const resp = await authPost<BroadcastJobStatus>(`/api/broadcasts/jobs/${jobId}/cancel`, {});
  if (!resp.data) throw new Error(resp.error || "Could not cancel the broadcast");
  return resp.data;
}

export function isBroadcastFinished(job: BroadcastJobStatus): boolean {
  return ["completed", "cancelled", "died", "expired"].includes(job.state);
}

/**
 * Poll until the job stops. Every two seconds: fast enough that a small
 * broadcast feels immediate, slow enough that a half-hour one is ~900 requests
 * rather than nine thousand.
 *
 * A poll that fails is NOT treated as the job failing — a dropped connection
 * says nothing about a send running on the server. It keeps trying, and gives
 * up only after several consecutive failures.
 */
export async function pollBroadcast(
  jobId: string,
  onUpdate: (job: BroadcastJobStatus) => void,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<BroadcastJobStatus | null> {
  const interval = opts.intervalMs ?? 2_000;
  let consecutiveErrors = 0;

  for (;;) {
    if (opts.signal?.aborted) return null;
    try {
      const job = await getBroadcastJob(jobId);
      consecutiveErrors = 0;
      onUpdate(job);
      if (isBroadcastFinished(job)) return job;
    } catch (err) {
      if (++consecutiveErrors >= 5) throw err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
