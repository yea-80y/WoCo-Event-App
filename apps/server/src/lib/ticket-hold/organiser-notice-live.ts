/** Production wiring for the organiser's undelivered-ticket notice (#983). */

import { getFromAddress } from "../email/client.js";
import { sendEmail } from "../email/send.js";
import { onTicketFailure } from "../email/failure-ledger.js";
import { getEvent } from "../event/service.js";
import { getSiteTheme } from "../site/service.js";
import { createUndeliveredNotifier } from "./organiser-notice.js";

const APP_BASE = (process.env.FRONTEND_URL || "https://woco.eth.limo").replace(/\/$/, "");

let started = false;

/** Subscribe once, at boot. */
export function startUndeliveredNotices(): void {
  if (started) return;
  started = true;
  onTicketFailure(
    createUndeliveredNotifier({
      getSiteTheme,
      getEventTitle: async (eventId) => (await getEvent(eventId))?.title ?? null,
      send: (msg, context) =>
        sendEmail({ from: getFromAddress(), to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }, { context }),
      dashboardUrl: (eventId) => `${APP_BASE}/#/event/${encodeURIComponent(eventId)}/dashboard`,
      now: () => Date.now(),
    }),
  );
}
