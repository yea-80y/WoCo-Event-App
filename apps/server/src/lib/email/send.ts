/**
 * The single outbound email chokepoint. Every send in the codebase goes through
 * `sendEmail` — no route or lib may import an ESP SDK directly.
 *
 * Beyond provider selection this layer owns the three things that have to be
 * true of every message regardless of who sent it:
 *
 *   1. RATE. SES caps the account's messages/second. A token bucket here shapes
 *      all traffic against one budget and lets transactional mail overtake
 *      marketing (see rate-limiter.ts).
 *   2. RETRY. Transient provider failures are retried with exponential backoff
 *      and jitter. Previously a throttle was recorded as `failed` and the
 *      recipient was never mailed.
 *   3. EVIDENCE. A send we finally abandon is written to a durable ledger, not
 *      a log line. See failure-ledger.ts for why that distinction cost us.
 *
 * Compliance note: this layer is deliberately dumb about CONTENT. Suppression,
 * unsubscribe headers and the provenance footer live in `marketing-send.ts`,
 * which is the only caller allowed to send non-transactional mail. Adding a
 * bypass here would defeat that control.
 */

import { getResend } from "./client.js";
import { sesProvider } from "./ses-provider.js";
import { sendRateLimiter, type SendPriority } from "./rate-limiter.js";
import { recordFailure } from "./failure-ledger.js";
import { enqueueRetry } from "./retry-queue.js";
import { buildMessageTags } from "./message-tags.js";
import { hashEmail } from "../event/claim-service.js";
import {
  EmailSendError,
  type EmailProvider,
  type OutboundEmail,
  type OutboundAttachment,
} from "./types.js";

export { EmailSendError };
export type { EmailProvider, OutboundEmail, OutboundAttachment };

/**
 * Resend is the operator ROLLBACK LEVER (`EMAIL_PROVIDER=resend`) and nothing
 * more. The automatic failover it used to back was deleted with this commit —
 * see `docs/SES_MIGRATION_HANDOVER.md` §3a, which called it a launch-window
 * crutch and named the drain worker as the thing that replaces it.
 *
 * Kept on the FREE tier deliberately: we do not pay for two ESPs
 * (docs/PRICING_AND_EMAIL.md §6). This adapter is scheduled for deletion.
 * Nothing new may be built on Resend.
 */
const resendProvider: EmailProvider = {
  name: "resend",
  async send(msg) {
    const { error } = await getResend().emails.send({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      ...(msg.html ? { html: msg.html } : {}),
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
      // `msg.tags` is deliberately NOT forwarded. Resend's tag shape and its
      // webhook echo are different, and its bounce handler does not read them,
      // so passing them would imply a correlation that does not exist. The
      // consequence — async bounces are not ledgered while the rollback lever is
      // pulled — is reported by /api/health as `bounceLedger: "unsupported"`
      // rather than left to be discovered.
    } as Parameters<ReturnType<typeof getResend>["emails"]["send"]>[0]);
    if (error) {
      // The SDK returns rate limiting and 5xx in the same `error` shape as a
      // rejected address, so classify on what it gives us: name, then message.
      const name = (error as { name?: string }).name ?? "";
      const retryable =
        name === "rate_limit_exceeded" ||
        name === "application_error" ||
        name === "internal_server_error" ||
        /rate limit|too many requests|timeout|temporarily/i.test(error.message);
      throw new EmailSendError(`Resend ${name || "error"}: ${error.message}`, {
        retryable,
        ...(name ? { code: name } : {}),
      });
    }
  },
};

const PROVIDERS: Record<string, EmailProvider> = {
  ses: sesProvider,
  resend: resendProvider,
};

let provider: EmailProvider | null = null;

function providerByName(name: string): EmailProvider {
  const p = PROVIDERS[name];
  // Fail loud: a typo in EMAIL_PROVIDER must not silently drop ticket email.
  if (!p) throw new Error(`Unknown email provider "${name}" (expected "ses" or "resend")`);
  return p;
}

function selectProvider(): EmailProvider {
  if (!provider) provider = providerByName(activeEmailProvider());
  return provider;
}

/** Tests only — drops the memoised provider so env changes take effect. */
export function _resetProviderForTest(): void {
  provider = null;
}

export interface SendEmailOptions {
  /**
   * Transactional (default) always drains ahead of marketing at the rate
   * limiter, and its abandoned sends are recorded with the plaintext recipient
   * so a paid-for ticket can actually be chased.
   */
  priority?: SendPriority;
  /** Breadcrumbs stored alongside a failure, e.g. `{ eventId, seriesId }`. */
  context?: Record<string, string>;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /**
   * Suppress the ledger write and the retry-queue hand-off. Set only by the
   * drain worker, which is re-sending a message the ledger already holds an
   * entry for and must update rather than duplicate.
   */
  noLedger?: boolean;
}

/** Base backoff. Doubles per attempt, then gets full jitter applied. */
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  // Full jitter. Without it, a throttle rejects a chunk of messages at the same
  // instant and they all come back at the same instant, re-creating the burst
  // that caused the throttle.
  return Math.random() * ceiling;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send one message.
 *
 * Rejects if the message could not be delivered after every attempt — callers
 * that must not fail the request (the Stripe webhook) should catch, but the
 * failure is already in the ledger by then, so a swallowed rejection no longer
 * means a lost ticket.
 */
/**
 * Injectable seam, same shape as `MarketingSendDeps`. Production always resolves
 * these from env; tests supply fake providers so the retry, failover and ledger
 * behaviour can be asserted directly rather than through AWS credentials.
 */
export interface SendDeps {
  primary: EmailProvider;
  /**
   * Second provider to try when the primary is down. Production always passes
   * null — `EMAIL_FALLBACK_PROVIDER` was deleted once the drain worker landed.
   * The seam stays because the failover BEHAVIOUR (transactional only, never on
   * a permanent error) is worth keeping under test: if a second funded provider
   * is ever added, this is where it goes, and the rules should not be rewritten
   * from scratch at that point.
   */
  secondary: EmailProvider | null;
  sleep: (ms: number) => Promise<void>;
  /** Defaults to the shared account-wide token bucket. */
  acquire?: (priority: SendPriority) => Promise<void>;
}

/**
 * One provider, with retries.
 *
 * `attempts` is the number of provider calls actually made — not a guess
 * derived from `retryable`. The ledger is an evidence record, and "3 attempts"
 * on a message the provider was asked to send once is a claim about our own
 * conduct that would not survive being checked.
 */
interface AttemptOutcome {
  error: EmailSendError | null;
  attempts: number;
}

async function attemptWithRetries(
  p: EmailProvider,
  msg: OutboundEmail,
  priority: SendPriority,
  maxAttempts: number,
  sleepFn: (ms: number) => Promise<void>,
  acquire: (priority: SendPriority) => Promise<void>,
): Promise<AttemptOutcome> {
  let lastError: EmailSendError | undefined;
  let made = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Acquire per ATTEMPT, not once per message: a retry is another message on
      // the wire and must be counted against the same account-wide budget.
      //
      // INSIDE the try deliberately. A QueueOverflowError thrown out of this
      // function would skip `recordFailure` entirely and land in the Stripe
      // webhook's catch — which is precisely the silently-lost ticket this
      // module was written to eliminate. Unreachable at today's volumes; the
      // ledger exists for the days that are not today.
      await acquire(priority);
      made++;
      await p.send(msg);
      if (attempt > 1) {
        console.log(`[email] Delivered via ${p.name} on attempt ${attempt}/${maxAttempts}`);
      }
      return { error: null, attempts: made };
    } catch (err) {
      lastError =
        err instanceof EmailSendError
          ? err
          : new EmailSendError(err instanceof Error ? err.message : String(err), {
              retryable: true,
              cause: err,
            });

      if (!lastError.retryable || attempt === maxAttempts) break;

      const wait = backoffMs(attempt);
      console.warn(
        `[email] ${p.name} attempt ${attempt}/${maxAttempts} failed (${lastError.code ?? "unknown"}), ` +
          `retrying in ${Math.round(wait)}ms: ${lastError.message}`,
      );
      await sleepFn(wait);
    }
  }

  return {
    error: lastError ?? new EmailSendError("Unknown send failure", { retryable: false }),
    attempts: made,
  };
}

export async function sendEmail(msg: OutboundEmail, opts: SendEmailOptions = {}): Promise<void> {
  return sendVia({ primary: selectProvider(), secondary: null, sleep }, msg, opts);
}

/** `sendEmail` with its providers supplied explicitly. Exported for tests. */
export async function sendVia(
  deps: SendDeps,
  msg: OutboundEmail,
  opts: SendEmailOptions = {},
): Promise<void> {
  if (!msg.to.length) throw new EmailSendError("sendEmail: no recipients", { retryable: false });

  const priority = opts.priority ?? "transactional";
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const active = deps.primary;

  const acquire = deps.acquire ?? ((pri: SendPriority) => sendRateLimiter().acquire(pri));

  // Tag at the chokepoint so no send can opt out of being correlatable when it
  // bounces asynchronously. Already-tagged messages keep their tags: the drain
  // worker re-sends what it queued, and recomputing here would lose the original
  // `context` — the message would come back classifiable but with no idea which
  // paid order it belonged to.
  const outbound: OutboundEmail = msg.tags
    ? msg
    : { ...msg, tags: buildMessageTags(priority, opts.context) };

  const primaryOutcome = await attemptWithRetries(
    active, outbound, priority, maxAttempts, deps.sleep, acquire,
  );
  if (!primaryOutcome.error) return;

  let failure = primaryOutcome.error;
  let attempts = primaryOutcome.attempts;
  let usedProvider = active.name;

  // Failover is for a DOWN PROVIDER, not a bad message: a permanent error
  // (rejected address, unverified domain, oversized attachment) would fail
  // identically on the secondary and just delay the ledger entry. Transactional
  // only: a broadcast failing over would exhaust a free tier's daily allowance
  // and start a cold domain's reputation with a burst of bulk mail.
  const secondary = priority === "transactional" && failure.retryable ? deps.secondary : null;
  if (secondary) {
    console.warn(
      `[email] ${active.name} exhausted ${maxAttempts} attempts — failing over to ${secondary.name}`,
    );
    const secondaryOutcome = await attemptWithRetries(
      secondary, outbound, priority, maxAttempts, deps.sleep, acquire,
    );
    // Failover calls count too — an operator reading "1 attempt" against a
    // message we handed to two providers cannot reconstruct what happened.
    attempts += secondaryOutcome.attempts;
    if (!secondaryOutcome.error) {
      console.warn(`[email] Delivered via failover provider ${secondary.name}`);
      return;
    }
    // Report the SECONDARY's error but name both: "Resend rate_limit_exceeded"
    // on its own sends an operator to the wrong dashboard during an SES outage.
    usedProvider = `${active.name}→${secondary.name}`;
    failure = new EmailSendError(
      `${failure.message} | failover ${secondary.name}: ${secondaryOutcome.error.message}`,
      {
        retryable: secondaryOutcome.error.retryable,
        ...(secondaryOutcome.error.code ? { code: secondaryOutcome.error.code } : {}),
        cause: secondaryOutcome.error,
      },
    );
  }

  // `noLedger` is the drain worker re-sending something already recorded. See
  // `resendAbandoned` — a second entry per retry would multiply one undelivered
  // ticket into a handful of unresolved records, each with its own plaintext
  // copy of the buyer's address.
  if (!opts.noLedger) {
    const entry = recordFailure({
      kind: priority === "marketing" ? "marketing" : "transactional",
      recipients: msg.to,
      recipientHashes: msg.to.map(hashEmail),
      subject: msg.subject,
      provider: usedProvider,
      error: failure.message,
      ...(failure.code ? { code: failure.code } : {}),
      attempts,
      retryable: failure.retryable,
      ...(opts.context ? { context: opts.context } : {}),
    });

    // Hand a transient failure to the drain worker. Two conditions, both
    // load-bearing.
    //
    // TRANSIENT only: a rejected address or an unverified domain would fail
    // identically on every retry and would occupy budget a recoverable message
    // needs.
    //
    // TRANSACTIONAL only: a broadcast already has a retry mechanism, and it is
    // the job's own resume. Queueing a marketing failure here would deliver it
    // outside the job — so its hash would never reach `sentHashes`, the job
    // would still offer "send to the N who missed it", and those N would be
    // mailed TWICE. It would also skip the suppression re-check that
    // `sendMarketingBatch` performs and DATA_INVENTORY relies on, mailing
    // someone who unsubscribed between the failure and the retry.
    if (failure.retryable && priority !== "marketing") {
      enqueueRetry(entry.id, outbound, priority);
    }
  }

  throw failure;
}

/**
 * Re-send a message the ledger already knows about, WITHOUT writing a second
 * entry for it.
 *
 * The drain worker's entry point. `sendVia` records a failure every time it
 * gives up, which is right for a first attempt and wrong for the fifth retry of
 * the same message: it would multiply one undelivered ticket into a handful of
 * unresolved transactional entries, each carrying its own plaintext copy of the
 * buyer's address and each exempt from the ledger's size cap.
 *
 * @returns the failure, or null on success.
 */
export async function resendAbandoned(
  msg: OutboundEmail,
  priority: SendPriority,
): Promise<EmailSendError | null> {
  try {
    await sendVia({ primary: selectProvider(), secondary: null, sleep }, msg, {
      priority,
      noLedger: true,
    });
    return null;
  } catch (err) {
    return err instanceof EmailSendError
      ? err
      : new EmailSendError(err instanceof Error ? err.message : String(err), { retryable: true });
  }
}

/**
 * Which ESP is live — for /api/health and startup logging.
 *
 * Defaults to `resend`, NOT `ses`, even though SES is the funded provider. The
 * cutover is an env change (`EMAIL_PROVIDER=ses`) that must be made
 * deliberately: if the default flipped, deploying this code to a VM whose env
 * lacks AWS credentials would take ticket email down completely, whereas the
 * old provider keeps working until someone chooses to switch. Same reasoning in
 * reverse makes the rollback one line.
 */
export function activeEmailProvider(): string {
  return (process.env.EMAIL_PROVIDER || "resend").toLowerCase();
}

/**
 * Startup check for the ACTIVE provider's required env.
 *
 * Called from index.ts so a missing credential is a boot-time log line rather
 * than a discovery made by the first buyer whose ticket never arrived.
 * Deliberately non-fatal: refusing to boot would take down ticketing, check-in
 * and the site runtime over an email misconfiguration.
 */
export function checkEmailProviderConfig(): { ok: boolean; provider: string; missing: string[] } {
  const name = activeEmailProvider();
  const required =
    name === "ses"
      ? ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
      : ["RESEND_API_KEY"];
  // SES_REGION is an accepted alias; treat either as satisfying AWS_REGION.
  const missing = required.filter((k) =>
    k === "AWS_REGION" ? !process.env.AWS_REGION && !process.env.SES_REGION : !process.env[k],
  );
  if (missing.length) {
    console.error(
      `[email] EMAIL_PROVIDER=${name} but missing: ${missing.join(", ")} — outbound email WILL fail`,
    );
  } else {
    console.log(`[email] Provider: ${name}`);
  }
  return { ok: missing.length === 0, provider: name, missing };
}
