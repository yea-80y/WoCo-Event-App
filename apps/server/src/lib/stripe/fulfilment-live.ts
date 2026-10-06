/**
 * Production wiring for `fulfilPaidSession` (#314): every `FulfilmentDeps`
 * method bound to the real module. Kept apart from the orchestration so the
 * orchestration file imports nothing that reads env, disk or the network —
 * the test suite imports THAT file with fakes, and this one only from the
 * webhook route.
 *
 * Each adapter keeps the failure contract its interface method promises; see
 * the comments on `FulfilmentDeps` before changing one.
 */

import { getStripe } from "./client.js";
import { hashEmail } from "../event/claim-service.js";
import { getEvent } from "../event/service.js";
import { chainEventEndMsAt } from "../event/end-date-guard.js";
import { lookupOnChainEventId, saleContractFor } from "../event/onchain-registry.js";
import { recordHeld, flagForRecheck } from "./payout-ledger.js";
import { getOrganiserByStripeAccount } from "./accounts.js";
import { storeAttendeePayload, storeHeldOrder } from "../attendee-batch/writer.js";
import { markHeldPaid, releaseHeldOrder } from "../attendee-batch/held-orders.js";
import { getOrderRecord, isOrderErased } from "../attendee-batch/ledger.js";
import { fetchOrderKey } from "@woco/shared";
import { BEE_URL } from "../../config/swarm.js";
import { batchClaimForOnChain, generateBurner, ON_CHAIN_BATCH_MAX } from "../chain/sponsor-wallet.js";
import { bindTicket } from "../gate/store.js";
import { consume as consumeReservation } from "../event/reservation-store.js";
import { captureCheckoutConsent } from "../marketing/consent-capture.js";
import { recordAttendeeEmail } from "../event/attendee-index.js";
import { getSiteTheme, resolveSiteEventSigner } from "../site/service.js";
import { sendTicketEmail } from "../../routes/tickets.js";
import { recordFailure } from "../email/failure-ledger.js";
import { recordPendingRefund } from "./pending-refunds.js";
import { recordAutoRefund, recordSaleSlots, orderRefInOtherSale } from "./ticket-sales.js";
import { addRefundRow, cancellationGate } from "../event/cancellations.js";
import { kickCancellationRefunds } from "./cancellation-refunds.js";
import { liveCancellationRefundDeps } from "./cancellation-refunds-live.js";
import type { FulfilmentDeps } from "./fulfilment.js";

export const liveFulfilmentDeps: FulfilmentDeps = {
  hashEmail,
  resolveSiteEventSigner,
  getEvent,
  chainEventEndMs: (onChainEventId, contract) => chainEventEndMsAt(contract, onChainEventId),
  lookupOnChainEventId,
  saleContractFor,
  recordHeldPayout: (entry) => {
    recordHeld(entry);
  },
  flagPayoutRecheck: (sessionId) => {
    flagForRecheck(sessionId);
  },
  getOrganiserByStripeAccount,
  storeOrderBlob: (data, meta) => storeAttendeePayload(data, { kind: "fallback", ...meta }),
  claimHeldOrder: (ref, sessionId) => markHeldPaid(ref, sessionId),
  storeHeldOrder: (ref) => storeHeldOrder(ref),
  releaseHeldOrder: (ref) => releaseHeldOrder(ref),
  isOrderStored: (ref) => !!getOrderRecord(ref) && !isOrderErased(ref),
  fetchOrderKey: (ref) => fetchOrderKey(ref, BEE_URL),
  orderRefInOtherSale,
  generateBurner,
  batchClaimForOnChain,
  onChainBatchMax: ON_CHAIN_BATCH_MAX,
  recordSaleSlots: (sessionId, onChainEventId, contract, slots, orderRef) => {
    recordSaleSlots(sessionId, onChainEventId, contract, slots, orderRef);
  },
  recordAutoRefund,
  bindTicket,
  consumeReservation,
  cancellationGate,
  enqueueCancellationRefund: ({ eventId, sessionId, paymentIntentId, account }) => {
    if (!addRefundRow(eventId, { sessionId, paymentIntentId, account })) {
      throw new Error(`event ${eventId} has no cancellation record`);
    }
    void kickCancellationRefunds(liveCancellationRefundDeps).catch(() => undefined);
  },
  createRefund: async (params, connectedAccountId, idempotencyKey) => {
    // Direct-charge sessions: the refund must go through the connected account.
    const refund = await getStripe().refunds.create(params, {
      ...(connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
      idempotencyKey,
    });
    return { id: refund.id };
  },
  recordPendingRefund: (input) => {
    recordPendingRefund(input);
  },
  captureCheckoutConsent,
  recordAttendeeEmail,
  getSiteTheme,
  sendTicketEmail,
  recordUndeliveredTicket: ({ to, subject, error, context }) => {
    // The mailer never saw this message (render/config failure), so nothing
    // else will write it. `attempts: 0` says exactly that to the ops view, and
    // `retryable: false` keeps it out of the drain worker, which has no message
    // body to re-send — an operator re-issues from the session id in `context`.
    recordFailure({
      kind: "transactional",
      recipients: [to],
      recipientHashes: [hashEmail(to)],
      subject,
      provider: "none",
      error,
      attempts: 0,
      retryable: false,
      context,
    });
  },
};
