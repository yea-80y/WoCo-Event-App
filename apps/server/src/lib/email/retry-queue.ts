/**
 * Messages waiting to be re-sent after `send.ts` gave up on them.
 *
 * WHY IT IS IN MEMORY. Retrying a ledger entry is not possible: the ledger
 * records that a message failed, not the message. A ticket email cannot be
 * rebuilt from it — that needs the signed QR payload and a ~100KB composite
 * PNG, and persisting those would create a durable copy of ticket material with
 * its own retention and erasure obligations, to widen a window that does not
 * need widening. SES outages are minutes to hours
 * (docs/SES_MIGRATION_HANDOVER.md §3a), so a queue that lives as long as the
 * process covers the case it exists for.
 *
 * WHAT HAPPENS ON RESTART. The queue is lost, the ledger entry stays
 * unresolved, `/api/health` keeps reporting it, and remediation moves to
 * `/api/ops/email-failures`. That is a worse outcome than an automatic retry
 * and a much better one than the silent `console.error` this all replaced.
 *
 * NO LEDGER WRITES HAPPEN HERE. A retry that re-entered `sendVia` would write a
 * NEW failure entry per attempt — five backoff rounds over a thirty-message
 * outage is 150 entries, each transactional one carrying another plaintext copy
 * of the buyer's address, each exempt from the size cap because unresolved
 * transactional entries are protected. The drain worker updates the EXISTING
 * entry instead.
 *
 * This module deliberately imports nothing from `send.ts`. Under ESM an import
 * cycle through that file resolves `EmailSendError` as `undefined` and every
 * `instanceof` in the retry path fails open — the exact bug that forced
 * `types.ts` to be split out in the first place.
 */

import type { OutboundEmail } from "./types.js";
import type { SendPriority } from "./rate-limiter.js";

/**
 * Backoff for a provider that is down rather than a message that is bad.
 *
 * Much longer than the in-request retry (500ms–8s): that one is riding out a
 * throttle, this one is waiting for an outage to end. Five steps over ~2 hours,
 * and then the entry is left for a human — a message still undeliverable after
 * two hours is not going to be fixed by a sixth attempt.
 */
export const RETRY_SCHEDULE_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

/**
 * Bounded by BYTES, not entries. Each queued ticket email holds its rendered
 * attachments in memory, so "1,000 messages" is a meaningless bound — it is
 * anywhere from 100KB to 100MB depending on what failed.
 */
const MAX_QUEUE_BYTES = 25 * 1024 * 1024;

export interface RetryItem {
  /** Ledger entry this retry belongs to — updated, never duplicated. */
  entryId: string;
  msg: OutboundEmail;
  priority: SendPriority;
  /** Retries already made by the worker. Indexes RETRY_SCHEDULE_MS. */
  attempt: number;
  dueAt: number;
  bytes: number;
}

const queue: RetryItem[] = [];
let queuedBytes = 0;

/** Rough in-memory footprint. Attachments dominate; the rest is noise. */
function sizeOf(msg: OutboundEmail): number {
  let n = (msg.subject?.length ?? 0) + (msg.html?.length ?? 0) + (msg.text?.length ?? 0);
  for (const a of msg.attachments ?? []) {
    n += a.content.byteLength;
  }
  return n;
}

/**
 * Queue a message the send path abandoned.
 *
 * @returns false when the message was not queued — the queue is full, or the
 *   failure was permanent and a retry would fail identically.
 */
export function enqueueRetry(
  entryId: string,
  msg: OutboundEmail,
  priority: SendPriority,
  now = Date.now(),
): boolean {
  const bytes = sizeOf(msg);
  if (queuedBytes + bytes > MAX_QUEUE_BYTES) {
    // Refuse rather than evict. The ledger entry is already written and already
    // alarming, so the failure is visible either way; silently dropping an
    // older message to make room would trade a known unretried send for an
    // unknown one.
    console.warn(
      `[email-retry] Queue is full (${Math.round(queuedBytes / 1024)}KB) — ` +
        `ledger entry ${entryId} will not be retried automatically`,
    );
    return false;
  }
  queue.push({
    entryId,
    msg,
    priority,
    attempt: 0,
    dueAt: now + RETRY_SCHEDULE_MS[0]!,
    bytes,
  });
  queuedBytes += bytes;
  return true;
}

/** Items whose backoff has elapsed, removed from the queue. */
export function takeDue(now = Date.now()): RetryItem[] {
  const due: RetryItem[] = [];
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.dueAt > now) continue;
    due.push(...queue.splice(i, 1));
  }
  for (const item of due) queuedBytes -= item.bytes;
  return due.reverse();
}

/**
 * Put a failed retry back with the next backoff step.
 *
 * @returns false when the schedule is exhausted — the caller should leave the
 *   ledger entry unresolved for a human rather than retrying forever.
 */
export function requeue(item: RetryItem, now = Date.now()): boolean {
  const next = item.attempt + 1;
  const delay = RETRY_SCHEDULE_MS[next];
  if (delay === undefined) return false;
  item.attempt = next;
  item.dueAt = now + delay;
  queue.push(item);
  queuedBytes += item.bytes;
  return true;
}

/** Drop everything queued for a ledger entry — it was resolved by hand. */
export function forgetRetries(entryId: string): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.entryId !== entryId) continue;
    queuedBytes -= queue[i]!.bytes;
    queue.splice(i, 1);
  }
}

export function retryQueueStats(): { pending: number; bytes: number } {
  return { pending: queue.length, bytes: queuedBytes };
}

/** Tests only. */
export function _resetRetryQueueForTest(): void {
  queue.length = 0;
  queuedBytes = 0;
}
