/**
 * A signed-in buyer's checkout request (`src/holding/request.ts`): accepted only whole,
 * for exactly the order's quantity, with every key distinct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLDING_RETENTION_MONTHS, parseHoldingRequest } from "../../src/holding/request.js";
import { holdingPublicValues } from "../../src/holding/derive.js";
import { R } from "./vectors.js";

const pv = holdingPublicValues(R, 2);
const SEALED = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(64) };
const GOOD = {
  v: 1,
  holders: pv.holders,
  answerKeys: pv.answerKeys,
  nkCommit: pv.nkCommit,
  pickupId: pv.pickupId,
  pickupSigner: pv.pickupSigner,
  pickupPub: Buffer.from(pv.pickupPub).toString("hex"),
  sealedR: SEALED,
};

test("the receipt period is 12 months (owner, 2026-11-23)", () => {
  assert.equal(HOLDING_RETENTION_MONTHS, 12);
});

test("a whole request for the order's quantity is accepted and copied", () => {
  const q = parseHoldingRequest(GOOD, 2)!;
  assert.deepEqual(q, GOOD);
  assert.notEqual(q.holders, GOOD.holders, "a copy, not the caller's array");
});

test("anything else is refused whole", () => {
  const bad: Array<[unknown, number]> = [
    [null, 2],
    [[], 2],
    [{ ...GOOD, v: 2 }, 2],
    [GOOD, 1],
    [GOOD, 3],
    [GOOD, 0],
    [GOOD, 101],
    [{ ...GOOD, holders: GOOD.holders.slice(0, 1) }, 2],
    [{ ...GOOD, answerKeys: [...GOOD.answerKeys, GOOD.answerKeys[0]] }, 2],
    [{ ...GOOD, holders: [GOOD.holders[0], GOOD.holders[0]] }, 2],
    [{ ...GOOD, answerKeys: [GOOD.holders[0], GOOD.answerKeys[1]] }, 2],
    [{ ...GOOD, pickupSigner: GOOD.holders[1] }, 2],
    [{ ...GOOD, holders: [GOOD.holders[0]!.toUpperCase().replace("0X", "0x"), GOOD.holders[1]] }, 2],
    [{ ...GOOD, nkCommit: "0x12" }, 2],
    [{ ...GOOD, pickupId: `0x${GOOD.pickupId}` }, 2],
    [{ ...GOOD, pickupPub: GOOD.pickupPub.slice(2) }, 2],
    [{ ...GOOD, pickupPub: GOOD.pickupPub.toUpperCase() }, 2],
    [{ ...GOOD, sealedR: { ...SEALED, v: 1 } }, 2],
    [{ ...GOOD, sealedR: undefined }, 2],
  ];
  for (const [x, n] of bad) assert.equal(parseHoldingRequest(x, n), null, JSON.stringify(x)?.slice(0, 80));
});
