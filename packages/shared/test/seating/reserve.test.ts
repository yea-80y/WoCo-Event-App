import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeatedReserve, seatedHoldFees, seatedReserveRefusal } from "../../src/seating/reserve.js";
import { RESERVATION_MAX_QTY } from "../../src/event/reservation.js";

test("a seated hold's receipt shows the server's amounts, never re-priced", () => {
  const amounts = { currency: "GBP", mode: "cover", feePercent: 0, subtotalMinor: 7800, orderFeeMinor: 297, bookingFeeMinor: 297, totalMinor: 8097 };
  const f = seatedHoldFees({ quantity: 3, amounts });
  assert.equal(f.baseLabel, "Seats (×3)");
  assert.equal(f.base, "£78.00");
  assert.equal(f.feeRowLabel, "Booking fee");
  assert.equal(f.fee, "£2.97");
  assert.equal(f.cardTotal, "£80.97");
  assert.equal(f.cryptoTotal, null);
  const one = seatedHoldFees({ quantity: 1, amounts: { ...amounts, mode: "percent", feePercent: 10 } });
  assert.equal(one.baseLabel, "Seat");
  assert.equal(one.feeRowLabel, "Booking fee (10%)");
  assert.equal(seatedHoldFees({ quantity: 2, amounts: { ...amounts, mode: "none" } }).feeRowLabel, null);
});

const digest = `0x${"ab".repeat(32)}`;

test("a seated hold names seats on the plan and the plan's digest", () => {
  assert.deepEqual(parseSeatedReserve({ seats: [9, 2, 5], planDigest: digest, quantity: 3 }, 10), { seats: [2, 5, 9], planDigest: digest });
  for (const bad of [
    { seats: [], planDigest: digest },
    { seats: [1, 1], planDigest: digest },
    { seats: [100], planDigest: digest },
    { seats: [-1], planDigest: digest },
    { seats: [1.5], planDigest: digest },
    { seats: ["1"], planDigest: digest },
    { seats: Array.from({ length: RESERVATION_MAX_QTY + 1 }, (_, i) => i), planDigest: digest },
    { seats: [1], planDigest: digest.toUpperCase() },
    { seats: [1], planDigest: "0xab" },
    { seats: [1] },
    null,
    [1],
  ]) {
    assert.equal(parseSeatedReserve(bad, 100), null, JSON.stringify(bad));
  }
});

test("a hold for any plan but the pinned one is refused (S4 obligation, docs/SEATING.md decision 4)", () => {
  const req = parseSeatedReserve({ seats: [1], planDigest: digest }, 10)!;
  assert.equal(seatedReserveRefusal(req, { planDigest: digest }), null);
  assert.equal(seatedReserveRefusal(req, { planDigest: digest.toUpperCase().replace("0X", "0x") }), null);
  assert.equal(seatedReserveRefusal(req, { planDigest: `0x${"cd".repeat(32)}` }), "plan_changed");
});
