/** Production wiring for the organiser's undelivered-ticket notice (#983). */

import { getFromAddress } from "../email/client.js";
import { sendEmail } from "../email/send.js";
import { onTicketFailure } from "../email/failure-ledger.js";
import { getEvent } from "../event/service.js";
import { organiserSiteTheme } from "./organiser-site.js";
import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { getStripeAccount } from "../stripe/accounts.js";
import { getStripe } from "../stripe/client.js";
import { createUndeliveredNotifier } from "./organiser-notice.js";

const APP_BASE = (process.env.FRONTEND_URL || "https://woco.eth.limo").replace(/\/$/, "");

/** The organiser's Stripe account email, read now and kept nowhere; else their own site's contact. */
async function organiserEmail(eventId: string, siteId: string | undefined): Promise<string | null> {
  const creator = getRecordedFeedSigner(eventId)?.creatorAddress;
  const account = creator ? getStripeAccount(creator) : undefined;
  if (account?.stripeAccountId) {
    try {
      const email = (await getStripe().accounts.retrieve(account.stripeAccountId)).email;
      if (email) return email;
    } catch {
      // Stripe unreachable: the site's contact, if there is one, still hears.
    }
  }
  const theme = siteId ? await organiserSiteTheme(siteId, eventId) : null;
  return theme?.contactEmail ?? null;
}

let started = false;

/** Subscribe once, at boot. */
export function startUndeliveredNotices(): void {
  if (started) return;
  started = true;
  onTicketFailure(
    createUndeliveredNotifier({
      organiserEmail,
      getEventTitle: async (eventId) => (await getEvent(eventId))?.title ?? null,
      send: (msg, context) =>
        sendEmail({ from: getFromAddress(), to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }, { context }),
      dashboardUrl: (eventId) => `${APP_BASE}/#/event/${encodeURIComponent(eventId)}/dashboard`,
      now: () => Date.now(),
    }),
  );
}
