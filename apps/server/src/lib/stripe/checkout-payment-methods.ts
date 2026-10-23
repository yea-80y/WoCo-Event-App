/**
 * The payment methods every WoCo Checkout Session offers: cards (#799) and
 * Stripe's Link (Onelink).
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
 * Link passes both: Stripe confirms every Link payment immediately, whatever
 * funds it, and prices it as a card payment (docs.stripe.com/payments/link,
 * read 2026-10-23). Checkout shows it only when listed here beside `card`.
 * The platform's connected-account payment-method config should match (non-card
 * methods Blocked), but that is a dashboard setting; this list is the guarantee.
 */
export const CHECKOUT_PAYMENT_METHOD_TYPES: ["card", "link"] = ["card", "link"];
