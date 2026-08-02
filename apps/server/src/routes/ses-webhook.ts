/**
 * SES → SNS event webhook. Two jobs, and they are not the same job.
 *
 * 1. SUPPRESSION. Bounces and complaints feed the GLOBAL suppression list — the
 *    control that keeps our complaint rate under the Gmail/Yahoo 0.1% line, and
 *    the thing AWS explicitly required when it granted production access.
 *
 * 2. EVIDENCE (#99). SES ACCEPTS a message and can then fail to deliver it
 *    minutes later — a typo'd address at checkout, or one already on AWS's own
 *    suppression list. `sesProvider.send()` resolved, so nothing retried,
 *    nothing failed over, and nothing reached the failure ledger: a buyer paid
 *    and the first anyone knew was the door. That is the half of silent ticket
 *    loss #98 did not cover, and this is the only place it can be caught.
 *
 * Correlation back to the send is by configuration-set message tags, which
 * return on the event as `mail.tags` (see `lib/email/message-tags.ts` for why
 * not `messageId`). AWS is explicit that identity-level feedback notifications
 * carry NO tags, so an untagged bounce is treated as a wiring alarm rather than
 * as ordinary input.
 *
 * Signature verification is UNCONDITIONAL (`lib/email/sns-verify.ts`): a forged
 * complaint would globally suppress an arbitrary address. Recipient addresses
 * appear here transiently in plaintext and are hashed immediately; nothing
 * plaintext is stored or logged.
 *
 * SUPPRESSION POLICY, from the SES bounce-type reference:
 *   - `Permanent` (any subtype) → suppress. AWS: "you should remove the
 *     corresponding email addresses from your mailing list; you will not be
 *     able to send to them in the future."
 *   - `Transient` → do NOT suppress. Mailbox-full and message-too-large are
 *     recoverable, and permanently blocking a real attendee over a full inbox
 *     means they never receive a ticket again.
 *   - `Undetermined` → do NOT suppress. Guessing in the direction of a
 *     permanent block is the expensive mistake.
 *   - Any `Complaint` → suppress. A complaint is a person saying "stop",
 *     which outranks any classification nuance.
 *
 * LEDGER POLICY, which is deliberately NARROWER than the suppression policy:
 *   - `Permanent` bounce → ledger. Accepted, never delivered.
 *   - `Reject` → ledger. Also accepted-then-discarded (content verdict), and our
 *     ticket mail carries PNG attachments, so a false positive is a live path.
 *     No suppression: the fault is in our message, not in the recipient.
 *   - `Transient` / `Undetermined` / `DeliveryDelay` → neither. The message may
 *     still arrive, and an alarm that resolves itself teaches operators to
 *     ignore the alarm.
 *   - `Complaint` → suppress, do NOT ledger. The message WAS delivered; the
 *     person pressed "spam". Recording it as an undelivered ticket would be
 *     false, and it would turn `/api/health` red for something no operator
 *     action can fix. Nor does it cost them a future ticket: the suppression
 *     list is consumed only by `marketing-send.ts`, never by the transactional
 *     path. If a complaint does lead to loss, it lands on AWS's account-level
 *     suppression list and comes back as `Permanent/OnAccountSuppressionList` —
 *     which IS ledgered, at the moment the loss becomes real.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { suppressGlobal } from "../lib/marketing/suppression-store.js";
import { checkAndConsumeSnsEvent } from "../lib/email/consumed-sns-events.js";
import { recordFailure } from "../lib/email/failure-ledger.js";
import { readMessageTags } from "../lib/email/message-tags.js";
import {
  verifySnsSignature,
  isSnsAwsHttpsUrl,
  SnsVerificationError,
  type SnsEnvelope,
} from "../lib/email/sns-verify.js";

const sesWebhook = new Hono<AppEnv>();

/** Bounds replay of a captured-and-replayed message. SNS retries for ~hours. */
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;

interface SesEventPayload {
  eventType?: string;
  notificationType?: string;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{
      emailAddress?: string;
      action?: string;
      status?: string;
      diagnosticCode?: string;
    }>;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
    complaintFeedbackType?: string;
  };
  reject?: { reason?: string };
  mail?: {
    messageId?: string;
    timestamp?: string;
    /** Every addressee. The only recipient source a Reject event has. */
    destination?: string[];
    commonHeaders?: { subject?: string };
    /** Values are ARRAYS, and the map also holds provider-owned `ses:*` keys. */
    tags?: Record<string, string[]>;
  };
}

/** Said once per process: it is a wiring fault, not a per-message event. */
let warnedUntagged = false;

/**
 * Write the durable "this was accepted and never delivered" record.
 *
 * DEDUPED SEPARATELY from the SNS envelope. The envelope id covers SNS's own
 * retries; this covers the same SES failure reaching us twice over different
 * subscriptions — `SES_SNS_TOPIC_ARN` is explicitly a comma-separated list, and
 * a config-set destination running alongside identity-level notifications
 * delivers two SNS messages with different envelope ids for one failure. Two
 * unresolved transactional entries for one buyer is doubled evidence of a single
 * incident. The recipient hashes are part of the key because SES legitimately
 * emits SEPARATE events for different recipients of one message, and those must
 * not collapse into one.
 *
 * A DUPLICATE OF A SYNCHRONOUS ENTRY IS ACCEPTED, on purpose. Two paths produce
 * one: AWS's documented case where a send request returns an error but the
 * message is accepted anyway, and a drain-worker retry that was accepted,
 * resolved the entry, and then bounced. The second is not a duplicate at all —
 * the resolution was premature and this entry is the truth. Deduping on
 * recipient would silently discard evidence in both cases, and an operator
 * reading two rows with the same hash and subject can see what happened.
 */
function ledgerAsyncFailure(opts: {
  payload: SesEventPayload;
  eventType: string;
  addresses: string[];
  code: string;
  error: string;
}): boolean {
  const { payload, eventType, addresses } = opts;
  if (!addresses.length) return false;

  const hashes = addresses.map(hashEmail);
  const { kind, context } = readMessageTags(payload.mail?.tags);
  const messageId = payload.mail?.messageId;
  if (messageId) {
    // The TAGGED and UNTAGGED copies of one failure key separately, on purpose.
    // In the dual-wiring topology above, the identity-level copy carries the
    // same `mail.messageId` and NO tags. A single key would let whichever
    // arrived first win, so an unlucky ordering would record a paid ticket's
    // bounce as hash-only marketing — no health alarm, no address, and
    // nondeterministically so. Keying them apart means the worst case is a
    // duplicate row rather than a silently downgraded one, which is the same
    // trade the paragraph above already takes.
    const key = `ledger:${messageId}:${eventType}:${kind ? "t" : "u"}:${[...hashes].sort().join(",")}`;
    if (!checkAndConsumeSnsEvent(key)) return false;
  }
  if (!kind && !warnedUntagged) {
    warnedUntagged = true;
    console.error(
      `[ses-webhook] ${eventType} carried no message tags — recording it hash-only. ` +
        `SES publishes tags ONLY through a configuration-set event destination; ` +
        `identity-level feedback notifications carry none. Check the SNS topic wiring.`,
    );
  }

  recordFailure({
    // Unclassifiable falls to `marketing`, which is the hash-only side of the
    // PLAINTEXT POLICY. Storing a stranger's address on a guess is the one
    // mistake here that cannot be undone; a hash-only record of a paid ticket is
    // still actionable, because Stripe holds the buyer's address against the
    // same order. The alarm for the guess itself is the untagged counter on
    // /api/health, not a per-message health flip.
    kind: kind ?? "marketing",
    recipients: addresses,
    recipientHashes: hashes,
    subject: payload.mail?.commonHeaders?.subject || "(subject not in event)",
    provider: "ses",
    code: opts.code,
    error: opts.error,
    // ONE accepted send. It may UNDERCOUNT — the accepted call could have been
    // the third after two throttles — but zero would assert no call was made,
    // which is false. `asyncEvent` in the context says how to read it.
    attempts: 1,
    // Re-sending to an address that hard-bounced bounces again. This also keeps
    // the entry out of the drain worker, which only ever takes what `sendVia`
    // enqueued.
    retryable: false,
    context: {
      ...context,
      asyncEvent: eventType,
      ...(kind ? {} : { untagged: "true" }),
      ...(messageId ? { sesMessageId: messageId } : {}),
      ...(payload.mail?.timestamp ? { sentAt: payload.mail.timestamp } : {}),
    },
  });
  return true;
}

function allowedTopicArns(): string[] {
  return (process.env.SES_SNS_TOPIC_ARN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Confirm an HTTPS subscription by fetching `SubscribeURL`.
 *
 * The URL is re-validated against the SNS host pattern even though the message
 * signature already verified: the signature proves Amazon sent the message, not
 * that following the URL is safe, and this is a server-side fetch of an
 * attacker-influenced URL — textbook SSRF if left unchecked.
 */
async function confirmSubscription(url: string): Promise<boolean> {
  if (!isSnsAwsHttpsUrl(url)) {
    console.error(`[ses-webhook] Refusing to confirm subscription — SubscribeURL is not an SNS URL`);
    return false;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`[ses-webhook] Subscription confirmation failed: HTTP ${res.status}`);
      return false;
    }
    console.log("[ses-webhook] SNS subscription confirmed");
    return true;
  } catch (err) {
    console.error("[ses-webhook] Subscription confirmation error:", err);
    return false;
  }
}

sesWebhook.post("/webhook", async (c) => {
  // SNS posts with Content-Type text/plain, so parse the raw body ourselves
  // rather than trusting a JSON body parser to be lenient about it.
  const raw = await c.req.text();
  let envelope: SnsEnvelope;
  try {
    envelope = JSON.parse(raw) as SnsEnvelope;
  } catch {
    return c.json({ ok: false, error: "Malformed SNS envelope" }, 400);
  }

  const topics = allowedTopicArns();
  if (!topics.length) {
    // Fail CLOSED. Without a pinned topic ARN any AWS customer could sign a
    // message with a genuine SNS certificate and have us suppress addresses on
    // their say-so. Acknowledging (2xx) stops SNS retrying a message we will
    // never accept.
    console.error("[ses-webhook] SES_SNS_TOPIC_ARN unset — event rejected");
    return c.json({ ok: true, data: { ignored: true, reason: "unconfigured" } });
  }

  try {
    await verifySnsSignature(envelope, {
      allowedTopicArns: topics,
      requireSignatureV2: process.env.SNS_REQUIRE_SIGNATURE_V2 === "true",
      maxAgeMs: MAX_MESSAGE_AGE_MS,
    });
  } catch (err) {
    const msg = err instanceof SnsVerificationError ? err.message : "verification error";
    console.warn(`[ses-webhook] Rejected unverified SNS message: ${msg}`);
    return c.json({ ok: false, error: "Invalid signature" }, 403);
  }

  if (envelope.Type === "SubscriptionConfirmation") {
    const ok = envelope.SubscribeURL ? await confirmSubscription(envelope.SubscribeURL) : false;
    return c.json({ ok: true, data: { confirmed: ok } });
  }

  if (envelope.Type === "UnsubscribeConfirmation") {
    // Not an error, but somebody detached our bounce feed — that is a silent
    // compliance regression, so it must be loud.
    console.error(
      `[ses-webhook] SNS subscription was REMOVED for ${envelope.TopicArn} — ` +
        `bounce/complaint suppression is no longer being fed`,
    );
    return c.json({ ok: true });
  }

  // CONSUME BEFORE PROCESSING — deliberate, do not "fix" the ordering.
  //
  // A crash between this line and the suppression below loses that bounce
  // permanently, because SNS's retry will now be deduped away. The alternative
  // — consume after processing — loses nothing but lets a redelivery (SNS
  // retries on any non-2xx, and at-least-once is its documented contract)
  // re-run the handler. Suppression is idempotent, so that redelivery is
  // harmless *today*; the moment this handler also writes a failure-ledger
  // entry (#99) it stops being harmless, because duplicate entries are
  // duplicated evidence of an undelivered ticket. Consuming first keeps the
  // ordering that #99 needs. The lost-bounce window is bounded by the process
  // crashing in the microseconds between two synchronous calls.
  if (!checkAndConsumeSnsEvent(envelope.MessageId)) {
    return c.json({ ok: true, data: { deduped: true } });
  }

  let payload: SesEventPayload;
  try {
    payload = JSON.parse(envelope.Message) as SesEventPayload;
  } catch {
    console.warn("[ses-webhook] SNS Message body was not JSON — ignoring");
    return c.json({ ok: true, data: { ignored: true } });
  }

  // `eventType` when published via a configuration set event destination;
  // `notificationType` on the older identity-level notification path. Both
  // shapes reach the same handler so the setup choice cannot silently disable
  // suppression.
  const type = payload.eventType ?? payload.notificationType;
  let suppressed = 0;
  let ledgered = false;

  if (type === "Bounce") {
    const bounceType = payload.bounce?.bounceType;
    if (bounceType === "Permanent") {
      const subType = payload.bounce?.bounceSubType ?? "Unknown";
      const bounced = (payload.bounce?.bouncedRecipients ?? []).filter((r) =>
        r.emailAddress?.includes("@"),
      );

      // LEDGER FIRST, suppress second — the reverse of the obvious order, and
      // deliberate. The consume above means a throw from here loses this event
      // permanently, and the two writes are not equally recoverable: a lost
      // suppression self-heals, because the address bounces again on its next
      // send, while a lost ledger entry is a paid ticket nobody ever hears
      // about. `recordFailure` is documented never to throw, so ledger-first
      // cannot cost us the suppression either.
      ledgered = ledgerAsyncFailure({
        payload,
        eventType: "Bounce",
        addresses: bounced.map((r) => r.emailAddress!),
        code: `Bounce/Permanent/${subType}`,
        // The diagnostic usually quotes the recipient back at us; the ledger
        // redacts email-shaped text before storing or logging it.
        error:
          bounced[0]?.diagnosticCode ||
          (bounced[0]?.status ? `SMTP status ${bounced[0].status}` : `Permanent bounce (${subType})`),
      });

      for (const r of bounced) {
        try {
          suppressGlobal(hashEmail(r.emailAddress!), "bounce");
          suppressed++;
        } catch (err) {
          console.error("[ses-webhook] Suppression write failed:", err);
        }
      }
      console.log(
        `[ses-webhook] Permanent bounce (${subType}): suppressed ${suppressed} address(es)` +
          `${ledgered ? ", ledgered as undelivered" : ""}`,
      );
    } else {
      console.log(`[ses-webhook] ${bounceType ?? "Unknown"} bounce — not suppressing`);
    }
  } else if (type === "Complaint") {
    for (const r of payload.complaint?.complainedRecipients ?? []) {
      if (r.emailAddress?.includes("@")) {
        suppressGlobal(hashEmail(r.emailAddress), "complaint");
        suppressed++;
      }
    }
    console.log(
      `[ses-webhook] Complaint (${payload.complaint?.complaintFeedbackType ?? "unspecified"}): ` +
        `suppressed ${suppressed} address(es)`,
    );
  } else if (type === "Reject") {
    // Accepted, then discarded by SES on a content verdict. There is no `bounce`
    // object and no per-recipient detail: the WHOLE message was dropped, so
    // every addressee on it is undelivered.
    const reason = payload.reject?.reason ?? "unspecified";
    ledgered = ledgerAsyncFailure({
      payload,
      eventType: "Reject",
      addresses: (payload.mail?.destination ?? []).filter((a) => a.includes("@")),
      code: "Reject",
      error: `SES rejected the message after accepting it: ${reason}`,
    });
    // No suppression: the fault is our content, and blocking the recipient over
    // it would deny a real attendee every future ticket.
    console.error(`[ses-webhook] SES REJECTED an accepted message (${reason})`);
  }

  // Always 2xx for processed and ignored types alike, so SNS does not retry a
  // Delivery or Send event forever.
  return c.json({ ok: true, data: { suppressed, ledgered } });
});

/** Tests only — the untagged warning is once-per-process by design. */
export function _resetUntaggedWarningForTest(): void {
  warnedUntagged = false;
}

export { sesWebhook };
