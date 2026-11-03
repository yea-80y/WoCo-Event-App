import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeatedReserve, seatedReserveRefusal } from "../../src/seating/reserve.js";
import { RESERVATION_MAX_QTY } from "../../src/event/reservation.js";

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
