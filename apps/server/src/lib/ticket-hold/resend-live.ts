/**
 * Production wiring for the organiser's undelivered-ticket routes (#983), kept apart
 * from `resend.ts` so its tests import nothing that reads env, disk or the network.
 */

import { hashEmail } from "../event/claim-service.js";
import { getEvent } from "../event/service.js";
import { eventKeys } from "../keyring/event-keys.js";
import { getSale, isSaleVoid, markResendAccepted, recordResend } from "../stripe/ticket-sales.js";
import { resolveTicketFailure, unresolvedTicketFailures } from "../email/failure-ledger.js";
import { cancellationGate } from "../event/cancellations.js";
import { registrationContractFor } from "../event/onchain-registry.js";
import { chainEventEndMsAt } from "../event/end-date-guard.js";
import { isGloballySuppressed, suppressionStoreHealth } from "../marketing/suppression-store.js";
import { getSiteTheme } from "../site/service.js";
import { sendTicketEmail } from "../../routes/tickets.js";
import { replaceDoorEntries } from "../checkin/door-entries.js";
import { recordAttendeeEmail } from "../event/attendee-index.js";
import { getTicketHold } from "./store.js";
import type { ResendDeps } from "./resend.js";

export const liveResendDeps: ResendDeps = {
  eventKeys,
  getSale,
  isSaleVoid,
  unresolvedTicketFailures,
  cancellationGate,
  eventEndMs: async (eventId, seriesId, onChainEventId) => {
    const contract = registrationContractFor(eventId, seriesId);
    return contract ? chainEventEndMsAt(contract, onChainEventId) : null;
  },
  getTicketHold,
  hashEmail,
  isGloballySuppressed,
  suppressionUnreadable: () => suppressionStoreHealth().unreadable,
  getSiteTheme,
  getEvent: (eventId) => getEvent(eventId),
  sendTicketEmail,
  recordResend,
  markResendAccepted,
  resolveTicketFailure,
  replaceDoorEntries,
  recordAttendeeEmail: (eventId, emailHash, at) => {
    recordAttendeeEmail(eventId, emailHash, at);
  },
  now: () => Date.now(),
};
