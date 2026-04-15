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
import { claimTicket, hashEmail, type ClaimIdentifier } from "../lib/event/claim-service.js";

const stripe = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Resolve the frontend URL for return/refresh redirects
// ---------------------------------------------------------------------------
/**
 * Resolve the frontend URL for Stripe return/refresh redirects.
 *
 * Uses the request Origin header so the redirect goes back to wherever the
 * user actually is (localhost during dev, woco.eth.limo in production).
 * Falls back to FRONTEND_URL env var, then first ALLOWED_HOST, then localhost.
 */
function getFrontendUrl(c?: { req: { header: (name: string) => string | undefined } }): string {
  // 1. Use the Origin header from the request — most reliable
  const origin = c?.req.header("origin");
  if (origin) {
    const allowed = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
    try {
      const url = new URL(origin);
      // Verify the origin is in ALLOWED_HOSTS before trusting it
      if (allowed.some((h) => url.host === h)) {
        return origin;
      }
    } catch {
      // invalid origin, fall through
    }
  }

  // 2. Explicit env var
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;

  // 3. First ALLOWED_HOST
  const hosts = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts?.[0]) {
    const host = hosts[0];
    return host.includes("localhost") ? `http://${host}` : `https://${host}`;
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

  // Convert fiat price to smallest currency unit (pence/cents)
  const unitAmount = Math.round(priceFloat * 100);
  const stripeCurrency = series.payment.currency.toLowerCase(); // "usd", "gbp", "eur"

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
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: Math.round(unitAmount * 0.05), // 5% platform fee
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
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (webhookSecret && sig) {
      event = s.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } else {
      // No webhook secret — parse directly (test mode)
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
    const result = await claimTicket({ seriesId, identifier });
    console.log(`[stripe-webhook] Ticket claimed: series=${seriesId}, edition=${result.edition}`);
  } catch (err) {
    console.error("[stripe-webhook] Failed to claim ticket:", err);
    // TODO: in production, queue for retry or alert the organiser
  }
}

export { stripe as stripeRoutes };
