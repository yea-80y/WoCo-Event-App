/**
 * The machine-readable codes `/api/holdings/*` answers with (server `routes/holdings.ts`,
 * client `apps/web/src/lib/api/holdings.ts`).
 *
 * Why codes and not the HTTP status alone: a 404 from a server that predates the route,
 * a proxy or a CDN error page looks the same as "no receipt with that id". The app treats
 * the second as final for that answer and the first as "try later", and the buyer's
 * secret is never dropped on either (spec-receipt-note 13a, 3a item 11). Only the route
 * itself sets these, so only the route can say "not found" or "refused".
 */

export const HOLDING_API_CODES = {
  /** No paid, unerased receipt with that pickup id. */
  NOT_FOUND: "RECEIPT_NOT_FOUND",
  /** The erase was not signed by the order's key inside the window (usually the device clock). */
  ERASE_REFUSED: "RECEIPT_ERASE_REFUSED",
  /** The box is being stored right now: try again in a minute. */
  STORING: "RECEIPT_STORING",
  /** The sale is not paid yet: nothing to erase. */
  NOT_ISSUED: "RECEIPT_NOT_ISSUED",
  /** Receipts are switched off on this server. */
  OFF: "RECEIPTS_OFF",
} as const;
