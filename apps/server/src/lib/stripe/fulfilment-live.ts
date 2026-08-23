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
import { chainEventEndMs } from "../event/end-date-guard.js";
import { recordHeld, markVoid } from "./payout-ledger.js";
import { getOrganiserByStripeAccount } from "./accounts.js";
import { uploadToBytes, downloadFromBytes } from "../swarm/bytes.js";
import { batchClaimForOnChain, generateBurner, ON_CHAIN_BATCH_MAX } from "../chain/sponsor-wallet.js";
import { bindTicket } from "../gate/store.js";
import { consume as consumeReservation } from "../event/reservation-store.js";
import { captureCheckoutConsent } from "../marketing/consent-capture.js";
import { getSiteTheme, resolveSiteEventSigner } from "../site/service.js";
import { sendTicketEmail } from "../../routes/tickets.js";
import { recordFailure } from "../email/failure-ledger.js";
import { recordPendingRefund } from "./pending-refunds.js";
import type { FulfilmentDeps } from "./fulfilment.js";

export const liveFulfilmentDeps: FulfilmentDeps = {
  hashEmail,
  resolveSiteEventSigner,
  getEvent,
  chainEventEndMs: (onChainEventId) => chainEventEndMs(onChainEventId),
  recordHeldPayout: (entry) => {
    recordHeld(entry);
  },
  markPayoutVoid: markVoid,
  getOrganiserByStripeAccount,
  uploadToBytes: (data) => uploadToBytes(data),
  downloadFromBytes,
  generateBurner,
  batchClaimForOnChain,
  onChainBatchMax: ON_CHAIN_BATCH_MAX,
  bindTicket,
  consumeReservation,
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
