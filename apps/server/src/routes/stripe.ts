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
  deleteStripeAccount,
} from "../lib/stripe/accounts.js";
import { getEvent } from "../lib/event/service.js";
import { claimTicket, hashEmail, getClaimStatus, type ClaimIdentifier } from "../lib/event/claim-service.js";
import { checkPodGate, gatePhase, gateNeedsClaimCount } from "../lib/pod/gate-check.js";
import { queueSeriesClaim } from "./claims.js";
import { sealJson, buildTicketCanonicalMessage } from "@woco/shared";
import type { SealedBox, SeriesManifestBlob } from "@woco/shared";
import { batchClaimForOnChain, generateBurner, ON_CHAIN_BATCH_MAX, isSponsorReady } from "../lib/chain/sponsor-wallet.js";
import { getActiveChainId } from "../lib/chain/event-contract.js";
import { uploadToBytes, downloadFromBytes } from "../lib/swarm/bytes.js";
import { readFeedPage, writeFeedPage, decodeJsonFeed, encodeJsonFeed } from "../lib/swarm/feeds.js";
import { topicClaimers } from "../lib/swarm/topics.js";
import type { ClaimersFeed } from "@woco/shared";
import { checkAndConsumeSession } from "../lib/stripe/session-registry.js";
import { sendTicketEmail } from "./tickets.js";
import { getSiteTheme } from "../lib/site/service.js";
import { getReservation, consume as consumeReservation } from "../lib/event/reservation-store.js";
import { validateReturnUrl, getFrontendUrl, canonicalSuccessUrl } from "../lib/stripe/return-url.js";
import { updateOrder as updateShopOrder, getOrder as getShopOrder, getShop } from "../lib/shop/service.js";
import { sendShopOrderEmail } from "../lib/email/shop-receipt.js";

const stripe = new Hono<AppEnv>();

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
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
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
      collection_options: { fields: "eventually_due" },
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
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.code === "resource_missing") {
      deleteStripeAccount(organiserAddress);
      console.log(`[stripe] Account ${record.stripeAccountId} not found on Stripe — removed local record`);
      return c.json({ ok: true, connected: false });
    }
    console.error("[stripe] Failed to retrieve account:", err);
    return c.json({
      ok: true,
      connected: true,
      stripeAccountId: record.stripeAccountId,
      onboardingComplete: record.onboardingComplete,
    });
  }
});

/** DELETE /api/stripe/account — remove our local record for a deleted Stripe account */
stripe.delete("/account", requireAuth, async (c) => {
  const organiserAddress = c.get("parentAddress").toLowerCase();
  const deleted = deleteStripeAccount(organiserAddress);
  if (!deleted) {
    return c.json({ ok: false, error: "No Stripe account record found" }, 404);
  }
  return c.json({ ok: true });
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

  const { eventId, seriesId, claimerEmail, returnUrl, cancelUrl, quantity: rawQty, orderRef, encryptedOrder, reservationId: rawReservationId, siteId: rawSiteId } = body as {
    eventId: string;
    seriesId: string;
    claimerEmail?: string;
    returnUrl?: string;
    /** Full current-page URL (including hash) for the Stripe cancel redirect.
     *  Accepted as-is (any HTTPS URL) — it's just a back-navigation, not a
     *  security gate. Separate from returnUrl so success and cancel can differ. */
    cancelUrl?: string;
    quantity?: number;
    orderRef?: string;
    encryptedOrder?: SealedBox;
    reservationId?: string;
    /** Deployed site id — passed when checkout originates from an organiser's
     *  site-builder page so the webhook can theme the ticket email + PNG. */
    siteId?: string;
  };
  const siteId = typeof rawSiteId === "string" && /^[0-9a-z_-]{10,}$/i.test(rawSiteId) ? rawSiteId : undefined;
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
  const authResult = await tryVerifyAuth(c, rawBody);
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

  // Load event + (when no reservation) availability check + (optionally) upload
  // encrypted order in parallel. Swarm upload is the slowest link (~3–10s cold);
  // running it alongside the event read hides its latency behind work we'd be
  // doing anyway.
  //
  // When a valid reservation is already held, the seat is locked and the
  // duplicate-claim re-check happens in the webhook anyway — skip the
  // expensive availability read entirely. This is the dominant pre-Pay
  // latency for the reservation path.
  const userEmailHash = claimerEmail ? hashEmail(claimerEmail) : undefined;
  const tSwarm = performance.now();
  const skipAvailability = !!reservationId;
  const [event, statusResult, inlineUploadedRef] = await Promise.all([
    getEvent(eventId),
    skipAvailability
      ? Promise.resolve(null)
      : getClaimStatus(seriesId, verifiedAddress, userEmailHash).catch((err) => {
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

  // POD-holdings gate on the CARD rail. The gate is a property of the buyer's
  // ACCOUNT (the verified wallet's on-chain holdings), NOT the payment method —
  // so a gated series is still payable by card, provided the authenticated
  // account passes the gate. We bind the resulting claim to `verifiedAddress`
  // (stamped into metadata.claimerAddress → the webhook claims to that wallet),
  // keeping "server uses the VERIFIED holder address only". Enforce BEFORE any
  // Stripe session is created so a gated-out buyer is never charged.
  if (series.gate) {
    // firstN needs this series' committed claim count. Reuse the pre-flight
    // status read when present; only fetch separately if it was skipped.
    let tierClaimed: number | undefined;
    if (gateNeedsClaimCount(series.gate)) {
      tierClaimed = statusResult
        ? statusResult.claimed
        : await getClaimStatus(seriesId).then((s) => s.claimed).catch(() => undefined);
    }
    const phase = gatePhase(series.gate, { tierClaimed });
    if (phase === "closed") {
      return c.json({ ok: false, gated: true, error: "This ticket is not currently available." }, 403);
    }
    if (phase === "holders-only") {
      if (!verifiedAddress) {
        return c.json(
          { ok: false, gated: true, error: "This ticket is gated — sign in with the wallet that holds the required POD, then pay by card." },
          401,
        );
      }
      const decision = await checkPodGate(series.gate, verifiedAddress, { tierClaimed });
      if (!decision.ok) {
        return c.json({ ok: false, gated: true, error: decision.reason }, 403);
      }
    }
    // phase === "open": no holdings requirement — card/email buyer proceeds.
  }

  const stripeCurrency = series.payment.currency.toLowerCase(); // "usd", "gbp", "eur"

  // Flat 10% buyer-fee policy: buyer always pays ticket × 1.10.
  // application_fee equals the estimated Stripe processing cost so the
  // platform breaks even, organiser receives the remainder (~7% above ticket
  // price after Stripe takes its ~3%). This overrides series.feePassedToCustomer
  // and PLATFORM_FEE_BP for the card path; crypto/escrow path is unchanged.
  const STRIPE_PERCENT = 0.029;
  const STRIPE_FIXED: Record<string, number> = { gbp: 0.20, usd: 0.30, eur: 0.25 };
  const FLAT_BUYER_FEE_BP = 1000; // 10%

  const baseAmount = Math.round(priceFloat * 100);
  const buyerFeeAmount = Math.round(baseAmount * FLAT_BUYER_FEE_BP / 10_000);
  const chargeAmount = baseAmount + buyerFeeAmount; // per unit
  const totalCharge = chargeAmount * quantity;
  const stripeFixedCents = Math.round((STRIPE_FIXED[stripeCurrency] ?? 0.20) * 100);
  // Stripe's fixed component is per CHARGE (not per unit), so apply once per session.
  const totalStripeEstimate = Math.round(totalCharge * STRIPE_PERCENT) + stripeFixedCents;
  const totalBuyerFee = buyerFeeAmount * quantity;
  // Capped at total buyer fee so organiser is never net-negative on this policy.
  const totalApplicationFee = Math.min(totalStripeEstimate, totalBuyerFee);

  // Find the organiser's connected account
  const organiserRecord = getStripeAccount(event.creatorAddress.toLowerCase());
  if (!organiserRecord?.onboardingComplete) {
    return c.json({ ok: false, error: "Event organiser has not completed Stripe onboarding" }, 400);
  }

  // Sponsor-readiness gate. For on-chain (v2) series the webhook mints via the
  // sponsor wallet's `batchClaimFor`, which reverts `NotAuthorised` if the
  // sponsor isn't on the contract allow-list — that would charge the buyer then
  // auto-refund. Refuse the checkout up front instead. Fail-OPEN on an RPC error
  // (transient) since the webhook's auto-refund remains the backstop; only a
  // definitive "not authorised" blocks the sale.
  if (series.swarmManifestRef && series.onChainEventId) {
    let sponsorReady = true;
    try {
      sponsorReady = await isSponsorReady(getActiveChainId());
    } catch (err) {
      console.warn("[stripe/create-checkout] sponsor readiness check errored (continuing):", err);
    }
    if (!sponsorReady) {
      console.error(
        `[stripe/create-checkout] BLOCKED — sponsor not authorised on chain ${getActiveChainId()}; ` +
        `refusing to charge (eventId=${eventId.slice(0, 8)} series=${seriesId.slice(0, 8)})`,
      );
      return c.json(
        { ok: false, error: "Ticketing is temporarily unavailable — please try again shortly." },
        503,
      );
    }
  }

  const resolvedFrontendUrl = validateReturnUrl(returnUrl) ?? getFrontendUrl(c);
  // Platform purchases use the dedicated WoCo success page. Site-originated
  // purchases must return to the organiser site so the site runtime can show
  // its own Stripe success banner and keep the buyer in the branded UI.
  const frontendUrl = siteId ? resolvedFrontendUrl : canonicalSuccessUrl(resolvedFrontendUrl);

  // Cancel URL: use the client-supplied full page URL (including hash fragment)
  // so the buyer is returned to exactly where they came from, even on standalone
  // ENS event sites whose host isn't in ALLOWED_HOSTS. Validated only as a
  // well-formed HTTPS URL — no host restriction needed for a back-navigation.
  function buildCancelUrl(marker: string): string {
    if (cancelUrl) {
      try {
        const u = new URL(cancelUrl);
        if (u.protocol === "https:" || u.hostname === "localhost") {
          const sep = cancelUrl.includes("?") ? "&" : "?";
          return `${cancelUrl}${sep}${marker}`;
        }
      } catch { /* fall through */ }
    }
    return `${frontendUrl}/#/event/${eventId}?${marker}`;
  }
  const stripeCancelUrl = buildCancelUrl("stripe=cancelled");
  const stripeSuccessUrl = siteId
    ? `${frontendUrl}/#/events/${eventId}?stripe=success&session_id={CHECKOUT_SESSION_ID}`
    : `${frontendUrl}/#/event/${eventId}/purchased?stripe=success&session_id={CHECKOUT_SESSION_ID}`;

  try {
    const s = getStripe();
    const tStripe = performance.now();
    // Direct charge on the connected account: Stripe Checkout shows the
    // organiser's business name (set during Express onboarding) rather than
    // the platform name. The platform still collects application_fee_amount.
    const session = await s.checkout.sessions.create(
      {
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
          application_fee_amount: totalApplicationFee,
          // No transfer_data — direct charge settles on the connected account.
        },
        metadata: {
          eventId,
          seriesId,
          claimerEmail: claimerEmail || "",
          // Server-vouched: only set from a verified session, never from the body.
          // The webhook trusts this field because we wrote it.
          claimerAddress: verifiedAddress || "",
          quantity: String(quantity),
          // Stored so the webhook can issue refunds through the connected account.
          connectedAccountId: organiserRecord.stripeAccountId,
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
          // Site id — present when checkout comes from a deployed organiser site.
          // Webhook uses it to fetch the site theme for branded email + ticket PNG.
          ...(siteId ? { siteId } : {}),
        },
        success_url: stripeSuccessUrl,
        cancel_url: stripeCancelUrl,
        ...(claimerEmail ? { customer_email: claimerEmail } : {}),
      },
      { stripeAccount: organiserRecord.stripeAccountId },
    );
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
    // Two endpoints exist: "Connected accounts" (delivers checkout.session.completed
    // from direct-charge sessions + account.updated for onboarding) and "Your account"
    // (platform-level events; kept for any legacy destination-charge sessions still
    // in flight). Each has its own signing secret — try both before rejecting.
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

  switch (event.type as string) {
    case "checkout.session.completed": {
      const session = event.data.object as import("stripe").Stripe.Checkout.Session;
      if (session.payment_status === "paid") {
        // Deduplicate before doing any work. Both the platform and connected-accounts
        // webhooks can deliver the same event; Stripe also retries on any non-2xx.
        // Consuming the session ID here (synchronously, before returning 200) ensures
        // we process each confirmed payment exactly once.
        if (!checkAndConsumeSession(session.id)) {
          console.log(`[stripe-webhook] Session ${session.id} already processed — skipping duplicate delivery`);
          break;
        }

        // Shop orders and event tickets share this one webhook endpoint (and its
        // two signing secrets) but are distinct flows. A shop order already
        // exists as "pending" — the webhook only flips it to "paid". Branch on
        // metadata: shopId+orderId ⇒ shop; eventId+seriesId ⇒ event tickets.
        if (session.metadata?.shopId && session.metadata?.orderId) {
          void handleShopOrderPaid(session).catch((err) => {
            console.error("[stripe-webhook] Background shop-order update failed:", err);
          });
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
      const account = event.data.object as import("stripe").Stripe.Account;
      const complete = !!(account.charges_enabled && account.payouts_enabled);
      updateOnboardingStatus(account.id, complete);
      console.log(`[stripe-webhook] Account ${account.id} updated: charges=${account.charges_enabled}, payouts=${account.payouts_enabled}`);
      break;
    }

    case "account.deleted": {
      const account = event.data.object as { id: string };
      const organiser = getOrganiserByStripeAccount(account.id);
      if (organiser) {
        deleteStripeAccount(organiser);
        console.log(`[stripe-webhook] Account ${account.id} deleted — removed record for ${organiser}`);
      }
      break;
    }

    default:
      // Ignore other event types
      break;
  }

  return c.json({ received: true });
});

/**
 * Mark a shop order paid after a confirmed Checkout Session.
 *
 * Unlike event tickets (minted on payment), a shop order already exists as
 * "pending" — this only transitions it to "paid" and attaches the Stripe
 * session as proof. Idempotent: a late or duplicate webhook that finds the
 * order already past "pending" is a no-op (the session registry already
 * dedupes per session id; this guards a cancelled order from being revived).
 */
async function handleShopOrderPaid(
  session: import("stripe").Stripe.Checkout.Session,
): Promise<void> {
  const { shopId, orderId } = session.metadata ?? {};
  if (!shopId || !orderId) {
    console.error("[stripe-webhook] Shop order missing shopId/orderId in metadata");
    return;
  }

  const order = await getShopOrder(shopId, orderId);
  if (!order) {
    console.error(`[stripe-webhook] Shop order not found: shop=${shopId.slice(0, 8)} order=${orderId.slice(0, 8)}`);
    return;
  }
  if (order.status !== "pending") {
    console.log(`[stripe-webhook] Shop order ${orderId.slice(0, 8)} already ${order.status} — skipping`);
    return;
  }

  const buyerEmail = session.customer_details?.email ?? undefined;
  const updated = await updateShopOrder(shopId, orderId, {
    status: "paid",
    payment: { rail: "card", stripeSessionId: session.id },
    // Privacy: store the buyer's email as an HMAC hash, same as ticket claims.
    ...(buyerEmail && !order.buyerRef ? { buyerRef: hashEmail(buyerEmail) } : {}),
  });
  console.log(
    `[stripe-webhook] Shop order ${updated ? "paid" : "update-failed"}: ` +
    `shop=${shopId.slice(0, 8)} order=${orderId.slice(0, 8)} total=${order.total} ${order.currency}`,
  );

  if (buyerEmail && updated) {
    void (async () => {
      try {
        const shop = await getShop(shopId);
        if (!shop) return;
        await sendShopOrderEmail({ to: buyerEmail, shopName: shop.name, order: updated });
        console.log(`[stripe-webhook] Shop receipt sent: order=${orderId.slice(0, 8)} to=${buyerEmail.slice(0, 8)}…`);
      } catch (err) {
        console.error("[stripe-webhook] Shop receipt email failed (non-fatal):", err);
      }
    })();
  }
}

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
  const { eventId, seriesId, claimerEmail, claimerAddress, quantity: qtyStr, orderRef: metaOrderRef, reservationId: metaReservationId, siteId: metaSiteId } = session.metadata ?? {};

  if (!eventId || !seriesId) {
    console.error("[stripe-webhook] Missing eventId/seriesId in session metadata");
    return;
  }

  const quantity = Math.max(1, Math.min(10, parseInt(qtyStr ?? "1", 10) || 1));
  const claimedAt = new Date(webhookEventCreated * 1000).toISOString();

  // The reservation is consumed AFTER all claims commit (see end of function),
  // not at webhook entry. Reason: claiming N tickets is sequential through the
  // per-series mutex and each claim is a Swarm write (~3–8s). Consuming up
  // front would drop heldFor() to 0 immediately, letting concurrent buyers
  // race in and reserve the same physical slots while this webhook is still
  // mid-claim. Holding the reservation for the duration keeps `available`
  // honest from the perspective of any /reserve call that lands in parallel.

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
  let isV2 = false;
  let v2OnChainEventId = "";
  let v2SwarmManifestRef = "";

  try {
    const ev = await getEvent(eventId);
    if (ev) {
      eventTitle = ev.title;
      eventDate = ev.startDate;
      eventLocation = ev.location ?? "";
      const ser = ev.series.find((s) => s.seriesId === seriesId);
      if (ser) {
        seriesName = ser.name;
        totalSupply = ser.totalSupply;
        if (ser.swarmManifestRef && ser.onChainEventId) {
          isV2 = true;
          v2OnChainEventId = ser.onChainEventId;
          v2SwarmManifestRef = ser.swarmManifestRef;
        }
      }
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
  let stoppedReason: string | null = null;

  if (isV2) {
    // ── v2 on-chain path ────────────────────────────────────────────────────
    // Resolve the orderRef once for the whole batch (all tickets share one
    // encrypted order blob — same buyer, same form submission).
    let batchOrderRef: string | undefined = prefetchedOrderRef;
    if (!batchOrderRef && encryptedOrder) {
      try {
        batchOrderRef = await uploadToBytes(JSON.stringify(encryptedOrder));
        console.log(`[stripe-webhook/v2] Fallback order uploaded: ${batchOrderRef}`);
      } catch (err) {
        console.warn("[stripe-webhook/v2] Fallback order upload failed:", err);
      }
    }

    // Fetch the manifest blob once; all slots for this series share it.
    let manifestBlob: SeriesManifestBlob | null = null;
    try {
      const raw = await downloadFromBytes(v2SwarmManifestRef);
      manifestBlob = JSON.parse(raw) as SeriesManifestBlob;
    } catch (err) {
      console.error("[stripe-webhook/v2] Failed to fetch manifest blob:", err);
      stoppedReason = "Manifest not found";
    }

    if (!batchOrderRef) {
      stoppedReason = "No orderRef available for on-chain claim";
    } else if (!manifestBlob) {
      stoppedReason = "Manifest not available";
    } else {
      const orderRefBytes32 = "0x" + batchOrderRef;

      // Generate ALL burners up front. Keys live in memory only for as long
      // as it takes to sign their canonical message; the array is discarded
      // when this scope exits. Nothing about the burner is persisted apart
      // from its address (recorded on-chain as slotOwner).
      const burners = Array.from({ length: quantity }, () => generateBurner());

      // Chunk into on-chain batches of ON_CHAIN_BATCH_MAX (=100). For
      // quantity ≤ 100 this is one tx. For an enterprise 200-ticket order:
      // 2 sequential txs. Each chunk is all-or-nothing on-chain (the
      // contract reverts if the batch would exceed supply); partial
      // refund logic below handles cross-chunk partial failure (chunk 1
      // succeeds, chunk 2 fails on supply exhaustion).
      const slotsForBurners: number[] = [];
      for (let chunkStart = 0; chunkStart < burners.length && !stoppedReason; chunkStart += ON_CHAIN_BATCH_MAX) {
        const chunk = burners.slice(chunkStart, chunkStart + ON_CHAIN_BATCH_MAX);
        const chunkAddresses = chunk.map((w) => w.address);
        try {
          const chunkSlots = await batchClaimForOnChain(
            v2OnChainEventId,
            chunkAddresses,
            orderRefBytes32,
          );
          slotsForBurners.push(...chunkSlots);
          console.log(
            `[stripe-webhook/v2] batchClaimFor chunk ${chunkStart}..${chunkStart + chunk.length} ` +
            `→ slots=${chunkSlots[0]}..${chunkSlots[chunkSlots.length - 1]}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[stripe-webhook/v2] batchClaimFor failed at chunk ${chunkStart}:`, msg);
          // Insufficient supply / Sold out / Event not found are all unrecoverable.
          // Any tx-level revert means this chunk's state changes were rolled back —
          // we keep whatever slotsForBurners has from prior chunks and refund the rest.
          stoppedReason = msg;
        }
      }

      // Sign + build QR for every slot we actually got. Signing is purely
      // local crypto; ~0.2ms per sig, no chain round-trip.
      for (let i = 0; i < slotsForBurners.length; i++) {
        const slot = slotsForBurners[i];
        const edition = slot + 1;
        const canonical = buildTicketCanonicalMessage({
          onChainEventId: v2OnChainEventId,
          seriesId,
          edition,
        });
        const ticketSig = await burners[i].signMessage(canonical);

        // QR carries the per-ticket signature. Door verifies by:
        //   recovered = ecrecover(personalHash(canonical), ticketSig)
        //   require(recovered == slotOwner[onChainEventId][edition - 1])
        const qrContent = `woco://t/${eventId}/${seriesId}/${edition}/${ticketSig}`;
        claimedResults.push({ edition, qrContent });
      }
      // burners[] goes out of scope here — private keys are unreferenced
      // and eligible for garbage collection.
    }
  } else {
    // ── v1 Swarm-feed path (unchanged) ─────────────────────────────────────
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

        if (isUnrecoverable) {
          stoppedReason = msg;
          break;
        }
      }
    }
  }

  // Now release the seat hold — all claims that were going to land have
  // landed. Doing this here (vs. at webhook entry) means concurrent /reserve
  // calls saw the correct held count throughout the slow Swarm-write phase.
  if (metaReservationId) {
    const consumed = consumeReservation(metaReservationId);
    if (consumed) {
      console.log(
        `[stripe-webhook] Consumed reservation ${metaReservationId} (qty=${consumed.quantity}, claimed=${claimedResults.length})`,
      );
    }
  }

  // Partial-refund logic: if some tickets claimed but the batch couldn't
  // finish (oversold mid-flight, etc.), refund only the unfilled portion
  // pro-rata against amount_total. Refunding the whole intent here would
  // claw back £176 from a buyer who already received 7 of 8 emailed tickets.
  // If ZERO tickets claimed, refund the whole intent as before.
  const unfilled = quantity - claimedResults.length;
  if (stoppedReason && unfilled > 0 && session.payment_intent) {
    const piId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent.id;
    try {
      const s = getStripe();
      // Direct-charge sessions: refund must go through the connected account.
      // connectedAccountId is stamped into metadata at checkout-session creation.
      const connectedAccountId = session.metadata?.connectedAccountId || undefined;
      const amountTotal = session.amount_total ?? 0;
      // Pro-rata the total (which already includes any buyer-paid fee) by
      // unit. Round so we never refund more than was paid.
      const refundAmount =
        amountTotal > 0 && quantity > 0
          ? Math.min(amountTotal, Math.round((amountTotal / quantity) * unfilled))
          : 0;
      const refundParams: import("stripe").Stripe.RefundCreateParams = {
        payment_intent: piId,
        reason: "requested_by_customer",
        metadata: {
          reason: "ticket-claim-failed",
          failureMessage: stoppedReason.slice(0, 200),
          seriesId,
          eventId,
          quantityPaid: String(quantity),
          quantityClaimed: String(claimedResults.length),
          quantityUnfilled: String(unfilled),
        },
      };
      // Only set `amount` for partial refunds. When claimedResults.length === 0
      // we omit it so Stripe refunds the full intent — same as the old behaviour.
      if (claimedResults.length > 0 && refundAmount > 0) {
        refundParams.amount = refundAmount;
      }
      const refund = await s.refunds.create(
        refundParams,
        connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
      );
      console.log(
        `[stripe-webhook] Auto-refunded ${piId} (refund=${refund.id}, amount=${refundParams.amount ?? "full"}, unfilled=${unfilled}/${quantity}) — ${stoppedReason}`,
      );
    } catch (refundErr) {
      console.error("[stripe-webhook] Auto-refund FAILED — manual intervention required:", refundErr);
    }
  }

  // Auto-send confirmation email with all claimed tickets if we have an email address.
  // Stripe gives us the buyer's name from `customer_details` (filled by the user
  // at checkout when card billing is collected). Pass it through so it can be
  // baked into the composite ticket-card PNG and shown on the standalone page.
  if (claimerEmail && claimedResults.length > 0 && eventTitle) {
    const buyerName = session.customer_details?.name?.trim() || undefined;
    const siteThemePromise = metaSiteId ? getSiteTheme(metaSiteId) : Promise.resolve(null);
    siteThemePromise
      .then((siteTheme) =>
        sendTicketEmail({
          to: claimerEmail,
          eventTitle,
          eventDate,
          eventLocation,
          seriesName,
          totalSupply,
          tickets: claimedResults,
          buyerName,
          palette: siteTheme?.palette,
          siteId: metaSiteId || undefined,
        }),
      )
      .catch((err) => {
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
