/**
 * Seat holds: one number every surface that takes a hold must agree on.
 * The server's reservation store, the app, the embed and the seat map all import it.
 */

/** Most tickets one hold (and one checkout) may cover. Matches Stripe checkout's cap. */
export const RESERVATION_MAX_QTY = 10;
