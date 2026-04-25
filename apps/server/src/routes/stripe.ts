/**
 * Stripe Connect routes — organiser onboarding + attendee checkout.
 *
 * Onboarding uses Stripe's hosted flow (Account Links).
 * Payments use destination charges via Stripe Checkout Sessions.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, tryVerifyAuth } from "../middleware/auth.js";
import { getStripe } from "../lib/stripe/client.js";
import {
  getStripeAccount,
  setStripeAccount,
  updateOnboardingStatus,
  getOrganiserByStripeAccount,
} from "../lib/stripe/accounts.js";
import { getEvent } from "../lib/event/service.js";
import { claimTicket, hashEmail, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";
import { queueSeriesClaim } from "./claims.js";
import { PLATFORM_FEE_BP, sealJson } from "@woco/shared";
import type { SealedBox } from "@woco/shared";
import { uploadToBytes } from "../lib/swarm/bytes.js";
import { readFeedPage, writeFeedPage, decodeJsonFeed, encodeJsonFeed } from "../lib/swarm/feeds.js";
import { topicClaimers } from "../lib/swarm/topics.js";
import type { ClaimersFeed } from "@woco/shared";
import { checkAndConsumeSession } from "../lib/stripe/session-registry.js";
import { sendTicketEmail } from "./tickets.js";
import { getReservation, consume as consumeReservation } from "../lib/event/reservation-store.js";

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
/**
 * Validate a client-supplied return URL and return it (minus query/hash/trailing
 * slash) if its host is in ALLOWED_HOSTS. Preserves the path — required for
 * Swarm-served frontends at /bzz/{hash}/ where the origin alone 404s.
 */
function validateReturnUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const allowed = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  try {
    const u = new URL(raw);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (!isLocal && !allowed.some((h) => u.host === h)) return null;
    const path = u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

function getFrontendUrl(c?: { req: { header: (name: string) => string | undefined } }): string {
  const allowed = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  /**
   * Trust a candidate URL and return the base the frontend is served from.
   * `keepPath` preserves the pathname (minus trailing slash) — required for
   * Swarm-served frontends at `/bzz/{hash}/` where the origin alone is 404.
   */
  const trust = (raw: string | undefined, keepPath: boolean): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const host = u.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1";
      if (!isLocal && !allowed.some((h) => u.host === h)) return null;
      if (!keepPath) return `${u.protocol}//${u.host}`;
      // Drop trailing slash so callers can append `/#/...` without doubling up.
      const path = u.pathname.replace(/\/$/, "");
      return `${u.protocol}//${u.host}${path}`;
    } catch {
      return null;
    }
  };

  // 1. Referer — preserve path (Swarm sites live at /bzz/{hash}/)
  const referer = c?.req.header("referer");
  const fromReferer = trust(referer, true);
  if (fromReferer) return fromReferer;

  // 2. Origin — path-less, only trustworthy as a fallback
  const origin = c?.req.header("origin");
  const fromOrigin = trust(origin, false);
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
// 1a. Pre-upload an encrypted order to Swarm and return its ref.
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe/prepare-order
 *
 * Body: { encryptedOrder: SealedBox }
 * Returns: { ok: true, orderRef: Hex64 }
 *
 * Called by the client immediately before /create-checkout. The returned
 * orderRef is passed to /create-checkout, stored in the Stripe session
 * metadata, and attached by the webhook to every ticket in the batch.
 *
 * This eliminates the post-return save-order race: by the time the webhook
 * fires, the full form data is already on Swarm, so every claim in a multi-
 * ticket batch gets the same orderRef with zero coordination.
 */
stripe.post("/prepare-order", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const encryptedOrder = body.encryptedOrder as SealedBox | undefined;
  if (!encryptedOrder || typeof encryptedOrder !== "object") {
    return c.json({ ok: false, error: "encryptedOrder is required" }, 400);
  }

  try {
    const orderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
    return c.json({ ok: true, orderRef });
  } catch (err) {
    console.error("[stripe/prepare-order] Upload failed:", err);
    const msg = err instanceof Error ? err.message : "Failed to upload order";
    return c.json({ ok: false, error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// 2. Attendee checkout — create a Stripe Checkout Session
// ---------------------------------------------------------------------------

/**
 * POST /api/stripe/create-checkout
 *
 * Body: { eventId, seriesId, claimerEmail? }
 *
 * Creates a Checkout Session with a destination charge to the organiser's
 * connected account. Two auth flows:
 *
 *   1. Wallet / passkey / local / para user — sends session delegation
 *      headers. Server verifies, sets metadata.claimerAddress from the
 *      VERIFIED parentAddress (body claimerAddress is ignored).
 *   2. Anonymous email-only user — no auth headers. Requires claimerEmail
 *      in the body. metadata.claimerAddress is empty.
 *
 * Never trust claimerAddress from the body. A front-runner could submit an
 * arbitrary address and bind a charge to a wallet they don't control.
 */
stripe.post("/create-checkout", async (c) => {
  // Phase A instrumentation — log span durations so we can see exactly where
  // the 3-5s perceived latency sits (Swarm event read vs Stripe API roundtrip).
  const t0 = performance.now();
  const span = (label: string, since: number) =>
    `${label}=${(performance.now() - since).toFixed(0)}ms`;

  // Read raw body once — we need the exact bytes for canonical sig verification.
  const rawBody = await c.req.text();
  let body: Record<string, unknown>;
  try {
    body = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { eventId, seriesId, claimerEmail, returnUrl, quantity: rawQty, orderRef, encryptedOrder, reservationId: rawReservationId } = body as {
    eventId: string;
    seriesId: string;
    claimerEmail?: string;
    returnUrl?: string;
    quantity?: number;
    orderRef?: string;
    encryptedOrder?: SealedBox;
    reservationId?: string;
  };
  const quantity = Math.max(1, Math.min(10, Number.isInteger(rawQty) ? rawQty as number : 1));

  // Validate reservation if one was supplied. The reservation is expected to
  // match this series + quantity; mismatches mean a stale/wrong client state
  // and we'd rather fail loudly than silently let the user pay against the
  // wrong hold.
  let reservationId: string | undefined;
  if (typeof rawReservationId === "string" && rawReservationId) {
    const r = getReservation(rawReservationId);
    if (!r) {
      return c.json({ ok: false, error: "Reservation not found or expired" }, 410);
    }
    if (r.seriesId !== seriesId) {
      return c.json({ ok: false, error: "Reservation series mismatch" }, 400);
    }
    if (r.quantity !== quantity) {
      return c.json({ ok: false, error: "Reservation quantity mismatch" }, 400);
    }
    if (r.consumedAt) {
      return c.json({ ok: false, error: "Reservation already consumed" }, 410);
    }
    if (new Date(r.expiresAt).getTime() < Date.now()) {
      return c.json({ ok: false, error: "Reservation expired" }, 410);
    }
    reservationId = r.id;
  }

  if (!eventId || !seriesId) {
    return c.json({ ok: false, error: "eventId and seriesId are required" }, 400);
  }

  // Validate pre-uploaded order ref — must be a 64-char hex string (Swarm ref).
  // Anything else is silently ignored; never echoed to Stripe metadata as-is.
  const preUploadedRef =
    typeof orderRef === "string" && /^[0-9a-f]{64}$/i.test(orderRef)
      ? orderRef.toLowerCase()
      : undefined;

  // Inline encrypted order (fallback path when client didn't pre-upload).
  // We'll upload in parallel with the event/status reads so Swarm latency
  // hides behind the reads.
  const shouldUploadInline =
    !preUploadedRef && encryptedOrder && typeof encryptedOrder === "object";

  // Soft auth: if session headers are present, verify them. Malformed auth
  // headers are rejected — never silently fall through to anonymous path.
  const authResult = tryVerifyAuth(c, rawBody);
  let verifiedAddress: string | undefined;
  if (authResult) {
    if (!authResult.ok) {
      return c.json({ ok: false, error: authResult.error }, 401);
    }
    verifiedAddress = authResult.parentAddress.toLowerCase();
  }

  if (!claimerEmail && !verifiedAddress) {
    return c.json({ ok: false, error: "claimerEmail or authenticated wallet session required" }, 400);
  }

  // Load event + availability check + (optionally) upload encrypted order in parallel.
  // Swarm upload is the slowest link (~3–10s cold); running it alongside event/status
  // reads hides its latency behind reads we'd be doing anyway.
  const userEmailHash = claimerEmail ? hashEmail(claimerEmail) : undefined;
  const tSwarm = performance.now();
  const [event, statusResult, inlineUploadedRef] = await Promise.all([
    getEvent(eventId),
    getClaimStatus(seriesId, verifiedAddress, userEmailHash).catch((err) => {
      // Swarm read failure — non-fatal; webhook will re-check on claim.
      console.warn("[stripe/create-checkout] Availability pre-check failed (continuing):", err);
      return null;
    }),
    shouldUploadInline
      ? uploadToBytes(JSON.stringify(encryptedOrder)).catch((err) => {
          // Inline upload failure is non-fatal — webhook falls back to the
          // minimal server-built seal so attendee still gets a ticket.
          console.warn("[stripe/create-checkout] Inline order upload failed (continuing):", err);
          return null as string | null;
        })
      : Promise.resolve(null as string | null),
  ]);
  const swarmMs = performance.now() - tSwarm;

  // Final ref we'll stamp into Stripe session metadata. Prefer client pre-upload
  // (fast path — client already did the work before clicking Pay).
  const finalOrderRef = preUploadedRef ?? (inlineUploadedRef ?? undefined);

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

  // Pre-flight availability + duplicate check (best-effort — result from parallel fetch above).
  if (statusResult) {
    if (statusResult.available <= 0) {
      return c.json({ ok: false, error: "Sold out" }, 409);
    }
    // Paid Stripe series allow multi-purchase (each payment_intent is unique).
    // Only block a repeat if approval is required — that's a pending-request
    // spam gate, not a paid-ticket gate.
    if (statusResult.userEdition != null && series.approvalRequired) {
      return c.json({ ok: false, error: "You already have a ticket for this series" }, 409);
    }
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

  // Prefer client-supplied returnUrl (preserves Swarm /bzz/{hash}/ path that
  // browsers strip from the Referer cross-origin). Falls back to Referer/Origin.
  const frontendUrl = validateReturnUrl(returnUrl) ?? getFrontendUrl(c);

  try {
    const s = getStripe();
    const tStripe = performance.now();
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
          quantity,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFee * quantity,
        transfer_data: {
          destination: organiserRecord.stripeAccountId,
        },
      },
      metadata: {
        eventId,
        seriesId,
        claimerEmail: claimerEmail || "",
        // Server-vouched: only set from a verified session, never from the body.
        // The webhook trusts this field because we wrote it.
        claimerAddress: verifiedAddress || "",
        quantity: String(quantity),
        // Pre-uploaded encrypted-order ref (Swarm /bytes). Either:
        //  - client pre-uploaded during form typing and passed `orderRef`, or
        //  - we just uploaded it inline (above) in parallel with the other reads.
        // Either way, the webhook attaches this ref to every ticket in the batch,
        // so multi-ticket orders never end up with empty attendee data.
        ...(finalOrderRef ? { orderRef: finalOrderRef } : {}),
        // Slot reservation id, consumed by the webhook on successful claim.
        // Optional: legacy / expired-reservation flows fall back to the
        // existing availability check at claim time.
        ...(reservationId ? { reservationId } : {}),
      },
      success_url: `${frontendUrl}/#/event/${eventId}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/#/event/${eventId}?stripe=cancelled`,
      ...(claimerEmail ? { customer_email: claimerEmail } : {}),
    });
    const stripeMs = performance.now() - tStripe;

    console.log(
      `[stripe/create-checkout] timings — swarm=${swarmMs.toFixed(0)}ms ` +
      `stripe-api=${stripeMs.toFixed(0)}ms ${span("total", t0)} ` +
      `(eventId=${eventId.slice(0, 8)} qty=${quantity})`,
    );

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
          // Tolerance of 3600s (1 hour) allows Stripe's retry schedule to
          // succeed even if our server was slow/down during the first delivery.
          // The session registry (checkAndConsumeSession) prevents any
          // already-processed event from being acted on a second time.
          verified = s.webhooks.constructEvent(rawBody, sig, secret, 3600);
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
        // Deduplicate before doing any work. Both the platform and connected-accounts
        // webhooks can deliver the same event; Stripe also retries on any non-2xx.
        // Consuming the session ID here (synchronously, before returning 200) ensures
        // we process each confirmed payment exactly once.
        if (!checkAndConsumeSession(session.id)) {
          console.log(`[stripe-webhook] Session ${session.id} already processed — skipping duplicate delivery`);
          break;
        }

        // Return 200 to Stripe immediately — Stripe best practice.
        // Stripe's delivery timeout is 30 s; our Swarm writes take 10–25 s.
        // The payment is already confirmed (payment_status === "paid") — the
        // Swarm writes are the result of that confirmation, not a prerequisite.
        // Errors are logged; unrecoverable failures auto-refund inside the handler.
        void handleSuccessfulPayment(session, event.created).catch((err) => {
          console.error("[stripe-webhook] Background claim failed:", err);
        });
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
 * Handle a successful Checkout Session — claim ticket(s) for the attendee.
 *
 * Uses the per-series queue (same as the /claim endpoint) to prevent two
 * concurrent webhooks from racing to claim the same slot.
 *
 * @param webhookEventCreated - Stripe event.created Unix timestamp (seconds).
 *   Used as claimedAt so the dashboard shows the actual payment time, not the
 *   webhook-processing time.
 */
async function handleSuccessfulPayment(
  session: import("stripe").Stripe.Checkout.Session,
  webhookEventCreated: number,
): Promise<void> {
  const { eventId, seriesId, claimerEmail, claimerAddress, quantity: qtyStr, orderRef: metaOrderRef, reservationId: metaReservationId } = session.metadata ?? {};

  if (!eventId || !seriesId) {
    console.error("[stripe-webhook] Missing eventId/seriesId in session metadata");
    return;
  }

  const quantity = Math.max(1, Math.min(10, parseInt(qtyStr ?? "1", 10) || 1));
  const claimedAt = new Date(webhookEventCreated * 1000).toISOString();

  // Consume the slot reservation if one was attached to the checkout session.
  // Lenient: a failed consume (expired / unknown) does NOT block the claim —
  // payment already landed, so we issue the ticket if seats are still
  // available. The /create-checkout pre-flight makes a hard expiry rare;
  // claimTicket() itself throws "No tickets available" if oversubscribed,
  // and the existing auto-refund logic handles that case.
  if (metaReservationId) {
    const consumed = consumeReservation(metaReservationId);
    if (consumed) {
      console.log(
        `[stripe-webhook] Consumed reservation ${metaReservationId} (qty=${consumed.quantity})`,
      );
    } else {
      console.warn(
        `[stripe-webhook] Reservation ${metaReservationId} could not be consumed — ` +
        `may be expired or already consumed. Falling back to availability check at claim time.`,
      );
    }
  }

  let identifier: ClaimIdentifier;
  if (claimerAddress) {
    identifier = {
      type: "wallet",
      address: claimerAddress.toLowerCase() as `0x${string}`,
      ...(claimerEmail
        ? { secondaryEmail: claimerEmail, secondaryEmailHash: hashEmail(claimerEmail) }
        : {}),
    };
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

  // Attendee data: prefer the client's pre-uploaded full-form order ref (passed
  // via session metadata). Falls back to a minimal server-built seal for the
  // edge case where the browser skipped pre-upload (e.g. offline at checkout).
  const prefetchedOrderRef =
    typeof metaOrderRef === "string" && /^[0-9a-f]{64}$/i.test(metaOrderRef)
      ? metaOrderRef.toLowerCase()
      : undefined;

  let encryptedOrder: SealedBox | undefined;
  let eventTitle = "";
  let eventDate = "";
  let eventLocation = "";
  let seriesName = "";
  let totalSupply = 0;
  try {
    const ev = await getEvent(eventId);
    if (ev) {
      eventTitle = ev.title;
      eventDate = ev.startDate;
      eventLocation = ev.location ?? "";
      const ser = ev.series.find((s) => s.seriesId === seriesId);
      if (ser) { seriesName = ser.name; totalSupply = ser.totalSupply; }
      if (!prefetchedOrderRef && ev.encryptionKey) {
        // Fallback minimal seal — only when no pre-uploaded ref is available.
        encryptedOrder = await sealJson(ev.encryptionKey, {
          seriesId,
          ...(claimerEmail ? { claimerEmail } : {}),
          ...(claimerAddress ? { claimerAddress: claimerAddress.toLowerCase() } : {}),
        });
      }
    }
  } catch (err) {
    console.warn("[stripe-webhook] Could not build encrypted order (non-fatal):", err);
  }

  const claimedResults: Array<{ edition: number; qrContent: string }> = [];

  for (let i = 0; i < quantity; i++) {
    const ticketNum = quantity > 1 ? ` (${i + 1}/${quantity})` : "";
    try {
      const result = await queueSeriesClaim(seriesId, () =>
        claimTicket({
          seriesId,
          identifier,
          via: "stripe",
          paid: true,
          claimedAt,
          // Pre-uploaded full-form ref (from client) wins. Otherwise fall back
          // to the minimal seal built above. Every ticket in the batch ends up
          // with the same orderRef so dashboard rows are never blank.
          ...(prefetchedOrderRef
            ? { orderRef: prefetchedOrderRef }
            : { encryptedOrder }),
        }),
      );
      console.log(`[stripe-webhook] Ticket claimed${ticketNum}: series=${seriesId}, edition=${result.edition}`);
      if (result.originalSignature) {
        claimedResults.push({
          edition: result.edition,
          qrContent: `woco://t/${eventId}/${seriesId}/${result.edition}/${result.originalSignature}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[stripe-webhook] Failed to claim ticket${ticketNum}:`, msg);

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
      // Stop claiming further tickets in the batch if we hit an unrecoverable error
      if (isUnrecoverable) break;
    }
  }

  // Auto-send confirmation email with all claimed tickets if we have an email address.
  // Stripe gives us the buyer's name from `customer_details` (filled by the user
  // at checkout when card billing is collected). Pass it through so it can be
  // baked into the composite ticket-card PNG and shown on the standalone page.
  if (claimerEmail && claimedResults.length > 0 && eventTitle) {
    const buyerName = session.customer_details?.name?.trim() || undefined;
    sendTicketEmail({
      to: claimerEmail,
      eventTitle,
      eventDate,
      eventLocation,
      seriesName,
      totalSupply,
      tickets: claimedResults,
      buyerName,
    }).catch((err) => {
      console.error("[stripe-webhook] Auto-email failed (non-fatal):", err);
    });
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

  const { seriesId, encryptedOrder, claimerEmail, claimerAddress, expectedEditions } = body as {
    seriesId: string;
    encryptedOrder: SealedBox;
    claimerEmail?: string;
    claimerAddress?: string;
    expectedEditions?: number;
  };

  if (!seriesId || !encryptedOrder) {
    return c.json({ ok: false, error: "seriesId and encryptedOrder are required" }, 400);
  }
  if (!claimerEmail && !claimerAddress) {
    return c.json({ ok: false, error: "claimerEmail or claimerAddress is required" }, 400);
  }

  // Expected number of entries we must see in the claimers feed before writing
  // — must match the quantity Stripe charged for. Defaults to 1 for legacy
  // single-ticket calls that don't send the field.
  const expected = Math.max(
    1,
    Math.min(10, Number.isInteger(expectedEditions) ? expectedEditions as number : 1),
  );

  // Determine the claimer key (must match what claim-service wrote)
  const claimerKey = claimerAddress
    ? claimerAddress.toLowerCase()
    : `email:${hashEmail(claimerEmail!)}`;

  try {
    // Upload encrypted order to Swarm first (outside the queue — no feed access needed)
    const orderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
    console.log(`[stripe/save-order] Encrypted order uploaded: ${orderRef} (expected=${expected})`);

    // Poll for expected entries OUTSIDE the queue so we don't block the very
    // webhook claim writes we're waiting on. Previously this loop ran INSIDE
    // queueSeriesClaim, which starved the queued claims and guaranteed a 30s
    // timeout whenever save-order fired before the webhook finished.
    //
    // Note: this path is now mostly a no-op for Stripe flows that pre-upload
    // via /prepare-order — the webhook already attaches the full orderRef.
    // Kept as a backward-compat fallback (old clients) and for wallet-mode
    // edge cases where the encrypted order wasn't prepared pre-redirect.
    let observed = 0;
    const retryDelays = [1000, 2000, 3000, 5000, 8000, 11000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
      }
      const page = await readFeedPage(topicClaimers(seriesId));
      if (!page) continue;
      const feed = decodeJsonFeed<ClaimersFeed>(page);
      if (!feed) continue;
      observed = feed.claimers.filter(
        (e) => e.claimerAddress.toLowerCase() === claimerKey.toLowerCase(),
      ).length;
      if (observed >= expected) break;
    }

    if (observed === 0) {
      throw new Error("Claimer entry not found — ticket may not have been claimed yet");
    }
    if (observed < expected) {
      console.warn(
        `[stripe/save-order] Only ${observed}/${expected} entries visible after retries — ` +
        `attaching orderRef to what we have`,
      );
    }

    // Now enter the queue for a quick read-modify-write. Claims 2..N that were
    // queued before or after us will each read/write the feed; our write is
    // atomic relative to theirs.
    //
    // IMPORTANT: only attach to entries that don't already have an orderRef.
    // The webhook is the canonical writer and attaches a per-purchase orderRef
    // when each ticket is claimed. Without this guard, a repeat buyer's later
    // /save-order call would overwrite the orderRef on every past entry that
    // shares their email, collapsing all historical orders onto the latest
    // form data in the dashboard.
    let matchCount = 0;
    await queueSeriesClaim(seriesId, async () => {
      const page = await readFeedPage(topicClaimers(seriesId));
      const feed = page ? decodeJsonFeed<ClaimersFeed>(page) : null;
      if (!feed) throw new Error("Claimers feed not found");

      let dirty = false;
      for (const e of feed.claimers) {
        if (e.claimerAddress.toLowerCase() !== claimerKey.toLowerCase()) continue;
        if (e.orderRef) continue;
        e.orderRef = orderRef;
        matchCount++;
        dirty = true;
      }
      if (!dirty) return;
      feed.updatedAt = new Date().toISOString();
      await writeFeedPage(topicClaimers(seriesId), encodeJsonFeed(feed));
    });

    console.log(`[stripe/save-order] Order data attached to ${matchCount} claimer entries for ${claimerKey}, series ${seriesId}`);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[stripe/save-order] Failed:", err);
    const msg = err instanceof Error ? err.message : "Failed to save order data";
    return c.json({ ok: false, error: msg }, 500);
  }
});

export { stripe as stripeRoutes };
