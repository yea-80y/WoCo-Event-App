/**
 * Fee arithmetic for the card checkout — the numbers Organiser Terms §6
 * promises. A regression here misstates what an organiser receives, which is
 * a consumer-law problem, not a display bug.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCardFees, MIN_APPLICATION_FEE_MINOR } from "../src/lib/stripe/checkout-fees.js";
import { readFileSync } from "node:fs";
import { BUYER_FEE_FLOOR_PCT, COVER_FEE_RATES, headlinePrice, type PaymentConfig } from "@woco/shared";

describe("computeCardFees", () => {
  it("pass-through: buyer pays ticket × (1 + pct/100), platform takes 1.5% of subtotal", () => {
    // The Organiser Terms §6 worked example: £20 ticket, 10% booking fee.
    const f = computeCardFees({ feePassedToCustomer: true, buyerFeePercent: 10 }, 20, 1);
    assert.equal(f.buyerFeePct, 10);
    assert.equal(f.chargeAmount, 2200); // £22.00
    assert.equal(f.totalApplicationFee, 30); // £0.30 = 1.5% of £20
  });

  it("absorb: buyer pays the ticket price alone; platform fee unchanged", () => {
    const f = computeCardFees({ feePassedToCustomer: false }, 20, 1);
    assert.equal(f.buyerFeePct, 0);
    assert.equal(f.chargeAmount, 2000);
    assert.equal(f.totalApplicationFee, 30);
  });

  it("absent flag means absorb — legacy series without the field", () => {
    const f = computeCardFees({}, 20, 1);
    assert.equal(f.buyerFeePct, 0);
    assert.equal(f.chargeAmount, 2000);
  });

  it("missing percent falls back to the 10% default", () => {
    const f = computeCardFees({ feePassedToCustomer: true }, 20, 1);
    assert.equal(f.buyerFeePct, 10);
    assert.equal(f.chargeAmount, 2200);
  });

  it("stored percent below the floor is clamped up", () => {
    const f = computeCardFees({ feePassedToCustomer: true, buyerFeePercent: 1 }, 20, 1);
    assert.equal(f.buyerFeePct, BUYER_FEE_FLOOR_PCT);
    assert.equal(f.chargeAmount, 2000 + Math.round((2000 * BUYER_FEE_FLOOR_PCT) / 100));
  });

  it("application fee scales with quantity on the ticket subtotal, not the marked-up charge", () => {
    const f = computeCardFees({ feePassedToCustomer: true, buyerFeePercent: 10 }, 20, 3);
    assert.equal(f.chargeAmount, 2200); // per unit — Stripe multiplies by quantity
    assert.equal(f.totalApplicationFee, 90); // 1.5% of £60, NOT of £66
  });

  it("sub-£1 tickets round per unit in integer cents", () => {
    const f = computeCardFees({ feePassedToCustomer: true, buyerFeePercent: 10 }, 0.55, 2);
    assert.equal(f.chargeAmount, 55 + Math.round(5.5)); // 61p per unit
    assert.equal(f.totalApplicationFee, Math.round((110 * 150) / 10_000)); // 2p
  });
});

// #645: the webhook proves a sale is ours by the platform fee on it, so a sale
// whose fee rounds to 0 would be charged and never fulfilled.
describe("the fee floor", () => {
  it("a 30p ticket rounds to no fee, so it sits below the floor", () => {
    assert.equal(computeCardFees({}, 0.3, 1).totalApplicationFee, 0);
    assert.ok(computeCardFees({}, 0.3, 1).totalApplicationFee < MIN_APPLICATION_FEE_MINOR);
    assert.ok(computeCardFees({}, 0.34, 1).totalApplicationFee >= MIN_APPLICATION_FEE_MINOR);
  });

  it("both card checkouts refuse a sale below the floor before creating a session", () => {
    const cases: Array<[string, string, string]> = [
      ["../src/routes/stripe.ts", "totalApplicationFee < MIN_APPLICATION_FEE_MINOR", "checkout.sessions.create("],
      ["../src/routes/shops.ts", "applicationFee < MIN_APPLICATION_FEE_MINOR", "checkout.sessions.create("],
    ];
    for (const [rel, guard, create] of cases) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf-8");
      const g = src.indexOf(guard);
      assert.ok(g >= 0, `${rel} must refuse a fee below the floor`);
      assert.ok(g < src.indexOf(create), `${rel}: the refusal comes before the session`);
    }
  });
});

describe("headline price parity", () => {
  it("every listing shows exactly what the checkout charges per ticket", () => {
    // A drift here advertises one price and charges another (CMA209).
    for (const price of ["1.00", "3.33", "9.99", "12.50", "20.00", "47.85", "59.00", "453.00", "847.00"]) {
      for (const fee of [
        { feePassedToCustomer: false },
        { feePassedToCustomer: true },
        { feePassedToCustomer: true, buyerFeePercent: 1 },
        { feePassedToCustomer: true, buyerFeePercent: 4.5 },
        { feePassedToCustomer: true, buyerFeePercent: 12.5 },
        { feePassedToCustomer: true, coverFees: { ...COVER_FEE_RATES } },
      ]) {
        const payment = { price, currency: "GBP", stripeEnabled: true, ...fee } as PaymentConfig;
        const shown = Math.round(headlinePrice(payment)!.amount * 100);
        assert.equal(shown, computeCardFees(fee, parseFloat(price), 1).sessionAmount, `${price} ${JSON.stringify(fee)}`);
      }
    }
  });
});

describe("cover the fees", () => {
  const cover = { feePassedToCustomer: true, coverFees: { ...COVER_FEE_RATES } };

  it("charges the ticket line at face value plus one order-level booking fee", () => {
    const f = computeCardFees(cover, 20, 3);
    assert.equal(f.buyerFeePct, 0);
    assert.equal(f.chargeAmount, 2000);
    assert.ok(f.orderFeeAmount > 0);
    assert.equal(f.sessionAmount, 2000 * 3 + f.orderFeeAmount);
    assert.equal(f.totalApplicationFee, 90); // 1.5% of the tickets, never of the fee
  });

  it("checkout refuses unaccepted stored rates and sends the fee as its own line", () => {
    const src = readFileSync(new URL("../src/routes/stripe.ts", import.meta.url), "utf-8");
    const create = src.indexOf("checkout.sessions.create(");
    const gate = src.indexOf("!acceptedCoverFeeRates(series.payment.coverFees)");
    assert.ok(gate >= 0 && gate < create, "rates are checked before a session exists");
    assert.ok(src.includes('product_data: { name: "Booking fee" }'));
    // The integrity tag must commit to the real order total, fee line included.
    assert.ok(src.includes("amountTotal: sessionAmount"));
  });

  it("publish accepts only today's rates for a cover-the-fees series", () => {
    const src = readFileSync(new URL("../src/routes/events.ts", import.meta.url), "utf-8");
    assert.ok(src.includes("r?.stripeBp !== COVER_FEE_RATES.stripeBp"));
    assert.ok(src.includes("s.payment.buyerFeePercent !== undefined"));
  });
});
