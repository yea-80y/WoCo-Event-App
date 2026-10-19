/**
 * The buyer-receipt arithmetic, pinned. Organiser Terms §6 states this
 * structure contractually and the server (apps/server checkout-fees.ts)
 * mirrors it — a drift here shows a buyer a total Stripe will not charge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBuyerFees, CURRENCY_SYMBOLS, headlinePrice, headlinePriceRange } from "../../src/event/fees.js";
import { BUYER_FEE_FLOOR_PCT, FEATURES } from "../../src/features.js";
import type { PaymentConfig } from "../../src/event/types.js";

const payment = (over: Partial<PaymentConfig> = {}): PaymentConfig => ({
  price: "10.00",
  currency: "GBP",
  stripeEnabled: true,
  cryptoEnabled: false,
  ...over,
} as PaymentConfig);

test("no payment or non-positive price yields no receipt at all", () => {
  assert.equal(calculateBuyerFees(undefined, 1), null);
  assert.equal(calculateBuyerFees(payment({ price: "0" }), 1), null);
  assert.equal(calculateBuyerFees(payment({ price: "nope" }), 1), null);
});

test("organiser absorbs fees → feePercent 0 and the card total is the bare subtotal", () => {
  const f = calculateBuyerFees(payment(), 2)!;
  assert.equal(f.feePercent, 0);
  assert.equal(f.cardTotal, "£20.00");
});

test("booking fee is rounded to cents PER UNIT then multiplied — the server's arithmetic exactly", () => {
  // 10% of £3.33 = 33.3¢ → rounds to 33¢ per unit; 3 units = £0.99 fee, not £1.00
  const f = calculateBuyerFees(
    payment({ price: "3.33", feePassedToCustomer: true, buyerFeePercent: 10 }),
    3,
  )!;
  assert.equal(f.fee, "£0.99");
  assert.equal(f.cardTotal, "£10.98");
});

test("a buyerFeePercent below the floor is clamped up to what Stripe will actually charge", () => {
  const f = calculateBuyerFees(
    payment({ feePassedToCustomer: true, buyerFeePercent: 1 }),
    1,
  )!;
  assert.equal(f.feePercent, BUYER_FEE_FLOOR_PCT);
});

test("cardTotal is null when Stripe is off; cryptoTotal stays null while the crypto rail is flagged off", () => {
  const f = calculateBuyerFees(payment({ stripeEnabled: false, cryptoEnabled: true }), 1)!;
  assert.equal(f.cardTotal, null);
  // Pinned to the flag, not to a constant false — flips with the feature.
  assert.equal(f.cryptoTotal === null, !FEATURES.cryptoPaymentsAllowed);
});

test("currency symbol table renders the three supported currencies", () => {
  assert.equal(CURRENCY_SYMBOLS.GBP, "£");
  assert.equal(CURRENCY_SYMBOLS.USD, "$");
  assert.equal(CURRENCY_SYMBOLS.EUR, "€");
});

// ── Headline price: what every listing leads with (CMA209) ──────────────────

test("headline price includes the booking fee and names it", () => {
  // Organiser Terms §6 worked example: £20 ticket, 10% booking fee.
  const h = headlinePrice(payment({ price: "20.00", feePassedToCustomer: true, buyerFeePercent: 10 }))!;
  assert.equal(h.amount, 22);
  assert.equal(h.label, "£22.00");
  assert.equal(h.feeLabel, "£2.00");
});

test("no booking fee: the headline is the ticket price and there is no fee to name", () => {
  const h = headlinePrice(payment({ price: "20.00", feePassedToCustomer: false }))!;
  assert.equal(h.label, "£20.00");
  assert.equal(h.feeLabel, null);
});

test("headline matches the receipt's per-ticket total, rounding and floor included", () => {
  for (const over of [
    { price: "3.33", feePassedToCustomer: true, buyerFeePercent: 10 },
    { price: "12.50", feePassedToCustomer: true, buyerFeePercent: 1 }, // clamped to the floor
    { price: "9.99", feePassedToCustomer: true },                      // default %
    { price: "15.00" },
  ]) {
    const p = payment(over);
    assert.equal(headlinePrice(p)!.label, calculateBuyerFees(p, 1)!.cardTotal);
  }
});

test("no payment or non-positive price has no headline", () => {
  assert.equal(headlinePrice(undefined), null);
  assert.equal(headlinePrice(payment({ price: "0" })), null);
});

test("price range spans the paid ticket types by headline, not by face value", () => {
  // £10 with 10% (£11.00) is dearer than £10.50 with no fee (£10.50).
  const range = headlinePriceRange([
    { payment: payment({ price: "10.00", feePassedToCustomer: true, buyerFeePercent: 10 }) },
    { payment: payment({ price: "10.50" }) },
    {},
  ])!;
  assert.equal(range.min.label, "£10.50");
  assert.equal(range.max.label, "£11.00");
  assert.equal(headlinePriceRange([{}]), null);
});
