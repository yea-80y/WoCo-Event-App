import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEventForOwner } from "../lib/event/service.js";
import { getResend } from "../lib/email/client.js";
import { sendMarketingBatch } from "../lib/email/marketing-send.js";
import { resolveMarketingFrom } from "../lib/marketing/sending-domain-store.js";

const broadcast = new Hono<AppEnv>();

/** In-memory rate limiter: parentAddress → timestamps */
const broadcastRateMap = new Map<string, number[]>();
const BROADCAST_RATE_LIMIT = 5;
const BROADCAST_RATE_WINDOW = 3_600_000; // 1 hour

/** Max recipients per broadcast */
const MAX_RECIPIENTS = 500;

broadcast.post("/:id/broadcast", requireAuth, async (c) => {
  const eventId = c.req.param("id");
  const parentAddress = c.get("parentAddress");
  const body = c.get("body") as Record<string, unknown>;

  try {
    // 1. Check Resend is configured
    try { getResend(); } catch {
      return c.json({ ok: false, error: "Email not configured (RESEND_API_KEY missing)" }, 500);
    }

    // 2. Load event and verify organiser ownership
    const event = await getEventForOwner(eventId, parentAddress);
    if (!event) {
      return c.json({ ok: false, error: "Event not found" }, 404);
    }

    if (event.creatorAddress.toLowerCase() !== parentAddress.toLowerCase()) {
      return c.json({ ok: false, error: "Only the event organiser can send broadcasts" }, 403);
    }

    // 3. Validate inputs
    const subject = body.subject as string;
    const htmlBody = body.htmlBody as string;
    const recipients = body.recipients as Array<{ email: string; name?: string }>;

    if (!subject || typeof subject !== "string" || subject.length > 200) {
      return c.json({ ok: false, error: "Subject required (max 200 chars)" }, 400);
    }

    if (!htmlBody || typeof htmlBody !== "string" || htmlBody.length > 50_000) {
      return c.json({ ok: false, error: "Body required (max 50KB)" }, 400);
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return c.json({ ok: false, error: "At least one recipient required" }, 400);
    }

    if (recipients.length > MAX_RECIPIENTS) {
      return c.json({ ok: false, error: `Maximum ${MAX_RECIPIENTS} recipients per broadcast` }, 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const r of recipients) {
      if (!r.email || !emailRegex.test(r.email)) {
        return c.json({ ok: false, error: `Invalid email: ${r.email}` }, 400);
      }
    }

    // 4. Rate limiting
    const now = Date.now();
    const timestamps = broadcastRateMap.get(parentAddress) ?? [];
    const recent = timestamps.filter((t) => now - t < BROADCAST_RATE_WINDOW);
    if (recent.length >= BROADCAST_RATE_LIMIT) {
      return c.json({ ok: false, error: "Rate limit exceeded (5 broadcasts per hour)" }, 429);
    }

    // 5. Send through the compliance path: suppression + List-Unsubscribe +
    // footer are unconditional for every non-transactional email. Event
    // broadcasts do NOT consume the marketing daily cap (attendee-relationship
    // mail, already bounded by 5/hr x 500).
    const result = await sendMarketingBatch({
      organiserAddress: parentAddress,
      fromDisplayName: event.title,
      fromAddress: resolveMarketingFrom(parentAddress),
      subject,
      html: htmlBody,
      recipients,
    });

    // Record the broadcast
    recent.push(now);
    broadcastRateMap.set(parentAddress, recent);

    console.log(
      `[broadcast] eventId=${eventId} sent=${result.sent} suppressed=${result.suppressed} failed=${result.failed} subject="${subject.slice(0, 50)}"`,
    );

    return c.json({
      ok: true,
      data: {
        sentCount: result.sent,
        failedCount: result.failed,
        suppressedCount: result.suppressed,
        totalRecipients: recipients.length,
        ...(result.errors.length > 0 ? { errors: result.errors.slice(0, 10) } : {}),
      },
    });
  } catch (err) {
    console.error("[broadcast] error:", err);
    const message = err instanceof Error ? err.message : "Broadcast failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { broadcast };
