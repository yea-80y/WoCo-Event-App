/**
 * Onboarding campaign API — referral attribution + relay, cohort badges.
 *
 * Decentralisation posture matches likes: the chain is authoritative for
 * every confirmed referral and badge; this layer holds only the pre-chain
 * pending attribution plus fast-read projections.
 *
 * The relay endpoint is the platform-gas write path and is double-gated:
 * a server-held pending record must exist AND the merchant's Stripe
 * onboarding must be complete (KYC — the unspammable signal), so relay gas
 * can only ever be spent on genuinely onboarded merchants.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import type { Hex0x, DelegatedSignature, ReferralStatus } from "@woco/shared";
import {
  getPendingReferral, getConfirmedReferral, setPendingReferral,
  confirmReferral, getReferralsByReferrer,
} from "../lib/campaign/referral-store.js";
import { getVerifiedReferral, relayDelegatedReferral } from "../lib/campaign/eas-campaign.js";
import { getBadge, issueJoinedBadge } from "../lib/campaign/badges.js";
import { getStripeAccount } from "../lib/stripe/accounts.js";

export const campaignRoutes = new Hono<AppEnv>();

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// Same sliding-window shape as likes /record. The relay endpoint spends
// platform gas, so its funnel is tighter than the read-side default.
const LIMIT = 10;
const WINDOW_MS = 60_000;
const _hits = new Map<string, number[]>();
function allow(bucket: string): boolean {
  const now = Date.now();
  const recent = (_hits.get(bucket) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    _hits.set(bucket, recent);
    return false;
  }
  recent.push(now);
  _hits.set(bucket, recent);
  return true;
}

function stripeComplete(address: string): boolean {
  return getStripeAccount(address.toLowerCase())?.onboardingComplete === true;
}

function statusFor(parent: string): ReferralStatus {
  const pending = getPendingReferral(parent);
  const confirmed = getConfirmedReferral(parent);
  const stripe = stripeComplete(parent);
  return {
    ...(pending ? { pending: { referrer: pending.referrer, createdAt: pending.createdAt } } : {}),
    ...(confirmed ? { confirmed: { referrer: confirmed.referrer, uid: confirmed.uid, time: confirmed.time } } : {}),
    stripeComplete: stripe,
    readyToAttest: !!pending && !confirmed && stripe,
  };
}

/**
 * POST /api/campaign/referrals/pending — capture link attribution at signup.
 * Body: { referrer }. Referee = the authenticated parent; first wins, ever.
 */
campaignRoutes.post("/referrals/pending", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as { referrer?: string };
  if (!allow(`p:${parent}`) || !allow(`ip:${clientIp(c)}`)) {
    return c.json({ ok: false, error: "Too many requests — slow down." }, 429);
  }
  const referrer = body.referrer?.toLowerCase();
  if (!referrer || !ADDR.test(referrer)) {
    return c.json({ ok: false, error: "Invalid referrer address" }, 400);
  }
  if (referrer === parent) {
    return c.json({ ok: false, error: "You can't refer yourself" }, 400);
  }
  setPendingReferral(parent, referrer); // no-op if attribution already exists
  return c.json({ ok: true, data: statusFor(parent) });
});

/** GET /api/campaign/referrals/status — drives the merchant confirm banner. */
campaignRoutes.get("/referrals/status", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  return c.json({ ok: true, data: statusFor(parent) });
});

/**
 * POST /api/campaign/referrals/record — Kernel rail. The merchant attested
 * directly on-chain (gasless userop); verify the UID and confirm. Same
 * Stripe gate as relay so the two rails can't diverge in policy.
 */
campaignRoutes.post("/referrals/record", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase();
  const body = c.get("body") as { uid?: string };
  if (!allow(`p:${parent}`) || !allow(`ip:${clientIp(c)}`)) {
    return c.json({ ok: false, error: "Too many requests — slow down." }, 429);
  }
  if (!body.uid || !HEX32.test(body.uid)) {
    return c.json({ ok: false, error: "Invalid uid" }, 400);
  }

  const pending = getPendingReferral(parent);
  if (!pending) return c.json({ ok: false, error: "No pending referral for this account" }, 404);
  if (getConfirmedReferral(parent)) return c.json({ ok: false, error: "Referral already confirmed" }, 409);
  if (!stripeComplete(parent)) {
    return c.json({ ok: false, error: "Complete Stripe onboarding first" }, 403);
  }

  const res = await getVerifiedReferral(body.uid);
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  const ref = res.referral;
  // Linchpin: on-chain attester must be the authenticated merchant, and the
  // attested referrer must match the server-held attribution.
  if (ref.attester !== parent) {
    return c.json({ ok: false, error: `Attester ${ref.attester} is not the authenticated account` }, 403);
  }
  if (ref.referrer !== pending.referrer) {
    return c.json({ ok: false, error: "Attested referrer does not match your pending referral" }, 400);
  }

  confirmReferral({ referrer: ref.referrer, referee: parent as Hex0x, uid: ref.uid, time: ref.time });
  // A confirmed referral is a "first meaningful action" for both parties.
  void issueJoinedBadge(parent);
  void issueJoinedBadge(ref.referrer);
  return c.json({ ok: true, data: statusFor(parent) });
});

/**
 * POST /api/campaign/referrals/relay — EOA rail (zero user gas). The merchant
 * signed the EAS delegated attest; the sponsor wallet submits it.
 */
campaignRoutes.post("/referrals/relay", requireAuth, async (c) => {
  const parent = c.get("parentAddress").toLowerCase() as Hex0x;
  const body = c.get("body") as { deadline?: string; signature?: DelegatedSignature };
  if (!allow(`p:${parent}`) || !allow(`ip:${clientIp(c)}`)) {
    return c.json({ ok: false, error: "Too many requests — slow down." }, 429);
  }

  const pending = getPendingReferral(parent);
  if (!pending) return c.json({ ok: false, error: "No pending referral for this account" }, 404);
  if (getConfirmedReferral(parent)) return c.json({ ok: false, error: "Referral already confirmed" }, 409);
  if (!stripeComplete(parent)) {
    return c.json({ ok: false, error: "Complete Stripe onboarding first" }, 403);
  }

  const sig = body.signature;
  if (
    !sig || typeof sig.v !== "number" || !HEX32.test(sig.r ?? "") || !HEX32.test(sig.s ?? "") ||
    typeof body.deadline !== "string" || !/^\d+$/.test(body.deadline)
  ) {
    return c.json({ ok: false, error: "Invalid relay payload" }, 400);
  }

  const relayed = await relayDelegatedReferral({
    attester: parent,
    referrer: pending.referrer,
    deadline: BigInt(body.deadline),
    signature: sig,
  });
  if (!relayed.ok) return c.json({ ok: false, error: relayed.error }, 400);

  confirmReferral({
    referrer: pending.referrer, referee: parent,
    uid: relayed.uid, time: Math.floor(Date.now() / 1000),
  });
  void issueJoinedBadge(parent);
  void issueJoinedBadge(pending.referrer);
  return c.json({ ok: true, data: statusFor(parent) });
});

/** GET /api/campaign/referrals/by/:address — confirmed referrals a referrer earned. */
campaignRoutes.get("/referrals/by/:address", (c) => {
  const address = c.req.param("address");
  if (!ADDR.test(address)) return c.json({ ok: false, error: "Invalid address" }, 400);
  return c.json({ ok: true, data: getReferralsByReferrer(address) });
});

/** GET /api/campaign/badges/:address — the address's Joined badge, if issued. */
campaignRoutes.get("/badges/:address", (c) => {
  const address = c.req.param("address");
  if (!ADDR.test(address)) return c.json({ ok: false, error: "Invalid address" }, 400);
  return c.json({ ok: true, data: getBadge(address) ?? null });
});
