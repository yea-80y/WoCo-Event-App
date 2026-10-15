/**
 * Which events may be sold, judged by their organiser's keys (issue 896).
 *
 * A sale seals the buyer's details to the event's order key, and the only order key
 * the server can vouch for is the AUTHORITATIVE one (`eventKeys`): the account's key
 * ring, else the key recorded at create. An event with neither - no record
 * (`legacy`), or a record written before the order key was recorded - has only the
 * key its own feed names, and that feed is a client-signed SOC the device-cached
 * content signer can re-sign at any time, so it can name any key. Such events are not
 * sold: publishing the event again records its key. Keys that cannot be read refuse
 * too (fail closed).
 *
 * ONE helper, called by every path that holds a seat, takes an order box or charges,
 * so those paths cannot drift - the same shape as the privacy-notice gate. The 409
 * reuses `EVENT_NEEDS_REPUBLISH`, a code every buyer surface already closes its form
 * on (`isSaleClosedCode`), so no client change is needed.
 */

import { EVENT_NEEDS_REPUBLISH } from "@woco/shared";
import type { EventKeys } from "./event-keys.js";

export const ORDER_KEY_UNAVAILABLE = "ORDER_KEY_UNAVAILABLE";
export const NOT_ON_SALE = "Tickets for this event aren't on sale right now - please contact the organiser.";
const KEYS_UNREADABLE = "Ticket sales are temporarily unavailable. Please try again in a minute.";

/** Keys a sale may go ahead under: an authoritative order key is known. */
export type SellableKeys = Extract<EventKeys, { kind: "ring" | "record" }> & { orderKeyRef: string };

export type SaleKeysVerdict =
  | { ok: true; keys: SellableKeys }
  | { ok: false; status: 409 | 503; body: { ok: false; error: string; code: string } };

export function sellableKeys(keys: EventKeys): SaleKeysVerdict {
  if (keys.kind === "unavailable") {
    return { ok: false, status: 503, body: { ok: false, error: KEYS_UNREADABLE, code: ORDER_KEY_UNAVAILABLE } };
  }
  if ((keys.kind === "ring" || keys.kind === "record") && keys.orderKeyRef) {
    return { ok: true, keys: keys as SellableKeys };
  }
  return { ok: false, status: 409, body: { ok: false, error: NOT_ON_SALE, code: EVENT_NEEDS_REPUBLISH } };
}
