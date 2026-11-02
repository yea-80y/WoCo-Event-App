/**
 * The payment methods every WoCo Checkout Session offers: cards only (#799).
 *
 * Without this list a session offers whatever the connected account's
 * payment-method configuration allows, and two things break:
 *  - fulfilment acts only on `checkout.session.completed` with
 *    `payment_status === "paid"`. A delayed-notification method (Bacs or SEPA
 *    Direct Debit, bank transfer) completes the session unpaid, so the buyer is
 *    charged later with no ticket and no refund, and the #781 balance check then
 *    pays that money to the organiser as a surplus.
 *  - ORGANISER_TERMS §6 states card rates; Klarna and the other methods the
 *    platform default switches on cost the organiser more and carry their own
 *    dispute fees.
 * The platform's connected-account payment-method config should match (non-card
 * methods Blocked), but that is a dashboard setting; this list is the guarantee.
 *
 * Sent as `allowed_payment_method_types` since API 2026-09-30.endive removed
 * `payment_method_types` from session create (a 400). It only narrows: the
 * session offers the compatible subset of this list, never a method outside it.
 * Checked in test mode 2026-11-02 on a full-Dashboard GBP connected account:
 * ["card"] with this list, ["card","klarna","link"] without one.
 */
export const CHECKOUT_PAYMENT_METHOD_TYPES: ["card"] = ["card"];
