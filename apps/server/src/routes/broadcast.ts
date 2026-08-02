import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getEventForOwner } from "../lib/event/service.js";
import { getAttendeeEmailHashes } from "../lib/event/attendee-emails.js";
import { hashEmail } from "../lib/event/claim-service.js";
import { getResend } from "../lib/email/client.js";
import { sendMarketingBatch } from "../lib/email/marketing-send.js";
import { maxInlineRecipients } from "../lib/email/rate-limiter.js";
import { resolveMarketingFrom } from "../lib/marketing/sending-domain-store.js";
import { withOrgLock } from "../lib/marketing/list-store.js";
import { RateWindow } from "../lib/marketing/rate-window.js";
import { isVerifiedOrganiser } from "../lib/stripe/verification.js";

const broadcast = new Hono<AppEnv>();

const BROADCAST_RATE_LIMIT = 5;
const BROADCAST_RATE_WINDOW = 3_600_000; // 1 hour

/** Keyed by LOWERCASED parentAddress: a caller sending the same address in two
 *  casings would otherwise get two independent windows and twice the allowance. */
const broadcastRate = new RateWindow(BROADCAST_RATE_LIMIT, BROADCAST_RATE_WINDOW);

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

    // Same inline-duration guard as the marketing broadcast — see the comment
    // there. Attendee broadcasts cap at 500, so this only bites if the send rate
    // is turned down (warm-up) or MAX_RECIPIENTS is raised.
    const inlineMax = maxInlineRecipients();
    if (recipients.length > inlineMax) {
      return c.json({
        ok: false,
        error:
          `This broadcast is too large to send in one go right now — ${recipients.length} ` +
          `recipients, current maximum ${inlineMax}. Split it, or wait for scheduled ` +
          `sending which removes this limit.`,
      }, 400);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const r of recipients) {
      if (!r.email || !emailRegex.test(r.email)) {
        return c.json({ ok: false, error: `Invalid email: ${r.email}` }, 400);
      }
    }

    // 4. Rate limiting, first pass. Advisory only — it is re-checked under the
    // org lock at step 6, which is where the decision actually binds. It runs
    // here as well because the attendee verification below costs one Swarm feed
    // read per series, and a cheap guard has to come first or it cannot bound
    // the expensive work.
    const org = parentAddress.toLowerCase();
    if (broadcastRate.isLimited(org)) {
      return c.json({ ok: false, error: "Rate limit exceeded (5 broadcasts per hour)" }, 429);
    }

    // 5. Every recipient must actually hold a ticket for THIS event.
    //
    // The organiser assembles the list by decrypting sealed order blobs in their
    // own browser, so the server cannot re-derive it — it can only check what it
    // is handed. Without this the endpoint is a send-to-anyone path: it is
    // deliberately not Stripe-gated (attendee-relationship mail must not depend
    // on Stripe) and it does not consume the marketing daily cap, both of which
    // are only defensible while the recipients really are attendees. Suppression
    // still applies inside sendMarketingBatch either way, so unsubscribers were
    // never at risk — but the consent boundary was.
    const { hashes: attendeeHashes, unverifiableSeries } = await getAttendeeEmailHashes(event);

    // Prove what CAN be proven first. Only the recipients left unaccounted for
    // by the v1 claimers feeds fall through to the weaker gate — previously ONE
    // v2 series anywhere on the event disabled the membership check for every
    // recipient, so a verified organiser could mail arbitrary addresses through
    // an event that happened to have an on-chain series attached.
    const unproven = recipients.filter((r) => !attendeeHashes.has(hashEmail(r.email)));

    if (unproven.length > 0) {
      if (unverifiableSeries === 0) {
        // Count only — echoing the addresses back would turn a rejection into an
        // oracle for "does this person hold a ticket".
        return c.json(
          {
            ok: false,
            error:
              `${unproven.length} of ${recipients.length} recipients have not claimed a ticket ` +
              `for this event. Event broadcasts can only go to your attendees — use your marketing ` +
              `audience for everyone else.`,
            code: "RECIPIENTS_NOT_ATTENDEES",
          },
          403,
        );
      }

      // v2 on-chain series put the claimer identity inside the sealed blob and
      // nothing hashed on chain, so membership is unprovable server-side. For
      // the unproven remainder only, fall back to the same abuse gate the
      // marketing path uses rather than either rejecting real attendees or
      // waving them through. In practice this is a no-op: an on-chain series is
      // a paid Stripe series, so its organiser is already charges_enabled.
      if (!(await isVerifiedOrganiser(parentAddress))) {
        return c.json(
          {
            ok: false,
            error:
              "Broadcasts for on-chain ticket series require a verified Stripe account",
            code: "STRIPE_VERIFICATION_REQUIRED",
          },
          403,
        );
      }
    }

    // 6. Send through the compliance path: suppression + List-Unsubscribe +
    // footer are unconditional for every non-transactional email. Event
    // broadcasts do NOT consume the marketing daily cap (attendee-relationship
    // mail, already bounded by 5/hr x 500).
    //
    // The rate check is re-run and the slot consumed under the org lock, both
    // BEFORE the send. Checking at step 4 and recording after a slow send left a
    // window in which N concurrent requests all passed the same check — the
    // marketing route already runs its cap this way.
    const outcome = await withOrgLock(org, async () => {
      if (broadcastRate.isLimited(org)) return { rejected: true } as const;
      broadcastRate.record(org);
      return {
        result: await sendMarketingBatch({
          organiserAddress: parentAddress,
          fromDisplayName: event.title,
          fromAddress: resolveMarketingFrom(parentAddress),
          subject,
          html: htmlBody,
          recipients,
        }),
      } as const;
    });

    if ("rejected" in outcome) {
      return c.json({ ok: false, error: "Rate limit exceeded (5 broadcasts per hour)" }, 429);
    }
    const result = outcome.result;

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
        ...(result.failures.length > 0
          ? { errors: result.failures.slice(0, 10).map((f) => `${f.email}: ${f.message}`) }
          : {}),
      },
    });
  } catch (err) {
    console.error("[broadcast] error:", err);
    const message = err instanceof Error ? err.message : "Broadcast failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export { broadcast };
