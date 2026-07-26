/**
 * Point-of-collection consent wording — single source of truth.
 *
 * UK GDPR Art. 7(1) evidence is only worth anything if the stored record
 * matches what the person was actually shown. Client and server therefore read
 * the SAME constant: the checkout renders `MARKETING_CONSENT_NOTICE`, the
 * server stores that identical string against the consent record. Duplicating
 * the wording in a Svelte template would let the two drift silently and quietly
 * void the evidence.
 *
 * Bump MARKETING_CONSENT_VERSION whenever the wording changes materially —
 * old records keep the text they were captured under.
 */

export const MARKETING_CONSENT_VERSION = 1;

/**
 * Shown next to an UNCHECKED opt-in control. Must stay unticked by default:
 * pre-ticked boxes are not valid consent (UK GDPR Recital 32; Planet49, C-673/17).
 */
export const MARKETING_CONSENT_NOTICE =
  "Email me about future events from this organiser. You can unsubscribe at any time.";

/**
 * Always shown, regardless of the opt-in state. This is the transactional
 * carve-out — PECR does not treat it as marketing, and it must not be
 * presented as optional or bundled into the consent control.
 */
export const TRANSACTIONAL_EMAIL_NOTICE =
  "We'll email you your ticket and any updates about this event.";

/**
 * Point-of-collection privacy summary. Deliberately concrete about the three
 * things a buyer cannot infer from a generic policy link:
 *   1. the organiser — not WoCo — is the one who receives their details;
 *   2. answers are encrypted in-browser to a key only the organiser holds;
 *   3. records on a public decentralised network cannot be individually
 *      deleted, only rendered unreadable and left to expire.
 * (3) in particular must be disclosed BEFORE submission, not buried in a policy.
 */
export const CHECKOUT_PRIVACY_SUMMARY =
  "Your details go to the event organiser, who is responsible for them. Anything you enter here is " +
  "encrypted in your browser to a key only they hold — WoCo cannot read it. Ticket records are kept " +
  "on a public decentralised storage network, so they cannot be individually deleted; on request we " +
  "destroy the key that makes them readable and stop renewing their storage.";
