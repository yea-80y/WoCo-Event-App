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
 * funds it (docs.stripe.com/payments/link/link-payment-integrations), and
 * Checkout prices it as a card payment (docs.stripe.com/payments/link/checkout-link),
 * both read 2026-10-23. Checkout shows it only when listed here beside `card`.
 * The platform's connected-account payment-method config should match (non-card
 * methods Blocked), but that is a dashboard setting; this list is the guarantee.
 */
export const CHECKOUT_PAYMENT_METHOD_TYPES: ["card", "link"] = ["card", "link"];

/** Cards alone: the fallback below, and the shop checkout (unchanged by Link). */
export const CARD_ONLY_PAYMENT_METHOD_TYPES: ["card"] = ["card"];

export type CheckoutPaymentMethodTypes =
  | typeof CHECKOUT_PAYMENT_METHOD_TYPES
  | typeof CARD_ONLY_PAYMENT_METHOD_TYPES;

/**
 * Link is on by default for every organiser account, but an organiser on the
 * full Stripe Dashboard can switch it off for their own account, and a session
 * that names a method the account cannot take may be refused outright. Card is
 * the account's core capability, so a refused create is tried once more with
 * cards alone: a sale is never lost to Link. Only an invalid-request refusal
 * retries - a failed create made no session, so the second call cannot
 * duplicate one, and anything else (a timeout that may have succeeded) is
 * thrown as before. A refusal for another reason fails again on cards and is
 * thrown from there.
 */
export async function createWithCardOnlyFallback<T>(
  create: (types: CheckoutPaymentMethodTypes) => Promise<T>,
  onFallback: (err: unknown) => void,
): Promise<T> {
  try {
    return await create(CHECKOUT_PAYMENT_METHOD_TYPES);
  } catch (err) {
    if ((err as { type?: string } | null)?.type !== "StripeInvalidRequestError") throw err;
    onFallback(err);
    return await create(CARD_ONLY_PAYMENT_METHOD_TYPES);
  }
}
