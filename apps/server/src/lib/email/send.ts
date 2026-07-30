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
 * Resend is the secondary provider: an operator rollback lever
 * (`EMAIL_PROVIDER=resend`) and the automatic failover target for TRANSACTIONAL
 * mail only (`EMAIL_FALLBACK_PROVIDER=resend`, see `failoverProvider`).
 *
 * Kept on the FREE tier deliberately — we do not pay for two ESPs
 * (docs/PRICING_AND_EMAIL.md §6). That free tier is 100 messages/day, which is
 * why the failover is scoped the way it is: ticket email runs under 1,000 a
 * MONTH, so Resend can absorb an SES outage; a single 1,000-recipient broadcast
 * would exhaust the day's allowance and start a cold domain's reputation with a
 * burst of bulk mail. Hence marketing never fails over.
 *
 * This adapter is scheduled for deletion — see docs/SES_MIGRATION_HANDOVER.md.
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

/**
 * Secondary provider for TRANSACTIONAL mail only, used when the primary has
 * exhausted its retries on a retryable error — i.e. the provider is down or
 * throttling us, not the message being bad. Off unless configured.
 *
 * Returns null when unset, misconfigured, or pointed at the active provider
 * (failing over to yourself is a no-op that doubles the latency of every
 * outage). A bad value must not throw here: this runs on the error path, and an
 * exception would replace a recoverable failure with an unrecoverable one.
 */
function failoverProvider(): EmailProvider | null {
  const name = (process.env.EMAIL_FALLBACK_PROVIDER || "").toLowerCase();
  if (!name || name === activeEmailProvider()) return null;
  const p = PROVIDERS[name];
  if (!p) {
    console.error(`[email] EMAIL_FALLBACK_PROVIDER="${name}" is not a known provider — ignoring`);
    return null;
  }
  return p;
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
  /** Transactional-only failover target, or null for none. */
  secondary: EmailProvider | null;
  sleep: (ms: number) => Promise<void>;
}

/** One provider, with retries. Resolves on success, returns the final error otherwise. */
async function attemptWithRetries(
  p: EmailProvider,
  msg: OutboundEmail,
  priority: SendPriority,
  maxAttempts: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<EmailSendError | null> {
  let lastError: EmailSendError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Acquire per ATTEMPT, not once per message: a retry is another message on
    // the wire and must be counted against the same account-wide budget.
    await sendRateLimiter().acquire(priority);

    try {
      await p.send(msg);
      if (attempt > 1) {
        console.log(`[email] Delivered via ${p.name} on attempt ${attempt}/${maxAttempts}`);
      }
      return null;
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

  return lastError ?? new EmailSendError("Unknown send failure", { retryable: false });
}

export async function sendEmail(msg: OutboundEmail, opts: SendEmailOptions = {}): Promise<void> {
  return sendVia(
    { primary: selectProvider(), secondary: failoverProvider(), sleep },
    msg,
    opts,
  );
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

  let failure = await attemptWithRetries(active, msg, priority, maxAttempts, deps.sleep);
  if (!failure) return;

  let usedProvider = active.name;

  // Failover is for a DOWN PROVIDER, not a bad message: a permanent error
  // (rejected address, unverified domain, oversized attachment) would fail
  // identically on the secondary and just delay the ledger entry. Transactional
  // only — see the resendProvider comment for why marketing must not fail over.
  const secondary = priority === "transactional" && failure.retryable ? deps.secondary : null;
  if (secondary) {
    console.warn(
      `[email] ${active.name} exhausted ${maxAttempts} attempts — failing over to ${secondary.name}`,
    );
    const secondaryFailure = await attemptWithRetries(secondary, msg, priority, maxAttempts, deps.sleep);
    if (!secondaryFailure) {
      console.warn(`[email] Delivered via failover provider ${secondary.name}`);
      return;
    }
    // Report the SECONDARY's error but name both: "Resend rate_limit_exceeded"
    // on its own sends an operator to the wrong dashboard during an SES outage.
    usedProvider = `${active.name}→${secondary.name}`;
    failure = new EmailSendError(
      `${failure.message} | failover ${secondary.name}: ${secondaryFailure.message}`,
      {
        retryable: secondaryFailure.retryable,
        ...(secondaryFailure.code ? { code: secondaryFailure.code } : {}),
        cause: secondaryFailure,
      },
    );
  }

  recordFailure({
    kind: priority === "marketing" ? "marketing" : "transactional",
    recipient: msg.to[0]!,
    recipientHash: hashEmail(msg.to[0]!),
    subject: msg.subject,
    provider: usedProvider,
    error: failure.message,
    ...(failure.code ? { code: failure.code } : {}),
    attempts: failure.retryable ? maxAttempts : 1,
    retryable: failure.retryable,
    ...(opts.context ? { context: opts.context } : {}),
  });

  throw failure;
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
