import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEvent } from "../lib/event/service.js";
import { getResend, getFromAddress } from "../lib/email/client.js";

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
    let resend: ReturnType<typeof getResend>;
    try { resend = getResend(); } catch {
      return c.json({ ok: false, error: "Email not configured (RESEND_API_KEY missing)" }, 500);
    }
    const fromAddress = getFromAddress();

    // 2. Load event and verify organiser ownership
    const event = await getEvent(eventId);
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

    // 5. Send via Resend
    let sentCount = 0;
    let failedCount = 0;
    const errors: string[] = [];

    // Send individually so each recipient only sees their own address
    for (const recipient of recipients) {
      try {
        await resend.emails.send({
          from: `"${event.title}" <${fromAddress}>`,
          to: [recipient.email],
          subject,
          html: htmlBody,
        });
        sentCount++;
      } catch (err) {
        failedCount++;
        const msg = err instanceof Error ? err.message : "Unknown error";
        errors.push(`${recipient.email}: ${msg}`);
        console.error(`[broadcast] Failed to send to ${recipient.email}:`, msg);
      }
    }

    // Record the broadcast
    recent.push(now);
    broadcastRateMap.set(parentAddress, recent);

    console.log(
      `[broadcast] eventId=${eventId} sent=${sentCount} failed=${failedCount} subject="${subject.slice(0, 50)}"`,
    );

    return c.json({
      ok: true,
      data: {
        sentCount,
        failedCount,
        totalRecipients: recipients.length,
        ...(errors.length > 0 ? { errors: errors.slice(0, 10) } : {}),
      },
    });
  } catch (err) {
    console.error("[broadcast] error:", err);
    const message = err instanceof Error ? err.message : "Broadcast failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { broadcast };
