/**
 * Stripe Connect routes — organiser onboarding + attendee checkout.
 *
 * Onboarding uses Stripe's hosted flow (Account Links).
 * Payments use DIRECT charges on the organiser's connected account via Stripe
 * Checkout Sessions — session created with `{stripeAccount}` and no
 * `transfer_data`, so the organiser is merchant of record and carries
 * first-line dispute liability. Accounts are created under Managed Risk
 * (controller properties, `losses.payments = "stripe"` — lib/stripe/account-params.ts),
 * so unrecoverable negative balances fall on Stripe, not the platform.
 * See docs/legal/DATA_INVENTORY.md §5.1 and docs/PAYOUTS.md §4/§6.
 */

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, tryVerifyAuth } from "../middleware/auth.js";
import { getStripe } from "../lib/stripe/client.js";
import {
  getStripeAccount,
  setStripeAccount,
  setDefaultCurrency,
  updateOnboardingStatus,
  getOrganiserByStripeAccount,
  deleteStripeAccount,
} from "../lib/stripe/accounts.js";
import { getEvent } from "../lib/event/service.js";
import { checkSalesWindow, salesClosedMessage } from "../lib/event/sales-window.js";
import { checkSeriesSaleWindow, seriesSaleMessage } from "../lib/event/series-window.js";
import { checkoutExpiresAt } from "../lib/event/checkout-expiry.js";
import { hashEmail, type ClaimIdentifier } from "../lib/event/claim-service.js";
import { checkPodGate, gatePhase, gateNeedsClaimCount } from "../lib/pod/gate-check.js";
import { sealJson, buildTicketCanonicalMessage } from "@woco/shared";
import { computeCardFees } from "../lib/stripe/checkout-fees.js";
import { captureCheckoutConsent } from "../lib/marketing/consent-capture.js";
import type { SealedBox, SeriesManifestBlob, PayoutsResponse } from "@woco/shared";
import { batchClaimForOnChain, generateBurner, ON_CHAIN_BATCH_MAX, isSponsorReady } from "../lib/chain/sponsor-wallet.js";
import { getActiveChainId, getOnChainEvent } from "../lib/chain/event-contract.js";
import { uploadToBytes, downloadFromBytes } from "../lib/swarm/bytes.js";
import { readFeedPage, writeFeedPage, decodeJsonFeed, encodeJsonFeed } from "../lib/swarm/feeds.js";
import { checkAndConsumeSession } from "../lib/stripe/session-registry.js";
import { sendTicketEmail } from "./tickets.js";
import { bindTicket } from "../lib/gate/store.js";
import { getSiteTheme, resolveSiteEventSigner } from "../lib/site/service.js";
import { getReservation, consume as consumeReservation } from "../lib/event/reservation-store.js";
import { validateReturnUrl, getFrontendUrl, canonicalSuccessUrl } from "../lib/stripe/return-url.js";
import { updateOrder as updateShopOrder, getOrder as getShopOrder, getShop } from "../lib/shop/service.js";
import { sendShopOrderEmail } from "../lib/email/shop-receipt.js";
import { ensureManualPayoutSchedule } from "../lib/stripe/payout-schedule.js";
import { buildConnectedAccountParams } from "../lib/stripe/account-params.js";
import {
  buildAccountSessionParams,
  classifyAccountSessionError,
  resolvePublishableKey,
} from "../lib/stripe/account-session.js";
import {
  decideRequirementNudge,
  getNudgeState,
  setNudgeState,
} from "../lib/stripe/requirement-nudge.js";
import { sendRequirementNudge } from "../lib/email/requirement-nudge.js";
import { eventReleaseAfter, shopReleaseAfter } from "../lib/stripe/payout-policy.js";
import {
  recordHeld as recordHeldPayout,
  markVoid as markPayoutVoid,
  listByOrganiser as listPayoutsByOrganiser,
} from "../lib/stripe/payout-ledger.js";
import { buildPayoutsResponse } from "../lib/stripe/payout-view.js";
import { RateWindow } from "../lib/marketing/rate-window.js";

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
    const account = await s.accounts.create(buildConnectedAccountParams(organiserAddress));

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

    // Cache the payout currency alongside the status. This is the one place
    // that already retrieves the full Account on an organiser-initiated request,
    // so it costs no extra call — and the currency decides what they may price
    // tickets in (#84).
    const defaultCurrency = account.default_currency ?? undefined;
    if (complete !== record.onboardingComplete || defaultCurrency !== record.defaultCurrency) {
      setStripeAccount(organiserAddress, record.stripeAccountId, complete, defaultCurrency);
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
      // Drives the pricing-currency picker (#84). Absent while Stripe has not
      // assigned one yet — the client must then offer every currency, not none.
      defaultCurrency,
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
      // Stripe is unreachable, so serve the cached value rather than none: an
      // outage must not silently widen the currency picker back open.
      defaultCurrency: record.defaultCurrency,
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

/**
 * GET /api/stripe/payouts — the organiser's own held and released takings.
 *
 * Organisers are on a manual payout schedule, so "where is my money" has to be
 * answerable in the product rather than by asking us. Our terms commit to telling
 * them when funds release; this is the endpoint that backs that promise.
 *
 * Amounts are minor units, as Stripe reports them.
 */
stripe.get("/payouts", requireAuth, async (c) => {
  const organiserAddress = c.get("parentAddress").toLowerCase();
  try {
    const data: PayoutsResponse = buildPayoutsResponse(listPayoutsByOrganiser(organiserAddress));
    return c.json({ ok: true, data });
  } catch (err) {
    // A thrown route hands Hono's plain-text 500 to a client that is parsing
    // JSON — the payouts screen would show "unexpected token" where it should
    // say "we couldn't load this, try again".
    console.error("[stripe] Failed to build payouts response:", err);
    return c.json({ ok: false, error: "Could not read your payouts right now" }, 500);
  }
});

/**
 * POST /api/stripe/account-session — a client secret for Connect embedded components.
 *
 * The organiser's only route to their own bank details and account status.
 * This REPLACED `POST /dashboard-link`: under Managed Risk with
 * `stripe_dashboard.type = "none"` there is no Express Dashboard, and
 * `accounts.createLoginLink` returns "does not have access to the Express
 * Dashboard" — so the login-link door is not deprecated, it is closed.
 *
 * The client secret is single-use and expires in minutes, and connect.js calls
 * this again whenever it needs a fresh one. So it is minted per request and
 * never stored, logged or emailed — it is a bearer credential for the
 * organiser's Stripe account.
 *
 * The account id comes from the caller's VERIFIED parentAddress — never the
 * request body — so an organiser can only ever open their own account.
 */
// Friction, not accounting: every call mints a Stripe API call, and the shared
// platform API quota shouldn't be spendable by one stuck client loop. Higher
// than the login link it replaces because connect.js re-fetches on its own
// schedule (secret expiry, component remount) rather than only on a click.
const accountSessionRate = new RateWindow(30, 5 * 60 * 1000);

stripe.post("/account-session", requireAuth, async (c) => {
  const organiserAddress = c.get("parentAddress").toLowerCase();
  if (accountSessionRate.isLimited(organiserAddress)) {
    return c.json({ ok: false, error: "Too many attempts — try again in a few minutes." }, 429);
  }
  accountSessionRate.record(organiserAddress);
  const record = getStripeAccount(organiserAddress);
  if (!record) {
    return c.json({ ok: false, error: "No Stripe account found. Connect Stripe first." }, 400);
  }

  // Fail here, with a log an operator can read, rather than handing the browser
  // a key that cannot work with this secret key.
  const keys = resolvePublishableKey(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_PUBLISHABLE_KEY);
  if (!keys.ok) {
    console.error(`[stripe] Cannot serve account sessions: ${keys.reason}`);
    return c.json({ ok: false, error: "Stripe is unavailable right now. Try again shortly." }, 502);
  }

  try {
    const s = getStripe();
    const session = await s.accountSessions.create(buildAccountSessionParams(record.stripeAccountId));
    return c.json({
      ok: true,
      clientSecret: session.client_secret,
      expiresAt: session.expires_at,
      publishableKey: keys.publishableKey,
    });
  } catch (err) {
    console.error("[stripe] Failed to create account session:", err);
    const failure = classifyAccountSessionError(err);
    if (failure.dropRecord) {
      deleteStripeAccount(organiserAddress);
      console.log(`[stripe] Account ${record.stripeAccountId} missing — removed local record`);
    }
    return c.json({ ok: false, error: failure.message }, failure.status);
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
 * Creates a Checkout Session as a direct charge on the organiser's
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

  const { eventId, seriesId, claimerEmail, returnUrl, cancelUrl, quantity: rawQty, orderRef, encryptedOrder, reservationId: rawReservationId, siteId: rawSiteId, podPubKey: rawPodPubKey, marketingConsent: rawMarketingConsent } = body as {
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
    /** Attendee ed25519 POD pubkey (hex, no 0x) — claimed.v2. Only honoured
     *  when the request also carries a verified session (see metadata below). */
    podPubKey?: string;
    /** The checkout opt-in control. `true` = granted, `false` = explicitly
     *  declined, absent = never asked (the order form was not shown). All three
     *  are different: a decline is written to suppression, an absence is not. */
    marketingConsent?: boolean;
  };
  const siteId = typeof rawSiteId === "string" && /^[0-9a-z_-]{10,}$/i.test(rawSiteId) ? rawSiteId : undefined;
  const marketingConsent =
    typeof rawMarketingConsent === "boolean" ? rawMarketingConsent : undefined;
  const podPubKey =
    typeof rawPodPubKey === "string" && /^[0-9a-f]{64}$/i.test(rawPodPubKey)
      ? rawPodPubKey.toLowerCase()
      : undefined;
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
      return c.json({ ok: false, error: authResult.error, code: authResult.code }, 401);
    }
    verifiedAddress = authResult.parentAddress.toLowerCase();
  }

  if (!claimerEmail && !verifiedAddress) {
    return c.json({ ok: false, error: "claimerEmail or authenticated wallet session required" }, 400);
  }

  // Load event + (optionally) upload encrypted order in parallel. Swarm upload
  // is the slowest link (~3–10s cold); running it alongside the event read
  // hides its latency behind work we'd be doing anyway. Availability is read
  // from the contract AFTER the series resolves (it needs onChainEventId).
  const tSwarm = performance.now();
  // When a valid reservation is already held, the seat is locked and the
  // contract re-checks supply at mint anyway — skip the availability read.
  const skipAvailability = !!reservationId;
  // Phase B money path: when claiming from a deployed site, resolve the event's
  // signer from that site's server-written SiteEventsIndex (trusted carrier) so a
  // client-signed, not-WoCo-listed event reads its authentic SOC — this read feeds
  // the Stripe destination (creatorAddress→Connect) + amount. siteId is only a
  // pointer; trust is the server-written index, never the request.
  const siteSigner = siteId ? await resolveSiteEventSigner(siteId, eventId) : null;
  const [event, inlineUploadedRef] = await Promise.all([
    getEvent(eventId, siteSigner ?? undefined),
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

  // Registration gate. Publish is two phases and the second can fail: the event
  // feed is written first, then `registerAndFinalise()` registers the series on
  // chain. In between, the series has no `onChainEventId`. Such an event never
  // reaches the public directory (the snapshot is rebuilt on register-success),
  // but it IS reachable by direct link and from a builder site — and the mint is
  // on-chain only, so there is nothing to allocate against. Refuse rather than
  // charge-then-refund, the same trade the sponsor gate below makes. Fails
  // CLOSED: this is a property of the series, not a transient chain condition.
  // (Re-landed from 59795f1 — premature only while the v1 webhook fallback
  // still existed to absorb these sessions.)
  if (!series.onChainEventId || !series.swarmManifestRef) {
    console.error(
      `[stripe/create-checkout] BLOCKED — series is not registered on chain; refusing to charge ` +
      `(eventId=${eventId.slice(0, 8)} series=${seriesId.slice(0, 8)})`,
    );
    return c.json(
      { ok: false, error: "Tickets for this event are not currently on sale. Please contact the organiser." },
      409,
    );
  }

  // Past-event gate (#241). The "This event has ended" banner is client-side
  // only — a stale tab, deep link, or direct API call otherwise reaches a
  // live Checkout Session for an event that is over, and the mint behind it
  // reverts SalesClosed, i.e. charge-then-auto-refund. Refuse before charging,
  // the same trade as the registration gate above. Fails CLOSED on a feed
  // whose dates don't parse (see lib/event/sales-window.ts).
  const salesWindow = checkSalesWindow(event);
  if (!salesWindow.open) {
    console.warn(
      `[stripe/create-checkout] BLOCKED — sales window ${salesWindow.reason}; refusing to charge ` +
      `(eventId=${eventId.slice(0, 8)} series=${seriesId.slice(0, 8)} ` +
      `end=${event.endDate || event.startDate || "<none>"})`,
    );
    return c.json({ ok: false, error: salesClosedMessage(salesWindow.reason) }, 409);
  }

  // Series sale-window gate (#295). saleStart/saleEnd were documented
  // "(server-enforced)" while nothing read them on any money path, so an
  // imported tier with a lapsed saleEnd stayed purchasable — while the event's
  // own JSON-LD (offers.validFrom/validThrough) told search engines it wasn't.
  const seriesWindow = checkSeriesSaleWindow(series);
  if (!seriesWindow.open) {
    console.warn(
      `[stripe/create-checkout] BLOCKED — series window ${seriesWindow.reason}; refusing to charge ` +
      `(eventId=${eventId.slice(0, 8)} series=${seriesId.slice(0, 8)} ` +
      `saleStart=${series.saleStart || "<none>"} saleEnd=${series.saleEnd || "<none>"})`,
    );
    return c.json({ ok: false, error: seriesSaleMessage(seriesWindow.reason) }, 409);
  }

  // One contract read serves the sold-out pre-check and the firstN tier count.
  // The pre-check fails OPEN on a transport error (the contract re-checks
  // supply at mint and the webhook auto-refund is the backstop); the tier
  // count stays undefined on failure, which computeGatePhase fail-safes to
  // holders-only — never a definite 0 that could hold a window open.
  let onChain: Awaited<ReturnType<typeof getOnChainEvent>> = null;
  if (!skipAvailability || (series.gate && gateNeedsClaimCount(series.gate))) {
    try {
      onChain = await getOnChainEvent(series.onChainEventId, getActiveChainId());
    } catch (err) {
      console.warn("[stripe/create-checkout] availability chain read failed (continuing):", err);
    }
  }
  if (!skipAvailability && onChain
      && Number(onChain.totalSupply) - Number(onChain.nextSlot) < quantity) {
    return c.json({ ok: false, error: "Sold out" }, 409);
  }

  // POD-holdings gate on the CARD rail. The gate is a property of the buyer's
  // ACCOUNT (the verified wallet's on-chain holdings), NOT the payment method —
  // so a gated series is still payable by card, provided the authenticated
  // account passes the gate. We bind the resulting claim to `verifiedAddress`
  // (stamped into metadata.claimerAddress → the webhook claims to that wallet),
  // keeping "server uses the VERIFIED holder address only". Enforce BEFORE any
  // Stripe session is created so a gated-out buyer is never charged.
  if (series.gate) {
    const tierClaimed =
      gateNeedsClaimCount(series.gate) && onChain ? Number(onChain.nextSlot) : undefined;
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

  const { chargeAmount, totalApplicationFee } = computeCardFees(series.payment, priceFloat, quantity);

  // Find the organiser's connected account
  const organiserRecord = getStripeAccount(event.creatorAddress.toLowerCase());
  if (!organiserRecord?.onboardingComplete) {
    return c.json({ ok: false, error: "Event organiser has not completed Stripe onboarding" }, 400);
  }

  // Sponsor-readiness gate. The webhook mints via the sponsor wallet's
  // `batchClaimFor`, which reverts `NotAuthorised` if the sponsor isn't on the
  // contract allow-list — that would charge the buyer then auto-refund. Refuse
  // the checkout up front instead. Fail-OPEN on an RPC error (transient) since
  // the webhook's auto-refund remains the backstop; only a definitive "not
  // authorised" blocks the sale.
  {
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

  // #300: the session must not outlive the event it sells for. Undefined keeps
  // Stripe's 24 h default (event end is 24 h+ away, so the default is tighter).
  const expiresAt = checkoutExpiresAt(event);

  try {
    const s = getStripe();
    const tStripe = performance.now();
    // Direct charge on the connected account: Stripe Checkout shows the
    // organiser's business name (set during Express onboarding) rather than
    // the platform name. The platform still collects application_fee_amount.
    const session = await s.checkout.sessions.create(
      {
        mode: "payment",
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
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
          // claimed.v2: attendee POD pubkey riding with a verified session —
          // the webhook stamps it as owner-of-record + gate-binds at claim.
          ...(verifiedAddress && podPubKey ? { podPubKey } : {}),
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
          // The buyer's answer to the marketing opt-in, carried to the webhook —
          // it is the webhook, not this request, that knows the claim succeeded,
          // and a consent record for a sale that never completed is worthless.
          // Tri-state: "1" granted, "0" declined, absent means never asked.
          ...(marketingConsent !== undefined
            ? { marketingConsent: marketingConsent ? "1" : "0" }
            : {}),
        },
        success_url: stripeSuccessUrl,
        cancel_url: stripeCancelUrl,
        // Prefills the email field at checkout. Side effect: on a direct charge
        // the connected account may also send Stripe's own payment receipt to
        // this address, so the buyer can receive two emails — Stripe's receipt
        // plus our ticket email. Receipts are the ORGANISER's dashboard setting
        // (Settings → Business → Customer emails), not ours to suppress per
        // session, so this is documented for organisers rather than fixed here.
        // Removing customer_email would cost the prefill and not stop receipts.
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
      // Stripe assigns default_currency during onboarding and can change it if
      // the organiser changes their payout bank account. Keeping the cache fresh
      // here is what stops #84's restriction going stale against reality.
      if (account.default_currency) setDefaultCurrency(account.id, account.default_currency);
      console.log(`[stripe-webhook] Account ${account.id} updated: charges=${account.charges_enabled}, payouts=${account.payouts_enabled}`);

      // Self-healing backfill for accounts created before manual payouts existed,
      // and for any account whose schedule drifted back to automatic. The webhook
      // payload already carries settings, so the check costs no API call and only
      // the correction does. Without this, an older organiser's funds are paid out
      // on Stripe's fast schedule and never held for their event.
      if (account.settings?.payouts?.schedule?.interval !== "manual") {
        console.warn(
          `[stripe-webhook] Account ${account.id} is NOT on a manual payout schedule — correcting`,
        );
        void ensureManualPayoutSchedule(account.id);
      }

      // Stripe can raise new requirements long after onboarding, and the
      // organiser's payouts stop the moment it does. They have no reason to
      // open a Stripe UI unprompted, so we chase them — deduplicated, and
      // recorded so a stuck account is visible rather than merely emailed.
      void handleRequirementNudge(account, getFrontendUrl(c)).catch((err) => {
        // Never fail the webhook for an email: Stripe would retry the whole
        // event, re-running the payout-schedule correction above.
        console.error("[stripe-webhook] Requirement nudge failed:", err);
      });
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
 * Decide whether this `account.updated` deserves an email, send it, and record
 * the outcome.
 *
 * The decision is deliberately somewhere else and pure (requirement-nudge.ts);
 * this only performs it. The state is written even when nothing is sent — that
 * record is what makes "who has been blocked, and for how long" answerable.
 */
async function handleRequirementNudge(
  account: import("stripe").Stripe.Account,
  frontendUrl: string,
): Promise<void> {
  const decision = decideRequirementNudge(account, getNudgeState(account.id), new Date());

  if (decision.send && account.email) {
    await sendRequirementNudge({
      to: account.email,
      due: decision.due,
      disabledReason: decision.disabledReason,
      payoutsUrl: `${frontendUrl}/#/creator/payouts`,
    });
    console.log(
      `[stripe-nudge] Emailed ${account.id} (${decision.reason}): ${decision.due.length} outstanding`,
    );
  } else if (decision.reason === "no-email") {
    // Unreachable by email and blocked by Stripe — the worst combination, and
    // the one case that needs a human.
    console.warn(
      `[stripe-nudge] Account ${account.id} has ${decision.due.length} outstanding requirements and NO email on file`,
    );
  }

  // Written last: a failed send must not record a nudge that never went out,
  // or the cooldown would suppress the retry.
  setNudgeState(account.id, decision.nextState);
}

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

  // Shop takings need their own release rule. Merchants share ONE connected-account
  // balance with their ticketing, and the manual schedule that holds ticket money
  // until an event freezes shop money too — which would be wrong, since shop goods
  // are delivered immediately and have no event to wait for. Without an entry here
  // a merchant's shop revenue would never be released at all.
  const shopAccountId = session.metadata?.connectedAccountId;
  if (shopAccountId && session.amount_total && session.currency) {
    const recordedAt = new Date().toISOString();
    // The accounts map is keyed by Stripe account id and can miss — a merchant
    // whose record was rebuilt, or an account connected outside the normal
    // onboarding path. The event path already falls back to the event's creator;
    // the shop path had no fallback and recorded "". The entry still RELEASED
    // correctly (the sweep is keyed by Stripe account, not by us), but it was
    // invisible in GET /api/stripe/payouts, which is keyed by organiser — so the
    // merchant could not see their own money.
    // Strictly best-effort: this is a reporting nicety, and a Swarm read that
    // throws here must never stop the entry being recorded. An unrecorded sale
    // is money in a frozen balance with nothing scheduled to release it.
    let shopOwner: string | undefined;
    try {
      shopOwner = (await getShop(shopId))?.ownerAddress?.toLowerCase();
    } catch (err) {
      console.warn("[stripe-webhook] Could not read shop owner for payout attribution:", err);
    }

    try {
      recordHeldPayout({
        sessionId: session.id,
        stripeAccountId: shopAccountId,
        organiserAddress: getOrganiserByStripeAccount(shopAccountId) ?? shopOwner ?? "",
        kind: "shop",
        shopId,
        orderId,
        currency: session.currency,
        grossAmount: session.amount_total,
        paymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id,
        recordedAt,
        releaseAfter: shopReleaseAfter(recordedAt),
      });
    } catch (err) {
      console.error("[stripe-webhook] FAILED to record shop payout ledger entry:", err);
    }
  }

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
  const { eventId, seriesId, claimerEmail, claimerAddress, quantity: qtyStr, orderRef: metaOrderRef, reservationId: metaReservationId, siteId: metaSiteId, podPubKey: metaPodPubKey, marketingConsent: metaConsent } = session.metadata ?? {};

  // Tri-state, and the absent case is NOT a decline: it means the order form was
  // never shown, so the buyer was never asked and nothing should be recorded.
  const metaMarketingConsent =
    metaConsent === "1" ? true : metaConsent === "0" ? false : undefined;

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

  // claimed.v2: buyer was signed in at checkout (claimerAddress is server-
  // vouched — written only from a verified session). Applied to the FIRST
  // ticket of the order only: the buyer needs exactly one edition for their
  // own unlock; the rest stay bearer so group-buy forwarding keeps working.
  const accountClaim = claimerAddress
    ? {
        parentAddress: claimerAddress.toLowerCase(),
        podPubKey:
          typeof metaPodPubKey === "string" && /^[0-9a-f]{64}$/i.test(metaPodPubKey)
            ? metaPodPubKey.toLowerCase()
            : undefined,
      }
    : undefined;

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
  /** Event END — anchors when these takings may be paid out (payout-policy.ts). */
  let eventEndDate = "";
  /** True only when the event feed was definitively read — the #300 sales
   *  re-check below must fail OPEN on a feed hiccup, never refund over one. */
  let eventLoaded = false;
  /** Fallback organiser identity for the payout ledger if the account map misses. */
  let eventCreatorAddress = "";
  let eventLocation = "";
  let seriesName = "";
  let totalSupply = 0;
  let isV2 = false;
  let v2OnChainEventId = "";
  let v2SwarmManifestRef = "";

  try {
    // Phase B: thread the site carrier (from checkout metadata) so the issued
    // ticket's title/date + v2 manifest come from the authentic client-signed SOC.
    const siteSigner = metaSiteId ? await resolveSiteEventSigner(metaSiteId, eventId) : null;
    const ev = await getEvent(eventId, siteSigner ?? undefined);
    if (ev) {
      eventLoaded = true;
      eventTitle = ev.title;
      eventDate = ev.startDate;
      eventEndDate = ev.endDate ?? "";
      eventCreatorAddress = (ev.creatorAddress ?? "").toLowerCase();
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

  // Register the sale as HELD organiser funds. The connected account is on a
  // manual payout schedule, so nothing reaches the organiser until the release
  // sweep decides it may (event end + grace, or Stripe's hold ceiling).
  //
  // Recorded BEFORE claiming, not after: if the claim fails and we refund below,
  // the entry is voided — whereas a sale we never recorded is money sitting in a
  // frozen balance with nothing scheduled to ever release it.
  const payoutAccountId = session.metadata?.connectedAccountId;
  if (payoutAccountId && session.amount_total && session.currency) {
    try {
      recordHeldPayout({
        sessionId: session.id,
        stripeAccountId: payoutAccountId,
        organiserAddress:
          getOrganiserByStripeAccount(payoutAccountId) ?? eventCreatorAddress ?? "",
        kind: "event",
        eventId,
        seriesId,
        currency: session.currency,
        grossAmount: session.amount_total,
        paymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id,
        recordedAt: claimedAt,
        releaseAfter: eventReleaseAfter(claimedAt, eventEndDate, eventDate),
      });
    } catch (err) {
      // Never fail a paid claim over bookkeeping. A missing entry means funds sit
      // held until the ceiling sweep releases them — recoverable, and loud here.
      console.error("[stripe-webhook] FAILED to record payout ledger entry:", err);
    }
  } else if (session.amount_total) {
    console.error(
      `[stripe-webhook] Paid session ${session.id} has no connectedAccountId in metadata — ` +
        `funds are held with no release schedule. Manual payout required.`,
    );
  }

  const claimedResults: Array<{ edition: number; qrContent: string }> = [];
  let stoppedReason: string | null = null;

  // #300 rider: a payment can complete after the event's end — inside the
  // expires_at floor window, or on a session created before the clamp shipped.
  // The mint would revert SalesClosed at eventEndTs, i.e. the sponsor pays gas
  // for a doomed tx before the same refund runs. Re-check the window here and
  // go straight to the refund; the CONTRACT stays the authority — this only
  // skips a broadcast the chain would refuse. Fails OPEN unless the event feed
  // was definitively read, and only on a definitive "ended" — a feed hiccup or
  // odd dates must never turn a paid mint into a refund.
  if (isV2 && eventLoaded) {
    const windowNow = checkSalesWindow({ startDate: eventDate, endDate: eventEndDate });
    if (!windowNow.open && windowNow.reason === "ended") {
      console.warn(
        `[stripe-webhook] event ended before payment completed — refunding without broadcasting ` +
        `(eventId=${eventId.slice(0, 8)} end=${eventEndDate || eventDate})`,
      );
      stoppedReason = "Event ended before payment completed — sales closed";
    }
  }

  if (stoppedReason) {
    // Sales re-check refused the mint — fall through to the refund + payout
    // void below with zero claims, exactly as a SalesClosed revert would have.
  } else if (isV2) {
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

      // claimed.v2 on the on-chain rail: there is no ClaimedTicket POD to
      // stamp (the contract is the ledger), but the buyer's account still
      // gets its gate binding at purchase — first edition only, same
      // group-buy reasoning as the v1 path.
      if (accountClaim && slotsForBurners.length > 0) {
        const firstEdition = slotsForBurners[0] + 1;
        // `bindTicket` throws when the binding cannot be persisted — correct at
        // /redeem, wrong here. The tickets are already minted and this line sits
        // ABOVE the refund decision and the ticket email, so an escaping throw
        // would leave the buyer charged, the QR contents discarded with
        // `claimedResults`, no email, no refund, and nothing in the
        // undelivered-ticket ledger, because none of that code would run. The
        // binding is an accessory at purchase — the email carries a bind-later
        // path — so it degrades on its own rather than taking fulfilment with it.
        try {
          const bound = bindTicket({
            seriesId,
            edition: firstEdition,
            eventId,
            parentAddress: accountClaim.parentAddress,
            podPubKey: accountClaim.podPubKey,
            paid: true,
            route: "claim",
          });
          if (bound) {
            console.log(`[gate] bound ${seriesId}#${firstEdition} → ${accountClaim.parentAddress} (claim, on-chain)`);
          }
        } catch (err) {
          console.error(
            `[gate] could not bind ${seriesId}#${firstEdition} for ${accountClaim.parentAddress} — ` +
              `fulfilment continues, attendee can bind from the ticket email:`,
            err,
          );
        }
      }
    }
  } else {
    // No fallback rail: the contract is the only ticket ledger, and a series
    // without an on-chain registration has nothing to mint against. Setting
    // `stoppedReason` drives the full auto-refund + payout void below — the
    // same money outcome the deleted v1 path's guaranteed "No tickets
    // available" produced, without pretending to try. create-checkout now
    // refuses these sessions up front; this covers one created before that
    // gate, or a feed/chain disagreement.
    console.error(
      `[stripe-webhook] Paid session for unregistered series ${seriesId} — refunding`,
    );
    stoppedReason = "Series is not registered on chain — no mint path";
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
      // A wholly refunded sale has no proceeds to release, so drop it from the
      // payout schedule now rather than leaving it "held" and misreporting the
      // organiser's pending balance. Partial refunds stay held on purpose: the
      // release job reads the real balance transactions, so the remaining net is
      // computed from Stripe rather than re-derived here.
      if (claimedResults.length === 0) {
        markPayoutVoid(session.id, `refunded — ${stoppedReason}`);
      }
    } catch (refundErr) {
      console.error("[stripe-webhook] Auto-refund FAILED — manual intervention required:", refundErr);
    }
  }

  // Record the checkout marketing decision — only now that a ticket actually
  // landed. An abandoned or refunded-in-full purchase must not leave a marketing
  // permission behind, which is why this lives in the webhook rather than at
  // session creation.
  //
  // Mirrors the free/wallet claim path in routes/claims.ts: a GRANT goes to the
  // consent store as Art. 7(1) evidence, a REFUSAL goes to suppression so it is
  // enforced by the existing send-time check and survives a CSV re-upload.
  // Before this, the checkbox was rendered, ticked, and silently dropped on the
  // paid path — the buyer's answer was lost either way round.
  if (metaMarketingConsent !== undefined && claimedResults.length > 0 && eventCreatorAddress) {
    const consentHash =
      identifier.type === "email" ? identifier.emailHash : identifier.secondaryEmailHash;
    if (consentHash) {
      captureCheckoutConsent({
        emailHash: consentHash,
        organiserAddress: eventCreatorAddress,
        granted: metaMarketingConsent,
        ts: claimedAt,
        eventId,
      });
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
          // Attendee replies reach the organiser instead of a void. Absent for
          // events with no site, or no contact email set on it.
          replyTo: siteTheme?.contactEmail,
          // `to` here IS the verified purchase email (Stripe checkout) — the
          // only path allowed to mint Route A gate tokens. Skipped when a
          // signed-in buyer's single ticket was already bound at claim time;
          // multi-ticket orders keep the per-ticket links for forwarding.
          profileCta: !accountClaim || claimedResults.length > 1,
          // The buyer has paid. If every retry and the failover both fail, this
          // is what makes the undelivered ticket findable — see
          // lib/email/failure-ledger.ts.
          failureContext: {
            stripeSessionId: session.id,
            eventId,
            ...(metaSiteId ? { siteId: metaSiteId } : {}),
          },
        }),
      )
      .catch((err) => {
        // Still non-fatal to the webhook — returning non-2xx to Stripe would
        // make it redeliver and re-run the whole claim path over an email
        // problem. It is no longer SILENT though: sendEmail has already written
        // the failure to .data/email-failures.json, which flips /api/health,
        // so this log line is a breadcrumb rather than the only record.
        console.error("[stripe-webhook] Auto-email failed (recorded in email-failures):", err);
      });
  }
}

export { stripe as stripeRoutes };
