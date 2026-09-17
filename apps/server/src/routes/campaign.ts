/**
 * Onboarding campaign API — referral confirmation and cohort badges (#476).
 *
 * WHY THERE IS NO TRUTH HERE. Every fact this API serves is a signed chunk on
 * Swarm: the referee's own statement on their feed, the confirmation and the
 * badge on the issuer's. The server keeps no pending table, no confirmed table
 * and no badge index, because the uniqueness rule this campaign needs — one
 * referrer per referee, first confirmed wins — is already enforced by a
 * write-once SOC at version 0 of a referee-keyed topic. Server state could only
 * ever be a second opinion about that, and a second opinion a restart can lose
 * is worse than none: it would be the one an operator reads.
 *
 * So this file is three things. It authenticates the referee, it applies the
 * ONE gate Swarm cannot carry — whether the merchant's Stripe onboarding is
 * complete, which exists only in Stripe — and it translates the issuer's
 * discriminated result into a status code. `lib/campaign/issuer.ts` does the
 * rest.
 *
 * The confirm route spends postage, so it is rate limited per verified parent
 * AND per client IP. The reads are not: they cost a feed read each, the same
 * order as the other public reads on this server.
 */

import { Hono } from "hono";
import { CAMPAIGN_ISSUER_ADDRESS } from "@woco/shared";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { campaignIssuerConfigured } from "../config/swarm.js";
import {
  campaignIssuerReady,
  confirmReferral,
  noteRefusal,
  readBadge,
  readConfirmation,
} from "../lib/campaign/issuer.js";
import { stripeVerificationComplete } from "../lib/stripe/accounts.js";
import { clientIp } from "../lib/http/client-ip.js";
import { SlidingWindowLimiter } from "../lib/http/rate-limit.js";

export const campaignRoutes = new Hono<AppEnv>();

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * A confirm is up to four feed reads and two chunk writes, and a merchant does
 * it once. The ceiling is sized for a human retrying, not for a funnel.
 */
const CONFIRM_LIMIT = new SlidingWindowLimiter([{ limit: 10, windowMs: 60_000 }]);

/**
 * POST /api/campaign/referrals/confirm — the merchant asks the issuer to
 * confirm the referral they already wrote to their own feed.
 *
 * Body: `{ referrer, refereeFeed }`. The referee is the authenticated parent,
 * never a body field; `refereeFeed` is the content-feed signer whose feed holds
 * their statement, accepted from them on the rule sites.ts already states for
 * `siteFeedSigner` — a user's claim about their own feed can only ever resolve
 * that signer at THIS record's key, so it cannot be aimed at anyone else.
 */
campaignRoutes.post("/referrals/confirm", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  // `?? {}` because a body of literal `null` parses to null upstream, and a
  // property read on it would be a 500 where a 400 is the honest answer.
  const body = (c.get("body") ?? {}) as { referrer?: string; refereeFeed?: string };

  const referrer = body.referrer?.toLowerCase();
  const refereeFeed = body.refereeFeed?.toLowerCase();
  if (!referrer || !ADDR.test(referrer)) {
    return c.json({ ok: false, error: "Invalid referrer address" }, 400);
  }
  if (!refereeFeed || !ADDR.test(refereeFeed)) {
    return c.json({ ok: false, error: "Invalid referee feed address" }, 400);
  }
  if (referrer === parent) {
    noteRefusal();
    return c.json({ ok: false, error: "You can't refer yourself" }, 400);
  }
  if (!CONFIRM_LIMIT.allowAll([`p:${parent}`, `ip:${clientIp(c)}`])) {
    return c.json({ ok: false, error: "Too many requests — slow down." }, 429);
  }
  // The unspammable signal: KYC completed at Stripe. It is also the only
  // precondition that cannot be read off Swarm, which is why this route exists
  // at all rather than the referee writing their own confirmation.
  if (!stripeVerificationComplete(parent)) {
    noteRefusal();
    return c.json({ ok: false, error: "Complete Stripe onboarding first" }, 403);
  }
  if (!campaignIssuerConfigured() || !campaignIssuerReady()) {
    return c.json({ ok: false, error: "Referral confirmation is unavailable" }, 503);
  }

  const result = await confirmReferral({ referee: parent, refereeFeed, referrer });
  switch (result.status) {
    case "confirmed":
      return c.json({ ok: true, data: { confirmed: result.record, issuer: CAMPAIGN_ISSUER_ADDRESS } });
    case "already":
      // Idempotent when it names the same referrer — a retry after a dropped
      // response must not read as a conflict. A DIFFERENT referrer lost the
      // race for a slot that can never be rewritten, and saying so is the only
      // honest answer.
      if (result.record.referrer === referrer) {
        return c.json({ ok: true, data: { confirmed: result.record, issuer: CAMPAIGN_ISSUER_ADDRESS } });
      }
      noteRefusal();
      return c.json({ ok: false, error: "Referral already confirmed to a different referrer" }, 409);
    case "no-statement":
      return c.json({ ok: false, error: "No referral statement found on your feed" }, 404);
    case "retracted":
      noteRefusal();
      return c.json({ ok: false, error: "Your referral statement is retracted" }, 409);
    default:
      return c.json({ ok: false, error: "Could not confirm right now — try again" }, 503);
  }
});

/**
 * GET /api/campaign/referrals/status — drives the merchant confirm banner.
 *
 * `readOk: false` is the difference between "you have not confirmed" and "we
 * could not tell": the banner must not invite a merchant to re-confirm off a
 * read that failed, and a null `confirmed` alone cannot carry that.
 */
campaignRoutes.get("/referrals/status", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  const read = await readConfirmation(parent);
  return c.json({
    ok: true,
    data: {
      stripeComplete: stripeVerificationComplete(parent),
      issuer: CAMPAIGN_ISSUER_ADDRESS,
      confirmed: read.status === "found" ? read.record : null,
      readOk: read.status !== "unavailable",
    },
  });
});

/** GET /api/campaign/badges/:address — the address's Joined badge, if issued. */
campaignRoutes.get("/badges/:address", async (c) => {
  const address = c.req.param("address");
  if (!ADDR.test(address)) return c.json({ ok: false, error: "Invalid address" }, 400);
  const read = await readBadge(address);
  // A badge that could not be read is not an absent badge. `null` here is a
  // durable claim the UI shows as "no badge", so an unreadable feed has to be
  // a failure the caller can retry.
  if (read.status === "unavailable") {
    return c.json({ ok: false, error: "Could not read the badge right now" }, 503);
  }
  return c.json({ ok: true, data: read.status === "found" ? read.record : null });
});
