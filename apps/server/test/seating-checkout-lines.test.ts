/**
 * Allocated seating S4: the seated card checkout's lines (lib/seating/seated-checkout.ts).
 * Prices come from the hold and must still be the feed's; one Stripe line per band, the
 * cover fee one order line, and the lines add up to exactly what the hold's view showed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOrderAmountsMulti, COVER_FEE_RATES } from "@woco/shared";
import { PRICES_CHANGED, seatedCheckoutLines, seatedPriceRefusal } from "../src/lib/seating/seated-checkout.js";

const seat = (band: string, priceMinor: number, k: number) => ({ band, bandName: band === "a" ? "Stalls" : "Circle", label: `Row A, seat ${k}`, priceMinor });
const info = [seat("a", 2800, 1), seat("b", 2200, 2), seat("a", 2800, 3)];

test("pinned prices must still be the feed's", () => {
  const feed = { bands: [{ id: "a", price: "28.00" }, { id: "b", price: "22.00" }] };
  assert.equal(seatedPriceRefusal(info, feed), null);
  assert.equal(seatedPriceRefusal(info, { bands: [{ id: "a", price: "30.00" }, { id: "b", price: "22.00" }] }), PRICES_CHANGED);
  assert.equal(seatedPriceRefusal(info, { bands: [{ id: "a", price: "28.00" }] }), PRICES_CHANGED, "a band gone");
  for (const bad of [undefined, null, {}, { bands: "x" }, { bands: [null] }]) assert.equal(seatedPriceRefusal(info, bad), PRICES_CHANGED);
});

test("one line per band in first-seen order; the lines sum to the multi-price total", () => {
  for (const payment of [{}, { feePassedToCustomer: true, buyerFeePercent: 10 }, { feePassedToCustomer: true, coverFees: COVER_FEE_RATES }]) {
    const { amounts, lineItems } = seatedCheckoutLines(info, payment, "gbp", { series: "Seats", event: "Gig" });
    assert.deepEqual(amounts, cardOrderAmountsMulti(payment, [2800, 2200, 2800]));
    const sum = lineItems.reduce((s, l) => s + (l.price_data!.unit_amount as number) * (l.quantity as number), 0);
    assert.equal(sum, amounts.totalMinor, JSON.stringify(payment));
    assert.equal(lineItems[0].quantity, 2);
    assert.equal(lineItems[0].price_data!.product_data!.name, "Stalls — Seats — Gig");
    assert.equal(lineItems[0].price_data!.product_data!.description, "Row A, seat 1; Row A, seat 3");
    assert.equal(lineItems[1].quantity, 1);
    assert.equal(lineItems.length, amounts.orderFeeMinor > 0 ? 3 : 2);
  }
});
