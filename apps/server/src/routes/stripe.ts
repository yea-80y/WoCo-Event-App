/**
 * Stripe Connect routes — organiser onboarding + attendee checkout.
 *
 * Onboarding uses Stripe's hosted flow (Account Links).
 * Payments use destination charges via Stripe Checkout Sessions.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware/auth.js";
import { getStripe } from "../lib/stripe/client.js";
import {
  getStripeAccount,
  setStripeAccount,
  updateOnboardingStatus,
  getOrganiserByStripeAccount,
} from "../lib/stripe/accounts.js";
import { getEvent } from "../lib/event/service.js";
import { claimTicket, hashEmail, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";
import { PLATFORM_FEE_BP } from "@woco/shared";
import type { SealedBox } from "@woco/shared";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { readFeedPage, writeFeedPage, decodeJsonFeed, encodeJsonFeed } from "../lib/swarm/feeds.js";
import { topicClaimers } from "../lib/swarm/topics.js";
import type { ClaimersFeed } from "@woco/shared";

const stripe = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Resolve the frontend URL for return/refresh redirects
// ---------------------------------------------------------------------------
/**
 * Resolve the frontend URL for Stripe return/refresh redirects.
 *
 * Order of preference:
 *  1. Referer  — the URL the user was on when they clicked. Proxies preserve it
 *                even when they rewrite Origin (Vite's `changeOrigin: true`,
 *                Cloudflare tunnels, reverse proxies, etc).
 *  2. Origin   — sent by the browser; reliable when no proxy mangles it.
 *  3. FRONTEND_URL — explicit env override.
 *  4. First ALLOWED_HOST — last-resort production default.
 *
 * Validation: localhost is always trusted (any port). Other hosts must appear
 * in ALLOWED_HOSTS exactly to prevent open-redirect attacks via spoofed
 * Referer/Origin.
 */
function getFrontendUrl(c?: { req: { header: (name: string) => string | undefined } }): string {
  const allowed = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  /** Treat a candidate origin as trusted, returning the canonical origin string. */
  const trust = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw);
      // Localhost in dev — any port
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        return `${u.protocol}//${u.host}`;
      }
      // Otherwise must match ALLOWED_HOSTS exactly (host = hostname:port)
      if (allowed.some((h) => u.host === h)) {
        return `${u.protocol}//${u.host}`;
      }
      return null;
    } catch {
      return null;
    }
  };

  // 1. Referer (full URL — extract the origin from it)
  const referer = c?.req.header("referer");
  const fromReferer = trust(referer);
  if (fromReferer) return fromReferer;

  // 2. Origin
  const origin = c?.req.header("origin");
  const fromOrigin = trust(origin);
  if (fromOrigin) return fromOrigin;

  // 3. Explicit env var
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;

  // 4. First ALLOWED_HOST (production fallback)
  if (allowed[0]) {
    const host = allowed[0];
    const proto = host.startsWith("localhost") ? "http" : "https";
    console.warn(
      `[stripe] No trusted Origin/Referer header — falling back to ALLOWED_HOSTS[0]=${host}. ` +
      `referer=${referer ?? "<none>"} origin=${origin ?? "<none>"}`,
    );
    return `${proto}://${host}`;
  }
  return "http://localhost:5173";
}

// ---------------------------------------------------------------------------
// 1. Organiser onboarding — create Connected Account + Account Link
// ---------------------------------------------------------------------------

/** POST /api/stripe/connect — create a Connected Account for the authenticated organiser */
stripe.post("/connect", requireAuth, async (c) => {
  const organiserAddress = c.get("parentAddress").toLowerCase();

  // Check if organiser already has a Stripe account
  const existing = getStripeAccount(organiserAddress);
  if (existing) {
    return c.json({
      ok: true,
      stripeAccountId: existing.stripeAccountId,
      onboardingComplete: existing.onboardingComplete,
    });
  }

  try {
    const s = getStripe();
    const account = await s.accounts.create({
      type: "express",
      metadata: { organiserAddress },
    });

    setStripeAccount(organiserAddress, account.id, false);

    return c.json({
      ok: true,
      stripeAccountId: account.id,
      onboardingComplete: false,
    });
  } catch (err) {
    console.error("[stripe] Failed to create account:", err);
    const msg = err instanceof Error ? err.message : "Failed to create Stripe account";
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** POST /api/stripe/onboarding-link — generate a hosted onboarding URL */
stripe.post("/onboarding-link", requireAuth, async (c) => {
  const organiserAddress = c.get("parentAddress").toLowerCase();
  const record = getStripeAccount(organiserAddress);
  if (!record) {
    return c.json({ ok: false, error: "No Stripe account found. Call /connect first." }, 400);
  }

  if (record.onboardingComplete) {
    return c.json({ ok: true, alreadyComplete: true });
  }

  const frontendUrl = getFrontendUrl(c);

  try {
    const s = getStripe();
    const accountLink = await s.accountLinks.create({
      account: record.stripeAccountId,
      refresh_url: `${frontendUrl}/#/stripe/refresh`,
      return_url: `${frontendUrl}/#/stripe/return`,
      type: "account_onboarding",
    });

    return c.json({ ok: true, url: accountLink.url });
  } catch (err) {
    console.error("[stripe] Failed to create account link:", err);
    const msg = err instanceof Error ? err.message : "Failed to create onboarding link";
    return c.json({ ok: false, error: msg }, 500);
  }
});

/** GET /api/stripe/account-status — check if onboarding is complete */
stripe.get("/account-status", requireAuth, async (c) => {
  const organiserAddress = c.get("parentAddress").toLowerCase();
  const record = getStripeAccount(organiserAddress);
  if (!record) {
    return c.json({ ok: true, connected: false });
  }

  // Refresh status from Stripe
  try {
    const s = getStripe();
    const account = await s.accounts.retrieve(record.stripeAccountId);
    const complete = !!(account.charges_enabled && account.payouts_enabled);

    if (complete !== record.onboardingComplete) {
      setStripeAccount(organiserAddress, record.stripeAccountId, complete);
    }

    // Extract verification requirements for the UI
    const requirements = account.requirements;
    const currentlyDue = requirements?.currently_due ?? [];
    const eventuallyDue = requirements?.eventually_due ?? [];
    const pendingVerification = requirements?.pending_verification ?? [];
    const disabledReason = requirements?.disabled_reason ?? null;

    // Categorise requirements for human-readable display
    const requirementCategories: { label: string; status: "done" | "pending" | "needed" }[] = [];

    const hasBusinessInfo = !currentlyDue.some(r =>
      r.startsWith("business_profile") || r.startsWith("business_type") || r === "company.name"
    );
    requirementCategories.push({
      label: "Business information",
      status: hasBusinessInfo ? "done" : "needed",
    });

    const hasIdentity = !currentlyDue.some(r =>
      r.startsWith("individual") || r.startsWith("person") || r === "representative"
    );
    const identityPending = pendingVerification.some(r =>
      r.startsWith("individual") || r.startsWith("person")
    );
    requirementCategories.push({
      label: "Identity verification",
      status: identityPending ? "pending" : hasIdentity ? "done" : "needed",
    });

    const hasBankAccount = !currentlyDue.some(r =>
      r.startsWith("external_account") || r === "bank_account"
    );
    requirementCategories.push({
      label: "Bank account",
      status: hasBankAccount ? "done" : "needed",
    });

    const hasTos = !currentlyDue.includes("tos_acceptance.date");
    requirementCategories.push({
      label: "Terms of service",
      status: hasTos ? "done" : "needed",
    });

    return c.json({
      ok: true,
      connected: true,
      stripeAccountId: record.stripeAccountId,
      onboardingComplete: complete,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      requirements: {
        currentlyDue,
        eventuallyDue,
        pendingVerification,
        disabledReason,
        categories: requirementCategories,
      },
    });
  } catch (err) {
    console.error("[stripe] Failed to retrieve account:", err);
    return c.json({
      ok: true,
      connected: true,
      stripeAccountId: record.stripeAccountId,
      onboardingComplete: record.onboardingComplete,
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Attendee checkout — create a Stripe Checkout Session
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe/create-checkout
 *
 * Body: { eventId, seriesId, claimerEmail?, claimerAddress? }
 *
 * Creates a Checkout Session with a destination charge to the organiser's
 * connected account. The ticket is claimed via webhook on payment success.
 */
stripe.post("/create-checkout", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { eventId, seriesId, claimerEmail, claimerAddress } = body as {
    eventId: string;
    seriesId: string;
    claimerEmail?: string;
    claimerAddress?: string;
  };

  if (!eventId || !seriesId) {
    return c.json({ ok: false, error: "eventId and seriesId are required" }, 400);
  }
  if (!claimerEmail && !claimerAddress) {
    return c.json({ ok: false, error: "claimerEmail or claimerAddress is required" }, 400);
  }

  // Load event + series
  const event = await getEvent(eventId);
  if (!event) return c.json({ ok: false, error: "Event not found" }, 404);

  const series = event.series.find((s) => s.seriesId === seriesId);
  if (!series) return c.json({ ok: false, error: "Series not found" }, 404);

  if (!series.payment?.stripeEnabled) {
    return c.json({ ok: false, error: "Series does not have Stripe payments enabled" }, 400);
  }

  const priceFloat = parseFloat(series.payment.price);
  if (isNaN(priceFloat) || priceFloat <= 0) {
    return c.json({ ok: false, error: "Invalid price" }, 400);
  }

  // Pre-flight availability + duplicate check.
  // Without this, a buyer could be charged successfully but the post-payment
  // claim fails because tickets sold out (or they already own one) — leaving
  // them out-of-pocket with no ticket. Note: this is best-effort — between
  // this check and the webhook firing, supply could still drop to zero. The
  // window is small (~5-30s) but a production system should also auto-refund
  // when handleSuccessfulPayment fails to claim. (TODO in webhook handler.)
  try {
    const userEmailHash = claimerEmail ? hashEmail(claimerEmail) : undefined;
    const status = await getClaimStatus(seriesId, claimerAddress?.toLowerCase(), userEmailHash);
    if (status.available <= 0) {
      return c.json({ ok: false, error: "Sold out" }, 409);
    }
    if (status.userEdition != null) {
      return c.json({ ok: false, error: "You already have a ticket for this series" }, 409);
    }
  } catch (err) {
    // Series not found / Swarm read fail — fall through. The series existence
    // check above already passed, so a transient read failure shouldn't block
    // the buyer; the webhook will re-check.
    console.warn("[stripe/create-checkout] Availability pre-check failed (continuing):", err);
  }

  const stripeCurrency = series.payment.currency.toLowerCase(); // "usd", "gbp", "eur"
  const passFeesToBuyer = !!series.payment.feePassedToCustomer;

  // Stripe processing fee estimates (used when passing fees to buyer)
  const STRIPE_PERCENT = 0.029;
  const STRIPE_FIXED: Record<string, number> = { gbp: 0.20, usd: 0.30, eur: 0.25 };

  // Base price in smallest currency unit (pence/cents)
  const baseAmount = Math.round(priceFloat * 100);
  const platformFee = Math.round(baseAmount * PLATFORM_FEE_BP / 10_000);

  let chargeAmount: number;
  let applicationFee: number;

  if (passFeesToBuyer) {
    // Buyer pays: base + platform fee + Stripe processing
    // Stripe fee is on the total charge, so we solve: charge = base + platformFee + stripe(charge)
    // charge = (base + platformFee + fixedFee) / (1 - stripePercent)
    const fixedFee = Math.round((STRIPE_FIXED[stripeCurrency] ?? 0.20) * 100);
    chargeAmount = Math.round((baseAmount + platformFee + fixedFee) / (1 - STRIPE_PERCENT));
    // WoCo gets the platform fee; organiser gets the base price
    applicationFee = platformFee;
  } else {
    // Organiser absorbs: buyer pays the ticket price, fees come from organiser's cut
    chargeAmount = baseAmount;
    applicationFee = platformFee;
  }

  // Find the organiser's connected account
  const organiserRecord = getStripeAccount(event.creatorAddress.toLowerCase());
  if (!organiserRecord?.onboardingComplete) {
    return c.json({ ok: false, error: "Event organiser has not completed Stripe onboarding" }, 400);
  }

  const frontendUrl = getFrontendUrl(c);

  try {
    const s = getStripe();
    const session = await s.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `${series.name} — ${event.title}`,
              description: series.description || undefined,
            },
            unit_amount: chargeAmount,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        transfer_data: {
          destination: organiserRecord.stripeAccountId,
        },
      },
      metadata: {
        eventId,
        seriesId,
        claimerEmail: claimerEmail || "",
        claimerAddress: claimerAddress || "",
      },
      success_url: `${frontendUrl}/#/event/${eventId}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/#/event/${eventId}?stripe=cancelled`,
      ...(claimerEmail ? { customer_email: claimerEmail } : {}),
    });

    return c.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[stripe] Failed to create checkout session:", err);
    const msg = err instanceof Error ? err.message : "Failed to create checkout";
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// 3. Webhook — handle payment completion + onboarding updates
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe/webhook
 *
 * Stripe sends events here. Verifies the signature if STRIPE_WEBHOOK_SECRET
 * is set; otherwise accepts all events (fine for test mode).
 */
stripe.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const sig = c.req.header("stripe-signature");

  let event: import("stripe").Stripe.Event;

  try {
    const s = getStripe();
    // Two endpoints exist: one on "Your account" (delivers
    // checkout.session.completed — platform-account events fired by our
    // destination-charge Checkout Sessions) and one on "Connected accounts"
    // (delivers account.updated for organiser onboarding). Each endpoint has
    // its own signing secret. Try both before rejecting.
    const secrets = [
      process.env.STRIPE_WEBHOOK_SECRET_PLATFORM,
      process.env.STRIPE_WEBHOOK_SECRET,
    ].filter((s): s is string => !!s);

    if (secrets.length > 0 && sig) {
      let verified: import("stripe").Stripe.Event | null = null;
      let lastErr: unknown = null;
      for (const secret of secrets) {
        try {
          verified = s.webhooks.constructEvent(rawBody, sig, secret);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!verified) throw lastErr ?? new Error("No matching signing secret");
      event = verified;
    } else if (process.env.NODE_ENV === "production") {
      // SECURITY: Without signature verification, anyone who can reach this
      // endpoint can forge a checkout.session.completed event with arbitrary
      // metadata and claim free tickets. Always reject unsigned webhooks in
      // production — set STRIPE_WEBHOOK_SECRET in apps/server/.env.
      console.error("[stripe-webhook] REJECTED: STRIPE_WEBHOOK_SECRET unset or signature missing in production");
      return c.text("Webhook signature required", 400);
    } else {
      // Dev/test only — accept unsigned events
      console.warn("[stripe-webhook] Accepting unsigned webhook (dev mode — set STRIPE_WEBHOOK_SECRET to enforce)");
      event = JSON.parse(rawBody) as import("stripe").Stripe.Event;
    }
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return c.text("Webhook signature verification failed", 400);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        await handleSuccessfulPayment(session);
      }
      break;
    }

    case "account.updated": {
      const account = event.data.object;
      const complete = !!(account.charges_enabled && account.payouts_enabled);
      updateOnboardingStatus(account.id, complete);
      console.log(`[stripe-webhook] Account ${account.id} updated: charges=${account.charges_enabled}, payouts=${account.payouts_enabled}`);
      break;
    }

    default:
      // Ignore other event types
      break;
  }

  return c.json({ received: true });
});

/**
 * Handle a successful Checkout Session — claim the ticket for the attendee.
 */
async function handleSuccessfulPayment(
  session: import("stripe").Stripe.Checkout.Session,
): Promise<void> {
  const { eventId, seriesId, claimerEmail, claimerAddress } = session.metadata ?? {};

  if (!eventId || !seriesId) {
    console.error("[stripe-webhook] Missing eventId/seriesId in session metadata");
    return;
  }

  let identifier: ClaimIdentifier;
  if (claimerAddress) {
    identifier = { type: "wallet", address: claimerAddress.toLowerCase() as `0x${string}` };
  } else if (claimerEmail) {
    identifier = {
      type: "email",
      email: claimerEmail,
      emailHash: hashEmail(claimerEmail),
    };
  } else {
    console.error("[stripe-webhook] No claimer identifier in session metadata");
    return;
  }

  try {
    const result = await claimTicket({ seriesId, identifier, via: "stripe" });
    console.log(`[stripe-webhook] Ticket claimed: series=${seriesId}, edition=${result.edition}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe-webhook] Failed to claim ticket:", msg);

    // Auto-refund for unrecoverable race conditions: the buyer paid, but the
    // ticket can't be issued because someone else got the last one or this
    // buyer somehow already has one. Without this they're charged and have
    // nothing to show for it.
    const isUnrecoverable =
      msg.includes("Already claimed") ||
      msg.includes("Already requested") ||
      msg.includes("No tickets available") ||
      msg.includes("Series not found") ||
      msg.includes("Series has no metadata");

    if (isUnrecoverable && session.payment_intent) {
      try {
        const s = getStripe();
        const piId = typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent.id;
        const refund = await s.refunds.create({
          payment_intent: piId,
          reason: "requested_by_customer",
          metadata: {
            reason: "ticket-claim-failed",
            failureMessage: msg.slice(0, 200),
            seriesId,
            eventId,
          },
        });
        console.log(`[stripe-webhook] Auto-refunded ${piId} (refund=${refund.id}) — ${msg}`);
      } catch (refundErr) {
        console.error("[stripe-webhook] Auto-refund FAILED — manual intervention required:", refundErr);
      }
    }
    // TODO: for transient errors (Swarm down etc), queue for retry
  }
}

// ---------------------------------------------------------------------------
// 4. Save order data after successful Stripe payment
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe/save-order
 *
 * Body: { seriesId, encryptedOrder, claimerEmail?, claimerAddress? }
 *
 * Called by the frontend after redirect back from a successful Stripe checkout.
 * Uploads the encrypted order data to Swarm and attaches it to the claimer's
 * entry in the claimers feed.
 */
stripe.post("/save-order", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { seriesId, encryptedOrder, claimerEmail, claimerAddress } = body as {
    seriesId: string;
    encryptedOrder: SealedBox;
    claimerEmail?: string;
    claimerAddress?: string;
  };

  if (!seriesId || !encryptedOrder) {
    return c.json({ ok: false, error: "seriesId and encryptedOrder are required" }, 400);
  }
  if (!claimerEmail && !claimerAddress) {
    return c.json({ ok: false, error: "claimerEmail or claimerAddress is required" }, 400);
  }

  // Determine the claimer key (must match what claim-service wrote)
  const claimerKey = claimerAddress
    ? claimerAddress.toLowerCase()
    : `email:${hashEmail(claimerEmail!)}`;

  try {
    // Upload encrypted order to Swarm
    const orderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
    console.log(`[stripe/save-order] Encrypted order uploaded: ${orderRef}`);

    // Read claimers feed and find the matching entry
    const page = await readFeedPage(topicClaimers(seriesId));
    if (!page) {
      return c.json({ ok: false, error: "Claimers feed not found — ticket may not have been claimed yet" }, 404);
    }

    const feed = decodeJsonFeed<ClaimersFeed>(page);
    if (!feed) {
      return c.json({ ok: false, error: "Failed to decode claimers feed" }, 500);
    }

    const entry = feed.claimers.find(
      (e) => e.claimerAddress.toLowerCase() === claimerKey.toLowerCase(),
    );
    if (!entry) {
      return c.json({ ok: false, error: "Claimer entry not found — ticket may not have been claimed yet" }, 404);
    }

    // Attach order data
    entry.orderRef = orderRef;
    feed.updatedAt = new Date().toISOString();
    await writeFeedPage(topicClaimers(seriesId), encodeJsonFeed(feed));

    console.log(`[stripe/save-order] Order data attached to claimer ${claimerKey}, series ${seriesId}`);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[stripe/save-order] Failed:", err);
    const msg = err instanceof Error ? err.message : "Failed to save order data";
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { stripe as stripeRoutes };
