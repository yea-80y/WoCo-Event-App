/**
 * Resend webhook — feeds bounces and spam complaints into the GLOBAL
 * suppression list (address-level signals: a hard bounce or complaint is not
 * organiser-specific). This is what keeps complaint rates under the
 * Gmail/Yahoo 0.1% line without manual list hygiene.
 *
 * Signature verification uses the SDK's bundled svix verify (throws on bad
 * sig) and is UNCONDITIONAL — no NODE_ENV escape hatch; without a configured
 * secret events are acknowledged and dropped. Recipient addresses appear here
 * transiently in plaintext and are hashed immediately; nothing plaintext is
 * stored.
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
  data?: { to?: string[] };
}

resendWebhook.post("/webhook", async (c) => {
  // A verified signature is the ONLY path to processing: a forged bounce/
  // complaint would globally suppress arbitrary addresses (targeted denial of
  // email), so this never depends on NODE_ENV. Without a configured secret we
  // acknowledge-and-drop rather than parse unauthenticated input; dev testing
  // sets a real secret (svix CLI or Resend test endpoint).
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[resend-webhook] RESEND_WEBHOOK_SECRET unset — event ignored");
    return c.json({ ok: true, data: { ignored: true } });
  }

  const rawBody = await c.req.text();
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ ok: false, error: "Webhook signature required" }, 400);
  }

  let event: WebhookEventShape;
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

  // Exactly-once across svix redeliveries
  if (!checkAndConsumeWebhookEvent(svixId)) {
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
