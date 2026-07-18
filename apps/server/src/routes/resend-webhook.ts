/**
 * Resend webhook — feeds bounces and spam complaints into the GLOBAL
 * suppression list (address-level signals: a hard bounce or complaint is not
 * organiser-specific). This is what keeps complaint rates under the
 * Gmail/Yahoo 0.1% line without manual list hygiene.
 *
 * Signature verification uses the SDK's bundled svix verify (throws on bad
 * sig). Production rejects unsigned deliveries — same posture as the Stripe
 * webhook. Recipient addresses appear here transiently in plaintext and are
 * hashed immediately; nothing plaintext is stored.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { getResend } from "../lib/email/client.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { suppressGlobal } from "../lib/marketing/suppression-store.js";
import { checkAndConsumeWebhookEvent } from "../lib/marketing/consumed-webhook-events.js";

const resendWebhook = new Hono<AppEnv>();

interface WebhookEventShape {
  type?: string;
  data?: { email_id?: string; to?: string[] };
}

resendWebhook.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  let event: WebhookEventShape;

  if (secret && svixId && svixTimestamp && svixSignature) {
    try {
      event = getResend().webhooks.verify({
        payload: rawBody,
        headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
        webhookSecret: secret,
      }) as WebhookEventShape;
    } catch {
      console.warn("[resend-webhook] signature verification failed");
      return c.json({ ok: false, error: "Invalid signature" }, 400);
    }
  } else if (process.env.NODE_ENV === "production") {
    // Never process unsigned events in production — a forged bounce webhook
    // could suppress arbitrary addresses (targeted denial of email).
    console.warn("[resend-webhook] rejected unsigned webhook in production");
    return c.json({ ok: false, error: "Webhook signature required" }, 400);
  } else {
    try {
      event = JSON.parse(rawBody) as WebhookEventShape;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON" }, 400);
    }
  }

  // Exactly-once across svix redeliveries
  const dedupeKey = svixId || event.data?.email_id;
  if (dedupeKey && !checkAndConsumeWebhookEvent(dedupeKey)) {
    return c.json({ ok: true, data: { deduped: true } });
  }

  if (event.type === "email.bounced" || event.type === "email.complained") {
    const source = event.type === "email.bounced" ? "bounce" : "complaint";
    const recipients = Array.isArray(event.data?.to) ? event.data.to : [];
    for (const addr of recipients) {
      if (typeof addr === "string" && addr.includes("@")) {
        // TODO: consider skipping transient bounce subTypes once real payload
        // values are observed (SDK types EmailBounce.type as bare string).
        suppressGlobal(hashEmail(addr), source);
      }
    }
    console.log(`[resend-webhook] ${event.type}: suppressed ${recipients.length} address(es)`);
  }

  // Always 2xx for processed/ignored types so Resend doesn't retry forever
  return c.json({ ok: true });
});

export { resendWebhook };
