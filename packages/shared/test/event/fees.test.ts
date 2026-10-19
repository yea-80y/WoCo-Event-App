/**
 * The buyer-receipt arithmetic, pinned. Organiser Terms §6 states this
 * structure contractually and the server (apps/server checkout-fees.ts)
 * mirrors it — a drift here shows a buyer a total Stripe will not charge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBuyerFees, CURRENCY_SYMBOLS, headlinePrice, headlinePriceRange,
  coverFeeMinor, cardOrderAmounts, acceptedCoverFeeRates, bookingFeeMode, platformFeeMinor,
  wellFormedCoverFeeRates,
} from "../../src/event/fees.js";
import { BUYER_FEE_FLOOR_PCT, FEATURES, COVER_FEE_RATES, STRIPE_UK_STANDARD_CARD } from "../../src/features.js";
import type { PaymentConfig, CoverFeeRates } from "../../src/event/types.js";

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

// ── "Cover the fees": per order, priced at the dearest card ─────────────────

const cover = { feePassedToCustomer: true, coverFees: { ...COVER_FEE_RATES } };

/** What the organiser keeps on a card at `bp` + `fixed`, Stripe rounding half up. */
const organiserNet = (subtotal: number, fee: number, bp: number, fixed: number, radar = 0) => {
  const total = subtotal + fee;
  return total - (Math.round((total * bp) / 10_000) + fixed) - radar - platformFeeMinor(subtotal);
};

test("cover fee leaves the organiser at least the subtotal on the dearest card, and is the smallest that does", () => {
  const r = COVER_FEE_RATES;
  for (let subtotal = 100; subtotal <= 100_000; subtotal++) {
    const fee = coverFeeMinor(subtotal, r);
    assert.ok(organiserNet(subtotal, fee, r.stripeBp, r.stripeFixedMinor, r.radarMinor) >= subtotal, `short at ${subtotal}`);
    assert.ok(organiserNet(subtotal, fee - 1, r.stripeBp, r.stripeFixedMinor, r.radarMinor) < subtotal, `not minimal at ${subtotal}`);
    // A standard UK card is cheaper, so the organiser keeps the difference.
    const std = STRIPE_UK_STANDARD_CARD;
    assert.ok(organiserNet(subtotal, fee, std.bp, std.fixedMinor) >= subtotal);
  }
});

test("cover fee survives the half-penny boundaries where both roundings go up", () => {
  // £59 / £453 / £847: a closed form with no search nets 1p short here.
  for (const subtotal of [5_900, 45_300, 84_700]) {
    for (const r of [COVER_FEE_RATES, { stripeBp: 150, stripeFixedMinor: 20, radarMinor: 0 }]) {
      const fee = coverFeeMinor(subtotal, r);
      assert.ok(organiserNet(subtotal, fee, r.stripeBp, r.stripeFixedMinor) >= subtotal, `${subtotal} ${r.stripeBp}`);
    }
  }
  // Radar's per-payment fee is covered when the rates include it.
  const withRadar = { ...COVER_FEE_RATES, radarMinor: 8 };
  assert.ok(organiserNet(2_000, coverFeeMinor(2_000, withRadar), 315, 20, 8) >= 2_000);
});

test("cover fee is one order-level line, cheaper per ticket for bigger orders", () => {
  const one = cardOrderAmounts(cover, 2_000, 1);
  assert.equal(one.mode, "cover");
  assert.equal(one.unitChargeMinor, 2_000);
  assert.equal(one.orderFeeMinor, 117);
  assert.equal(one.totalMinor, 2_117);
  assert.equal(one.applicationFeeMinor, 30);
  const four = cardOrderAmounts(cover, 2_000, 4);
  assert.equal(four.totalMinor, 2_000 * 4 + four.orderFeeMinor);
  assert.ok(four.orderFeeMinor < 4 * one.orderFeeMinor);
  assert.equal(four.applicationFeeMinor, 120);
});

test("cover mode headline and receipt: fee included and labelled without a percent", () => {
  const p = payment({ price: "20.00", ...cover });
  const h = headlinePrice(p)!;
  assert.equal(h.label, "£21.17");
  assert.equal(h.feeLabel, "£1.17");
  const r = calculateBuyerFees(p, 1)!;
  assert.equal(r.feeRowLabel, "Booking fee");
  assert.equal(r.cardTotal, "£21.17");
  assert.equal(calculateBuyerFees(payment({ feePassedToCustomer: true, buyerFeePercent: 10 }), 1)!.feeRowLabel, "Booking fee (10%)");
  assert.equal(calculateBuyerFees(payment(), 1)!.feeRowLabel, null);
});

test("cover rates only count with the booking fee on, and only accepted sets are accepted", () => {
  assert.equal(bookingFeeMode({ coverFees: { ...COVER_FEE_RATES } }), "none");
  assert.ok(acceptedCoverFeeRates({ ...COVER_FEE_RATES }));
  assert.ok(!acceptedCoverFeeRates({ ...COVER_FEE_RATES, stripeBp: 0 }));
  assert.ok(!acceptedCoverFeeRates(undefined));
});

test("malformed stored rates price as no fee and never hang a page", () => {
  // An organiser can re-sign their own event feed; every listing prices it.
  for (const coverFees of [
    { stripeBp: 10_001, stripeFixedMinor: 20, radarMinor: 0 },
    { stripeBp: 10_000, stripeFixedMinor: 20, radarMinor: 0 },
    { stripeBp: "315", stripeFixedMinor: 20, radarMinor: 0 },
    { stripeBp: 315, stripeFixedMinor: -20, radarMinor: 0 },
    { stripeBp: 315.5, stripeFixedMinor: 20, radarMinor: 0 },
  ] as unknown as CoverFeeRates[]) {
    assert.ok(!wellFormedCoverFeeRates(coverFees), JSON.stringify(coverFees));
    const h = headlinePrice(payment({ price: "20.00", feePassedToCustomer: true, coverFees }))!;
    assert.equal(h.label, "£20.00");
    assert.throws(() => coverFeeMinor(2_000, coverFees), RangeError);
  }
});

test("well-formed but unaccepted rates still price from the stored copy", () => {
  // A page baked before a rate change must price a later series by its own rates.
  const later = { stripeBp: 315, stripeFixedMinor: 20, radarMinor: 8 };
  assert.ok(wellFormedCoverFeeRates(later));
  const a = cardOrderAmounts({ feePassedToCustomer: true, coverFees: later }, 2_000, 1);
  assert.equal(a.mode, "cover");
  assert.equal(a.orderFeeMinor, coverFeeMinor(2_000, later));
});
