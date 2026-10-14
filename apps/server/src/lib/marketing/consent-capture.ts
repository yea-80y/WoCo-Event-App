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
 *
 * Two controls since 2026-10-14 (`legal/consent.ts`): consent mode's unticked
 * "Email me", and own-events mode's PECR soft opt-in - a sentence and an
 * unticked "Don't email me". What the box means depends on the mode the buyer
 * was SHOWN, which the page reports and create-checkout checks against the
 * organiser's notice before charging.
 */

import { marketingDecision, marketingWording, type MarketingChoice } from "@woco/shared";
import { consentBasis, getConsent, recordConsent, type ConsentRecord, type ConsentSource } from "./consent-store.js";
import { liftDeclineOnConsent, suppressOrg } from "./suppression-store.js";

export interface CaptureConsentInput {
  emailHash: string;
  organiserAddress: string;
  /** What the page showed, and what the buyer did with the box. */
  choice: MarketingChoice;
  /** The organiser's name as the own-events sentence showed it. */
  organiserName?: string;
  /** ISO timestamp of the decision — also the ordering evidence for a lift. */
  ts: string;
  eventId?: string;
  source?: ConsentSource;
}

/**
 * Record a checkout marketing decision in whichever store enforces it.
 *
 * Consent (ticked "Email me") → consent record (evidence) + lift any earlier
 * `"declined"` suppression for this organiser, so an affirmative choice actually
 * takes effect. The lift is narrow by construction: `liftDeclineOnConsent`
 * refuses to touch unsubs, bounces, complaints or global marks.
 *
 * Soft opt-in (left "Don't email me" unticked) → a soft-opt-in record, and
 * nothing else. Leaving a box alone is not an affirmative act, so it NEVER lifts
 * a decline or any other suppression, and it never replaces a consent record:
 * the stronger basis is kept.
 *
 * Refusal (either box saying no) → suppression only. It is deliberately NOT
 * stored as a consent record: "no" needs no new enforcement path, and routing it
 * through suppression makes it survive the organiser re-uploading the same CSV.
 *
 * The wording stored is looked up here by mode and version - never taken from
 * the page - so the record holds what that control said.
 */
export function captureCheckoutConsent(input: CaptureConsentInput): void {
  const { emailHash, organiserAddress, choice, organiserName, ts, eventId, source = "checkout" } = input;
  const decision = marketingDecision(choice.mode, choice.ticked);

  if (decision === "declined") {
    suppressOrg(emailHash, organiserAddress, "declined", ts);
    return;
  }

  const wording = marketingWording(choice.mode, choice.version, organiserName);
  if (!wording) {
    // create-checkout refuses a version it does not know, so this is unreachable;
    // a record without the wording shown would be no evidence at all.
    console.error(`[consent] no wording for ${choice.mode} v${choice.version} - nothing recorded`);
    return;
  }
  const record: ConsentRecord = {
    ts,
    source,
    ...(eventId ? { eventId } : {}),
    basis: decision,
    notice: wording.sentence ?? wording.box,
    ...(wording.sentence ? { control: wording.box } : {}),
    version: choice.version,
    surface: choice.surface,
  };

  if (decision === "soft-opt-in") {
    const existing = getConsent(emailHash, organiserAddress);
    if (existing && consentBasis(existing) === "consent") return;
    recordConsent(emailHash, organiserAddress, record);
    return;
  }

  if (!recordConsent(emailHash, organiserAddress, record)) {
    // The evidence did not reach disk (#882: file unreadable, or the write
    // failed), so the decline stays. Lifting it would outlive a restart the
    // record does not, leaving a mailable address with no Art. 7(1) evidence.
    console.error(`[consent] opt-in for ${emailHash.slice(0, 8)}… not on disk - earlier decline kept`);
    return;
  }
  if (liftDeclineOnConsent(emailHash, organiserAddress, ts)) {
    console.log(
      `[consent] lifted an earlier decline for ${emailHash.slice(0, 8)}… ` +
        `on ${organiserAddress.toLowerCase()} — superseded by a later opt-in`,
    );
  }
}
