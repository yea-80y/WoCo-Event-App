/**
 * Which suppression marks a service notice may cross (#60 item 1).
 *
 * The split is not "how serious is the mark" — it is what KIND of fact the mark
 * records. A consent fact says the person does not want to be sold to. A
 * deliverability fact says the message cannot or must not be delivered at all.
 * A service notice about someone's own booking answers the first and is
 * powerless against the second.
 *
 *   unsub      — consent. Scoped to one organiser's MARKETING; the /u page says
 *                so in terms ("Stop marketing emails from this organiser…
 *                Ticket confirmations for events you book are not affected").
 *   unsub_all  — consent. Reads as absolute, and is not: the checkbox says
 *                "block all MARKETING email sent via WoCo, from any organiser".
 *                The booking channel was explicitly reserved, and transactional
 *                ticket mail already crosses it today without controversy.
 *   declined   — consent. A refusal at the point of collection, i.e. the
 *                weakest of the three; it was never even an unsubscribe.
 *
 *   bounce     — deliverability. The address does not accept mail. Sending
 *                cannot inform anyone and burns the shared sending reputation
 *                that every organiser on the platform depends on. SES's own
 *                account-level suppression would likely eat it regardless.
 *   complaint  — deliverability. This person pressed "spam". Re-mailing them
 *                invites a second complaint against the same shared domain.
 *   manual     — OVERLOADED, and therefore never crossed. It is written both by
 *                the organiser's own suppress endpoint (`routes/marketing.ts`)
 *                and by an Art. 17 erasure request (`subject-request.ts`). A
 *                rights invocation and a housekeeping click share one label, so
 *                the safe reading is the stricter one. The cost — an organiser
 *                who hand-suppressed someone cannot send them a cancellation —
 *                is rare and self-inflicted. If it ever bites, the fix is to
 *                split the source label, NOT to widen this set.
 *
 * The residual harm from refusing on a deliverability mark is thin: a cancelled
 * event refunds, and a Stripe refund receipt reaches the buyer through a channel
 * suppression never touches.
 */

import type { SuppressSource } from "../marketing/suppression-store.js";

const CROSSABLE: ReadonlySet<SuppressSource> = new Set<SuppressSource>(["unsub", "unsub_all", "declined"]);

/**
 * May a service notice be delivered despite these marks?
 *
 * Fails closed on an empty-but-suppressed disagreement and on any source not
 * named above: a new `SuppressSource` added later is refused until someone
 * classifies it here deliberately, which is the opposite of how `allowUnproven`
 * silently kept granting permission after its meaning changed (#387).
 */
export function mayCrossSuppression(sources: readonly SuppressSource[]): boolean {
  return sources.length > 0 && sources.every((s) => CROSSABLE.has(s));
}
