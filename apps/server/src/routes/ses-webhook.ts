/**
 * SES → SNS event webhook. Feeds bounces and spam complaints into the GLOBAL
 * suppression list — the control that keeps our complaint rate under the
 * Gmail/Yahoo 0.1% line, and the thing AWS explicitly required when it granted
 * production access.
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
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { suppressGlobal } from "../lib/marketing/suppression-store.js";
import { checkAndConsumeSnsEvent } from "../lib/email/consumed-sns-events.js";
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
    bouncedRecipients?: Array<{ emailAddress?: string }>;
  };
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
    complaintFeedbackType?: string;
  };
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

  if (type === "Bounce") {
    const bounceType = payload.bounce?.bounceType;
    if (bounceType === "Permanent") {
      for (const r of payload.bounce?.bouncedRecipients ?? []) {
        if (r.emailAddress?.includes("@")) {
          suppressGlobal(hashEmail(r.emailAddress), "bounce");
          suppressed++;
        }
      }
      console.log(
        `[ses-webhook] Permanent bounce (${payload.bounce?.bounceSubType ?? "?"}): ` +
          `suppressed ${suppressed} address(es)`,
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
  }

  // Always 2xx for processed and ignored types alike, so SNS does not retry a
  // Delivery or Send event forever.
  return c.json({ ok: true, data: { suppressed } });
});

export { sesWebhook };
