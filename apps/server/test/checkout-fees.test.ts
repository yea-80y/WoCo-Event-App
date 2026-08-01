/**
 * Fee arithmetic for the card checkout — the numbers Organiser Terms §6
 * promises. A regression here misstates what an organiser receives, which is
 * a consumer-law problem, not a display bug.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCardFees } from "../src/lib/stripe/checkout-fees.js";
import { BUYER_FEE_FLOOR_PCT } from "@woco/shared";

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
