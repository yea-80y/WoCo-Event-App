/**
 * The single place a point-of-collection marketing decision is written.
 *
 * A checkout opt-in has two stores behind it — consent (Art. 7(1) evidence) and
 * suppression (enforcement) — and getting a decision into the right one is not
 * symmetrical: a GRANT must also clear any earlier decline, a REFUSAL must not
 * touch the consent record. Two call sites (`routes/claims.ts` for free/wallet
 * claims, `routes/stripe.ts` for the card webhook) were duplicating half of
 * that, which is how the grant path came to write evidence it never enforced.
 *
 * Keeping it here means the two paths cannot drift again.
 */

import { MARKETING_CONSENT_NOTICE, MARKETING_CONSENT_VERSION } from "@woco/shared";
import { recordConsent, type ConsentSource } from "./consent-store.js";
import { liftDeclineOnConsent, suppressOrg } from "./suppression-store.js";

export interface CaptureConsentInput {
  emailHash: string;
  organiserAddress: string;
  /** The buyer's answer. */
  granted: boolean;
  /** ISO timestamp of the decision — also the ordering evidence for a lift. */
  ts: string;
  eventId?: string;
  source?: ConsentSource;
}

/**
 * Record a checkout marketing decision in whichever store enforces it.
 *
 * Grant → consent record (evidence) + lift any earlier `"declined"` suppression
 * for this organiser, so an affirmative choice actually takes effect. The lift
 * is narrow by construction: `liftDeclineOnConsent` refuses to touch unsubs,
 * bounces, complaints or global marks.
 *
 * Refusal → suppression only. It is deliberately NOT stored as a consent record:
 * "no" needs no new enforcement path, and routing it through suppression makes it
 * survive the organiser re-uploading the same CSV.
 */
export function captureCheckoutConsent(input: CaptureConsentInput): void {
  const { emailHash, organiserAddress, granted, ts, eventId, source = "checkout" } = input;

  if (!granted) {
    suppressOrg(emailHash, organiserAddress, "declined", ts);
    return;
  }

  recordConsent(emailHash, organiserAddress, {
    ts,
    source,
    ...(eventId ? { eventId } : {}),
    notice: MARKETING_CONSENT_NOTICE,
    version: MARKETING_CONSENT_VERSION,
  });

  if (liftDeclineOnConsent(emailHash, organiserAddress, ts)) {
    console.log(
      `[consent] lifted an earlier decline for ${emailHash.slice(0, 8)}… ` +
        `on ${organiserAddress.toLowerCase()} — superseded by a later opt-in`,
    );
  }
}
