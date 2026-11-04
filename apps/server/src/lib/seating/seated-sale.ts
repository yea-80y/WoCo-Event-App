/**
 * Seated series and the quantity sale paths (docs/SEATING.md, S3 consult Q6).
 *
 * A seated series sells by SEAT: a hold names seats on the pinned plan, the checkout
 * prices each, the mint seats each ticket. The agent rail sells by QUANTITY, so it
 * always refuses a series registered seated; `/reserve` and `create-checkout` refuse it
 * while `seatedEventsAllowed` is off. Keyed on the registration record, never the feed
 * (decision 4).
 */

import { registrationSeatingFor } from "../event/onchain-registry.js";

export const SEATED_NOT_ON_SALE = "Tickets for this event are not currently on sale";

export function seatedSaleRefusal(eventId: string, seriesId: string): { status: 409; body: { ok: false; error: string } } | null {
  return registrationSeatingFor(eventId, seriesId) ? { status: 409, body: { ok: false, error: SEATED_NOT_ON_SALE } } : null;
}
