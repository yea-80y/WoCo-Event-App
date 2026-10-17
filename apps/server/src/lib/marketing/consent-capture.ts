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

import { listKeeps, marketingDecision, marketingWording, type MarketingChoice, type OrderField } from "@woco/shared";
import { marketingWordingHash } from "./checkout-choice.js";
import { consentBasis, getConsent, recordConsent, type ConsentRecord, type ConsentSource } from "./consent-store.js";
import { liftDeclineOnConsent, suppressOrg } from "./suppression-store.js";

/**
 * Opt-ins fulfilment could not record since boot, for `/api/health`
 * `marketingOptInsDropped`. Each is a buyer who said yes and will not be mailed:
 * the safe way to be wrong, but a pattern of them is a fault worth seeing, and a
 * log line alone reached nobody. Counts only - the endpoint is public.
 */
let droppedSinceBoot = 0;
let lastDroppedAt: string | null = null;

function dropOptIn(why: string): void {
  droppedSinceBoot += 1;
  lastDroppedAt = new Date().toISOString();
  console.error(`[consent] ${why} - nothing recorded`);
}

/** No `ok`: a report, not an alarm (the cause is usually an organiser's edit mid-checkout). */
export function droppedOptInsHealth(): { sinceBoot: number; lastAt: string | null } {
  return { sinceBoot: droppedSinceBoot, lastAt: lastDroppedAt };
}

export interface CaptureConsentInput {
  emailHash: string;
  /** Empty when fulfilment could not read the event: there is then no organiser to record for. */
  organiserAddress: string;
  /** What the page showed, and what the buyer did with the box. */
  choice: MarketingChoice;
  /** The organiser's name as the own-events sentence showed it. */
  organiserName?: string;
  /** The event's questions as fulfilment read them: the wording names what the list keeps. */
  orderFields?: readonly OrderField[];
  /** create-checkout's hash of the wording it matched to the page's. */
  wordingHash?: string;
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
 * The wording stored is rebuilt here from the mode, version, organiser name and
 * the event's questions - never taken from the page - and recorded only if it
 * hashes to what create-checkout matched to the page's text, so the record holds
 * what that control said. The ids of the questions it named are stored beside
 * it, so a later edit to the questions never widens what this buyer agreed to.
 */
export function captureCheckoutConsent(input: CaptureConsentInput): void {
  const { emailHash, organiserAddress, choice, organiserName, orderFields, wordingHash, ts, eventId, source = "checkout" } = input;
  const decision = marketingDecision(choice.mode, choice.ticked);

  if (!organiserAddress) {
    if (decision === "declined") console.error(`[consent] ${choice.mode} v${choice.version}: decline with no organiser (event unreadable) - nothing recorded`);
    else dropOptIn(`${choice.mode} v${choice.version}: no organiser (event unreadable)`);
    return;
  }

  if (decision === "declined") {
    suppressOrg(emailHash, organiserAddress, "declined", ts);
    return;
  }

  const keeps = listKeeps(orderFields);
  const wording = marketingWording(choice.mode, choice.version, organiserName, keeps);
  if (!wording || !wordingHash || marketingWordingHash(wording) !== wordingHash) {
    // A record without the wording shown would be no evidence at all. The hash
    // misses only if the event's questions changed between checkout and payment;
    // no record means the buyer is not mailed - the safe way to be wrong.
    dropOptIn(`${choice.mode} v${choice.version}: wording not the one checkout showed`);
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
    // From the same rebuild as the words just matched: the list import copies these and no more.
    keptFields: keeps.fieldIds,
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
