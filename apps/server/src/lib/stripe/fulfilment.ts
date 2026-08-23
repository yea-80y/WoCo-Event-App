/**
 * Paid-session fulfilment — the code that turns a paid Stripe Checkout Session
 * into tickets (#314).
 *
 * This is a money path. The webhook has already told Stripe 200 and consumed
 * the session id before this runs, so nothing here is ever retried by Stripe:
 * whatever this function does not do, nobody does. The invariant it exists to
 * keep, and that `test/fulfilment.test.ts` drives with fakes for every step:
 *
 *   For any single collaborator that throws, the sale still ends in exactly
 *   one of — every ticket emailed, or the unfilled part refunded, or a row in
 *   the undelivered-ticket ledger (email-failures.json). Never silence.
 *
 * Everything this needs from Stripe, the chain, Swarm, the stores and the
 * mailer arrives through `FulfilmentDeps` (the `PayoutGateway` pattern from
 * payout-release.ts), so the ordering can be asserted rather than read off a
 * 400-line function inside a route file. The live wiring is
 * `fulfilment-live.ts`; the orchestration here imports nothing that touches
 * env, disk or network.
 *
 * Step order is load-bearing and the reason each step is fenced the way it is
 * sits on the step. The short version: everything BEFORE the refund decision
 * is fenced so that a throw becomes a `stoppedReason` (which drives the refund)
 * or is swallowed as an accessory; everything AFTER it is fenced so that the
 * email still goes out; and the email step itself guarantees a ledger row when
 * it cannot deliver.
 */

import type { Stripe } from "stripe";
import {
  sealJson,
  buildTicketCanonicalMessage,
  type EventFeed,
  type SealedBox,
  type SeriesManifestBlob,
  type SitePalette,
} from "@woco/shared";
import { checkSalesWindow } from "../event/sales-window.js";
import { eventReleaseAfter } from "./payout-policy.js";
import type { PayoutLedgerEntry } from "./payout-ledger.js";
import type { GateBinding } from "../gate/store.js";
import type { CaptureConsentInput } from "../marketing/consent-capture.js";
import type { TicketEmailOpts } from "../../routes/tickets.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The slice of a Checkout Session fulfilment reads. A structural subset so a
 * test can build one without the 200-field Stripe type; the real
 * `Stripe.Checkout.Session` is assignable to it.
 */
export interface FulfilmentSession {
  id: string;
  metadata: Record<string, string> | null;
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | { id: string } | null;
  customer_details?: { name?: string | null } | null;
}

/** A freshly generated bearer key for one ticket. Only the address is persisted. */
export interface Burner {
  address: string;
  signMessage(message: string): Promise<string>;
}

/**
 * Everything fulfilment needs from the outside world, behind an interface so
 * the ordering invariant can be tested without Stripe, a chain RPC, a bee or
 * the `.data` stores. Each method's failure contract is on the method; the
 * orchestration relies on those contracts, so keep them true in the live
 * wiring.
 */
export interface FulfilmentDeps {
  /** HMAC of a buyer email — the privacy-safe identifier everything stores. */
  hashEmail(email: string): string;

  /** Trusted content-feed signer for an event carried by a site (Phase B). */
  resolveSiteEventSigner(siteId: string, eventId: string): Promise<string | null>;
  getEvent(eventId: string, signerHint?: string): Promise<EventFeed | null>;

  /** `null` = "could not determine" (transport); the caller fails OPEN. */
  chainEventEndMs(onChainEventId: string): Promise<number | null>;

  /** Payout ledger — must not throw (a failed write is a health alarm, not a claim failure). */
  recordHeldPayout(entry: Omit<PayoutLedgerEntry, "status" | "recordedAt"> & { recordedAt?: string }): void;
  markPayoutVoid(sessionId: string, reason: string): void;
  getOrganiserByStripeAccount(stripeAccountId: string): string | undefined;

  /** Swarm /bytes. Both may throw — the caller decides what each failure means. */
  uploadToBytes(data: string): Promise<string>;
  downloadFromBytes(ref: string): Promise<string>;

  /** Chain. `batchClaimForOnChain` rejects on a revert; partial state is never left. */
  generateBurner(): Burner;
  batchClaimForOnChain(onChainEventId: string, burners: string[], orderRefBytes32: string): Promise<number[]>;
  /** Contract batch cap — `ON_CHAIN_BATCH_MAX` in production. */
  onChainBatchMax: number;

  /** Gate binding. THROWS when it cannot persist — fenced here, correct at /redeem. */
  bindTicket(binding: Omit<GateBinding, "boundAt" | "parentAddress"> & { parentAddress: string }): boolean;

  /** Seat hold — `null` when unknown or already consumed. */
  consumeReservation(reservationId: string): { quantity: number } | null;

  /** The refund call. Rejects on any Stripe error; the caller records the outcome. */
  createRefund(
    params: Stripe.RefundCreateParams,
    connectedAccountId: string | undefined,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  /**
   * The refund call threw. Record it durably so the retry job replays it and
   * /api/health alarms until it lands (#367). Must not throw — fenced anyway.
   */
  recordPendingRefund(input: {
    sessionId: string;
    paymentIntentId: string;
    connectedAccountId?: string;
    amount?: number;
    reason: string;
    metadata: Record<string, string>;
    error: string;
  }): void;

  /** Art. 7(1) consent capture — must not throw; fenced anyway. */
  captureCheckoutConsent(input: CaptureConsentInput): void;

  /** Organiser palette for the ticket email. Never rejects in production; fenced anyway. */
  getSiteTheme(siteId: string): Promise<{ palette: SitePalette; contactEmail?: string } | null>;
  /**
   * Deliver the tickets. When this REJECTS with an error carrying
   * `ledgered: true`, the mailer has already written the failure to the
   * undelivered-ticket ledger (that is what `sendEmail` does after its final
   * attempt). Any other rejection means the message never reached the mailer
   * — a render or configuration failure — and fulfilment writes the row itself
   * via `recordUndeliveredTicket`, so a paid-for ticket is never undelivered
   * AND unrecorded.
   */
  sendTicketEmail(opts: TicketEmailOpts): Promise<void>;
  recordUndeliveredTicket(input: {
    to: string;
    subject: string;
    error: string;
    context: Record<string, string>;
  }): void;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type EmailOutcome =
  /** Mailer accepted the message. */
  | "sent"
  /** Mailer rejected it, or it never reached the mailer — either way a
   *  failure-ledger row exists for it. */
  | "failed"
  /** Wallet-only buyer: nothing to send to. The first edition is bound to the
   *  account at mint; there is no email to deliver. */
  | "no-address"
  /** Zero tickets issued — nothing to deliver. */
  | "nothing-issued";

export type RefundOutcome =
  /** Every paid ticket was issued. */
  | { kind: "not-needed" }
  /** Stripe accepted the refund for the unfilled part. */
  | { kind: "created"; refundId: string; amount: number | "full" }
  /** The refund call threw. The buyer is still charged — see #367. */
  | { kind: "failed"; error: string }
  /** Stopped, but the session carries no payment intent to refund against. */
  | { kind: "no-payment-intent" };

export interface FulfilmentOutcome {
  sessionId: string;
  /** `skipped` = not a WoCo ticket sale we can act on; nothing was charged by
   *  us that we could identify, so nothing is refunded either. */
  kind: "skipped" | "processed";
  skipReason?: string;
  quantity: number;
  /** Tickets actually minted and handed to the email step. */
  issued: number;
  /** Why fulfilment stopped short of `quantity`, when it did. */
  stoppedReason: string | null;
  refund: RefundOutcome;
  email: EmailOutcome;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** `sendEmail` marks the error it throws after ledgering. Anything else never got that far. */
function alreadyLedgered(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { ledgered?: unknown }).ledgered === true;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function paymentIntentId(session: FulfilmentSession): string | null {
  if (!session.payment_intent) return null;
  return typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
}

/**
 * Fulfil one paid Checkout Session. Never rejects: every failure is either a
 * refund reason, an accessory that degrades, or a ledgered email failure, and
 * the outcome says which. The caller (the webhook) has nothing to do with a
 * rejection anyway — Stripe has its 200.
 *
 * @param webhookEventCreated Stripe `event.created` (Unix seconds): the payment
 *   time, used as `claimedAt` so the dashboard shows when the buyer paid, not
 *   when we got round to it.
 */
export async function fulfilPaidSession(
  session: FulfilmentSession,
  webhookEventCreated: number,
  deps: FulfilmentDeps,
): Promise<FulfilmentOutcome> {
  const {
    eventId,
    seriesId,
    claimerEmail,
    claimerAddress,
    quantity: qtyStr,
    orderRef: metaOrderRef,
    reservationId: metaReservationId,
    siteId: metaSiteId,
    podPubKey: metaPodPubKey,
    marketingConsent: metaConsent,
    connectedAccountId: metaConnectedAccountId,
  } = session.metadata ?? {};

  const quantity = Math.max(1, Math.min(10, parseInt(qtyStr ?? "1", 10) || 1));
  const skipped = (skipReason: string): FulfilmentOutcome => ({
    sessionId: session.id,
    kind: "skipped",
    skipReason,
    quantity,
    issued: 0,
    stoppedReason: null,
    refund: { kind: "not-needed" },
    email: "nothing-issued",
  });

  // Not a WoCo ticket sale. The connected-accounts webhook delivers EVERY
  // session on every connected account, so a session without our keys is not
  // ours to refund — skipping is the safe answer, refunding would be reaching
  // into an organiser's own sales.
  if (!eventId || !seriesId) {
    console.error("[fulfilment] Missing eventId/seriesId in session metadata");
    return skipped("missing eventId/seriesId");
  }

  // Tri-state, and the absent case is NOT a decline: it means the order form was
  // never shown, so the buyer was never asked and nothing should be recorded.
  const metaMarketingConsent =
    metaConsent === "1" ? true : metaConsent === "0" ? false : undefined;

  const claimedAt = new Date(webhookEventCreated * 1000).toISOString();

  // Identity: wallet (server-vouched address, optional email), or email only.
  if (!claimerAddress && !claimerEmail) {
    console.error("[fulfilment] No claimer identifier in session metadata");
    return skipped("no claimer identifier");
  }
  // The hash only feeds consent capture; it must not be able to stop the mint
  // or the email (fenced — `hashEmail` throws only when the HMAC secret is
  // unset, which index.ts refuses to start without).
  let emailHash: string | undefined;
  if (claimerEmail) {
    try {
      emailHash = deps.hashEmail(claimerEmail);
    } catch (err) {
      console.error("[fulfilment] hashEmail threw — consent capture will be skipped:", err);
    }
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

  // ── 1. Event feed (fenced: a feed hiccup degrades to "no v2 path" → refund) ──
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
    const siteSigner = metaSiteId ? await deps.resolveSiteEventSigner(metaSiteId, eventId) : null;
    const ev = await deps.getEvent(eventId, siteSigner ?? undefined);
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
    console.warn("[fulfilment] Could not build encrypted order (non-fatal):", err);
  }

  // ── 2. Payout ledger (fenced: bookkeeping never fails a paid claim) ──
  // Register the sale as HELD organiser funds. The connected account is on a
  // manual payout schedule, so nothing reaches the organiser until the release
  // sweep decides it may (event end + grace, or Stripe's hold ceiling).
  //
  // Recorded BEFORE claiming, not after: if the claim fails and we refund below,
  // the entry is voided — whereas a sale we never recorded is money sitting in a
  // frozen balance with nothing scheduled to ever release it.
  const payoutAccountId = metaConnectedAccountId;
  if (payoutAccountId && session.amount_total && session.currency) {
    try {
      deps.recordHeldPayout({
        sessionId: session.id,
        stripeAccountId: payoutAccountId,
        organiserAddress:
          deps.getOrganiserByStripeAccount(payoutAccountId) ?? eventCreatorAddress ?? "",
        kind: "event",
        eventId,
        seriesId,
        currency: session.currency,
        grossAmount: session.amount_total,
        paymentIntentId: paymentIntentId(session) ?? undefined,
        recordedAt: claimedAt,
        releaseAfter: eventReleaseAfter(claimedAt, eventEndDate, eventDate),
      });
    } catch (err) {
      // Never fail a paid claim over bookkeeping. A missing entry means funds sit
      // held until the ceiling sweep releases them — recoverable, and loud here.
      console.error("[fulfilment] FAILED to record payout ledger entry:", err);
    }
  } else if (session.amount_total) {
    console.error(
      `[fulfilment] Paid session ${session.id} has no connectedAccountId in metadata — ` +
        `funds are held with no release schedule. Manual payout required.`,
    );
  }

  const claimedResults: Array<{ edition: number; qrContent: string }> = [];
  let stoppedReason: string | null = null;

  // ── 3. Sales-window re-checks (fail OPEN on anything but a definitive "ended") ──
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
        `[fulfilment] event ended before payment completed — refunding without broadcasting ` +
        `(eventId=${eventId.slice(0, 8)} end=${eventEndDate || eventDate})`,
      );
      stoppedReason = "Event ended before payment completed — sales closed";
    }
  }
  // #294: the CHAIN's own end, checked independently of the feed — an endDate
  // extended past the registered eventEndTs (the exact divergence #294 names)
  // keeps the feed check above green while every mint reverts. Memo hit in the
  // common case (create-checkout warmed it); fail-OPEN on a transport error —
  // the contract remains the authority and refuses the mint itself.
  if (isV2 && !stoppedReason) {
    try {
      const chainEndMs = await deps.chainEventEndMs(v2OnChainEventId);
      if (chainEndMs !== null && Date.now() >= chainEndMs) {
        console.warn(
          `[fulfilment] on-chain sales end passed before payment completed — refunding without ` +
          `broadcasting (eventId=${eventId.slice(0, 8)} chainEnd=${new Date(chainEndMs).toISOString()})`,
        );
        stoppedReason = "Event ended before payment completed — sales closed";
      }
    } catch (err) {
      console.warn("[fulfilment] chain-end read failed (continuing to mint):", err);
    }
  }

  // ── 4. Mint (the whole block is fenced: an unexpected throw becomes a
  //       stoppedReason, never an escape past the refund) ──
  if (stoppedReason) {
    // Sales re-check refused the mint — fall through to the refund + payout
    // void below with zero claims, exactly as a SalesClosed revert would have.
  } else if (isV2) {
    try {
      await mintV2({
        deps,
        eventId,
        seriesId,
        quantity,
        v2OnChainEventId,
        v2SwarmManifestRef,
        prefetchedOrderRef,
        encryptedOrder,
        accountClaim,
        claimedResults,
        setStopped: (reason) => {
          stoppedReason = reason;
        },
      });
    } catch (err) {
      // Nothing inside mintV2 is meant to reach here — every known failure sets
      // stoppedReason and returns. This is the fence for the unknown one: a
      // throw between the mint and the QR build. Whatever was minted is in
      // claimedResults already and will be emailed; the rest is refunded.
      // Slots minted but not signed are lost to the organiser's supply — said
      // loudly, because it is the one outcome no refund repairs.
      const msg = errMessage(err);
      console.error(
        `[fulfilment] unexpected throw during mint (issued=${claimedResults.length}/${quantity}) — ` +
          `refunding the remainder:`,
        err,
      );
      stoppedReason = `Fulfilment failed: ${msg}`;
    }
  } else {
    // No fallback rail: the contract is the only ticket ledger, and a series
    // without an on-chain registration has nothing to mint against. Setting
    // `stoppedReason` drives the full auto-refund + payout void below — the
    // same money outcome the deleted v1 path's guaranteed "No tickets
    // available" produced, without pretending to try. create-checkout now
    // refuses these sessions up front; this covers one created before that
    // gate, or a feed/chain disagreement.
    console.error(`[fulfilment] Paid session for unregistered series ${seriesId} — refunding`);
    stoppedReason = "Series is not registered on chain — no mint path";
  }

  // ── 5. Release the seat hold (fenced: a store hiccup must not block the refund) ──
  // Now release the seat hold — all claims that were going to land have
  // landed. Doing this here (vs. at webhook entry) means concurrent /reserve
  // calls saw the correct held count throughout the slow mint phase.
  if (metaReservationId) {
    try {
      const consumed = deps.consumeReservation(metaReservationId);
      if (consumed) {
        console.log(
          `[fulfilment] Consumed reservation ${metaReservationId} (qty=${consumed.quantity}, claimed=${claimedResults.length})`,
        );
      }
    } catch (err) {
      console.error("[fulfilment] consumeReservation threw (continuing):", err);
    }
  }

  // ── 6. Refund the unfilled part ──
  // Partial-refund logic: if some tickets claimed but the batch couldn't
  // finish (oversold mid-flight, etc.), refund only the unfilled portion
  // pro-rata against amount_total. Refunding the whole intent here would
  // claw back £176 from a buyer who already received 7 of 8 emailed tickets.
  // If ZERO tickets claimed, refund the whole intent as before.
  const unfilled = quantity - claimedResults.length;
  let refund: RefundOutcome = { kind: "not-needed" };
  const piId = paymentIntentId(session);
  if (stoppedReason && unfilled > 0) {
    if (!piId) {
      refund = { kind: "no-payment-intent" };
      console.error(`[fulfilment] stopped (${stoppedReason}) but session ${session.id} has no payment intent to refund`);
    } else {
      // Direct-charge sessions: refund must go through the connected account.
      // connectedAccountId is stamped into metadata at checkout-session creation.
      const connectedAccountId = metaConnectedAccountId || undefined;
      const amountTotal = session.amount_total ?? 0;
      // Pro-rata the total (which already includes any buyer-paid fee) by
      // unit. Round so we never refund more than was paid.
      const refundAmount =
        amountTotal > 0 && quantity > 0
          ? Math.min(amountTotal, Math.round((amountTotal / quantity) * unfilled))
          : 0;
      const refundMetadata: Record<string, string> = {
        reason: "ticket-claim-failed",
        failureMessage: stoppedReason.slice(0, 200),
        // The retry job (#367) recognises a refund that landed while the
        // response was lost by this marker — never re-creates one.
        sessionId: session.id,
        seriesId,
        eventId,
        quantityPaid: String(quantity),
        quantityClaimed: String(claimedResults.length),
        quantityUnfilled: String(unfilled),
      };
      const refundParams: Stripe.RefundCreateParams = {
        payment_intent: piId,
        reason: "requested_by_customer",
        // #121. Stripe does NOT refund the application fee by default — the
        // connected account (the organiser, merchant of record on a direct
        // charge) eats it. Every refund on this path is caused by OUR side —
        // a mint that reverted, a feed or chain we could not read, a sale we
        // closed — so the platform fee goes back with it: in full on a full
        // refund, pro-rata on a partial (Stripe's semantics). Stripe's own
        // processing fee is not returnable by anyone; ORGANISER_TERMS §6
        // says so. A buyer-requested refund is a different policy and does
        // not come through here.
        refund_application_fee: true,
        metadata: refundMetadata,
      };
      // Only set `amount` for partial refunds. When claimedResults.length === 0
      // we omit it so Stripe refunds the full intent — same as the old behaviour.
      if (claimedResults.length > 0 && refundAmount > 0) {
        refundParams.amount = refundAmount;
      }
      try {
        // Idempotent at Stripe for 24h: a retry after a lost response returns
        // the original refund instead of minting a second (partial) one.
        const created = await deps.createRefund(refundParams, connectedAccountId, `woco-autorefund-${session.id}`);
        refund = { kind: "created", refundId: created.id, amount: refundParams.amount ?? "full" };
        console.log(
          `[fulfilment] Auto-refunded ${piId} (refund=${created.id}, amount=${refundParams.amount ?? "full"}, unfilled=${unfilled}/${quantity}) — ${stoppedReason}`,
        );
        // A wholly refunded sale has no proceeds to release, so drop it from the
        // payout schedule now rather than leaving it "held" and misreporting the
        // organiser's pending balance. Partial refunds stay held on purpose: the
        // release job reads the real balance transactions, so the remaining net is
        // computed from Stripe rather than re-derived here.
        if (claimedResults.length === 0) {
          try {
            deps.markPayoutVoid(session.id, `refunded — ${stoppedReason}`);
          } catch (err) {
            console.error("[fulfilment] markPayoutVoid threw after a successful refund:", err);
          }
        }
      } catch (refundErr) {
        const error = errMessage(refundErr);
        refund = { kind: "failed", error };
        console.error("[fulfilment] Auto-refund FAILED — recording for retry:", refundErr);
        // The one branch of the invariant that had no ledger (#367). The retry
        // job replays exactly these params; /api/health alarms until it lands.
        try {
          deps.recordPendingRefund({
            sessionId: session.id,
            paymentIntentId: piId,
            connectedAccountId,
            ...(refundParams.amount !== undefined ? { amount: refundParams.amount } : {}),
            reason: stoppedReason,
            metadata: refundMetadata,
            error,
          });
        } catch (recordErr) {
          console.error("[fulfilment] could not record the pending refund either — INVARIANT BROKEN:", recordErr);
        }
      }
    }
  }

  // ── 7. Consent (fenced: a store problem must not cost the email) ──
  // Record the checkout marketing decision — only now that a ticket actually
  // landed. An abandoned or refunded-in-full purchase must not leave a marketing
  // permission behind, which is why this lives in the webhook rather than at
  // session creation. A GRANT goes to the consent store as Art. 7(1) evidence,
  // a REFUSAL goes to suppression so it is enforced by the existing send-time
  // check and survives a CSV re-upload.
  if (metaMarketingConsent !== undefined && claimedResults.length > 0 && eventCreatorAddress && emailHash) {
    try {
      deps.captureCheckoutConsent({
        emailHash,
        organiserAddress: eventCreatorAddress,
        granted: metaMarketingConsent,
        ts: claimedAt,
        eventId,
      });
    } catch (err) {
      console.error("[fulfilment] consent capture threw (continuing to email):", err);
    }
  }

  // ── 8. Deliver ──
  let email: EmailOutcome;
  if (claimedResults.length === 0) {
    email = "nothing-issued";
  } else if (!claimerEmail) {
    email = "no-address";
  } else {
    // Stripe gives us the buyer's name from `customer_details` (filled by the
    // user at checkout when card billing is collected). Pass it through so it
    // can be baked into the composite ticket-card PNG and shown on the page.
    const buyerName = session.customer_details?.name?.trim() || undefined;
    let siteTheme: { palette: SitePalette; contactEmail?: string } | null = null;
    if (metaSiteId) {
      try {
        siteTheme = await deps.getSiteTheme(metaSiteId);
      } catch (err) {
        // Palette is cosmetic; the default brand is the correct fallback.
        console.warn("[fulfilment] getSiteTheme threw — sending with default palette:", err);
      }
    }
    const failureContext: Record<string, string> = {
      stripeSessionId: session.id,
      eventId,
      ...(metaSiteId ? { siteId: metaSiteId } : {}),
    };
    // A paid-for ticket with a blank title would still be minted and bound;
    // skipping the email over cosmetics would break the invariant for nothing.
    const title = eventTitle || "Your tickets";
    try {
      await deps.sendTicketEmail({
        to: claimerEmail,
        eventTitle: title,
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
        failureContext,
      });
      email = "sent";
    } catch (err) {
      email = "failed";
      if (alreadyLedgered(err)) {
        // sendEmail wrote the row (and queued a transient retry) before it threw.
        console.error("[fulfilment] ticket email failed (recorded in email-failures):", err);
      } else {
        // Never reached the mailer — render, config, anything. Without this the
        // buyer has paid, the tickets exist, and nothing anywhere says they
        // were not delivered. Write the row ourselves; never throw from here.
        console.error("[fulfilment] ticket email never sent — recording in email-failures:", err);
        try {
          deps.recordUndeliveredTicket({
            to: claimerEmail,
            subject: `Your ticket — ${title}`,
            error: `ticket email never sent: ${errMessage(err)}`,
            context: failureContext,
          });
        } catch (ledgerErr) {
          console.error("[fulfilment] could not record the undelivered ticket either:", ledgerErr);
        }
      }
    }
  }

  return {
    sessionId: session.id,
    kind: "processed",
    quantity,
    issued: claimedResults.length,
    stoppedReason,
    refund,
    email,
  };
}

// ---------------------------------------------------------------------------
// v2 mint
// ---------------------------------------------------------------------------

interface MintV2Args {
  deps: FulfilmentDeps;
  eventId: string;
  seriesId: string;
  quantity: number;
  v2OnChainEventId: string;
  v2SwarmManifestRef: string;
  prefetchedOrderRef: string | undefined;
  encryptedOrder: SealedBox | undefined;
  accountClaim: { parentAddress: string; podPubKey: string | undefined } | undefined;
  /** Filled in place: one entry per slot actually minted AND signed. */
  claimedResults: Array<{ edition: number; qrContent: string }>;
  setStopped(reason: string): void;
}

/**
 * The on-chain rail. Every KNOWN failure sets a stop reason and returns — the
 * caller turns that into a refund. Only an unknown throw escapes, and the
 * caller fences that too.
 */
async function mintV2(a: MintV2Args): Promise<void> {
  const { deps, eventId, seriesId, quantity, claimedResults } = a;

  // Resolve the orderRef once for the whole batch (all tickets share one
  // encrypted order blob — same buyer, same form submission).
  let batchOrderRef: string | undefined = a.prefetchedOrderRef;
  if (!batchOrderRef && a.encryptedOrder) {
    try {
      batchOrderRef = await deps.uploadToBytes(JSON.stringify(a.encryptedOrder));
      console.log(`[fulfilment/v2] Fallback order uploaded: ${batchOrderRef}`);
    } catch (err) {
      console.warn("[fulfilment/v2] Fallback order upload failed:", err);
    }
  }

  // Fetch the manifest blob once; all slots for this series share it.
  let manifestBlob: SeriesManifestBlob | null = null;
  try {
    const raw = await deps.downloadFromBytes(a.v2SwarmManifestRef);
    manifestBlob = JSON.parse(raw) as SeriesManifestBlob;
  } catch (err) {
    console.error("[fulfilment/v2] Failed to fetch manifest blob:", err);
    a.setStopped("Manifest not found");
    return;
  }

  if (!batchOrderRef) {
    a.setStopped("No orderRef available for on-chain claim");
    return;
  }
  if (!manifestBlob) {
    a.setStopped("Manifest not available");
    return;
  }

  const orderRefBytes32 = "0x" + batchOrderRef;

  // Generate ALL burners up front. Keys live in memory only for as long
  // as it takes to sign their canonical message; the array is discarded
  // when this scope exits. Nothing about the burner is persisted apart
  // from its address (recorded on-chain as slotOwner).
  const burners = Array.from({ length: quantity }, () => deps.generateBurner());

  // Chunk into on-chain batches of onChainBatchMax (=100 live). For
  // quantity ≤ 100 this is one tx. Each chunk is all-or-nothing on-chain
  // (the contract reverts if the batch would exceed supply); the caller's
  // partial-refund logic handles cross-chunk partial failure (chunk 1
  // succeeds, chunk 2 fails on supply exhaustion).
  const slotsForBurners: number[] = [];
  let stopped = false;
  for (let chunkStart = 0; chunkStart < burners.length && !stopped; chunkStart += deps.onChainBatchMax) {
    const chunk = burners.slice(chunkStart, chunkStart + deps.onChainBatchMax);
    const chunkAddresses = chunk.map((w) => w.address);
    try {
      const chunkSlots = await deps.batchClaimForOnChain(a.v2OnChainEventId, chunkAddresses, orderRefBytes32);
      slotsForBurners.push(...chunkSlots);
      console.log(
        `[fulfilment/v2] batchClaimFor chunk ${chunkStart}..${chunkStart + chunk.length} ` +
        `→ slots=${chunkSlots[0]}..${chunkSlots[chunkSlots.length - 1]}`,
      );
    } catch (err) {
      const msg = errMessage(err);
      console.error(`[fulfilment/v2] batchClaimFor failed at chunk ${chunkStart}:`, msg);
      // Insufficient supply / Sold out / Event not found are all unrecoverable.
      // Any tx-level revert means this chunk's state changes were rolled back —
      // we keep whatever slotsForBurners has from prior chunks and refund the rest.
      a.setStopped(msg);
      stopped = true;
    }
  }

  // Sign + build QR for every slot we actually got. Signing is purely
  // local crypto; ~0.2ms per sig, no chain round-trip.
  for (let i = 0; i < slotsForBurners.length; i++) {
    const slot = slotsForBurners[i];
    const edition = slot + 1;
    const canonical = buildTicketCanonicalMessage({
      onChainEventId: a.v2OnChainEventId,
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
  // group-buy reasoning as before.
  if (a.accountClaim && slotsForBurners.length > 0) {
    const firstEdition = slotsForBurners[0] + 1;
    // `bindTicket` throws when the binding cannot be persisted — correct at
    // /redeem, wrong here. The tickets are already minted and this sits ABOVE
    // the refund decision and the ticket email, so an escaping throw would
    // leave the buyer charged, the QR contents discarded, no email, no refund,
    // and nothing in the undelivered-ticket ledger. The binding is an
    // accessory at purchase — the email carries a bind-later path — so it
    // degrades on its own rather than taking fulfilment with it.
    try {
      const bound = deps.bindTicket({
        seriesId,
        edition: firstEdition,
        eventId,
        parentAddress: a.accountClaim.parentAddress,
        podPubKey: a.accountClaim.podPubKey,
        paid: true,
        route: "claim",
      });
      if (bound) {
        console.log(`[gate] bound ${seriesId}#${firstEdition} → ${a.accountClaim.parentAddress} (claim, on-chain)`);
      }
    } catch (err) {
      console.error(
        `[gate] could not bind ${seriesId}#${firstEdition} for ${a.accountClaim.parentAddress} — ` +
          `fulfilment continues, attendee can bind from the ticket email:`,
        err,
      );
    }
  }
}
