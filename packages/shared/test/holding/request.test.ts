/**
 * A signed-in buyer's checkout request (`src/holding/request.ts`): accepted only whole,
 * for exactly the order's quantity, with every key distinct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLDING_RETENTION_MONTHS, SEALED_SECRET_CT_HEX, parseHoldingRequest } from "../../src/holding/request.js";
import { holdingPublicValues } from "../../src/holding/derive.js";
import { R } from "./vectors.js";

const pv = holdingPublicValues(R, 2);
const SEALED = { v: 2, enc: "ab".repeat(1120), ct: "cd".repeat(48) };
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
  // Changing it strands every older box: the retention sweep accepts a holding record
  // only at exactly this period. A change needs a migration of the records first.
  assert.equal(HOLDING_RETENTION_MONTHS, 12);
});

test("a real sealed secret is exactly the length the parser takes", async () => {
  const { sealBox, holdingSecretSealContext } = await import("../../src/crypto/sealed-box.js");
  const { holdingPickupKem } = await import("../../src/holding/derive.js");
  const sealed = await sealBox(holdingPickupKem(new Uint8Array(32).fill(7)).publicKey, R, holdingSecretSealContext(pv.pickupId));
  assert.equal(sealed.ct.length, SEALED_SECRET_CT_HEX);
  assert.ok(parseHoldingRequest({ ...GOOD, sealedR: sealed }, 2));
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
    [{ ...GOOD, sealedR: { ...SEALED, ct: "cd".repeat(49) } }, 2],
    [{ ...GOOD, sealedR: { ...SEALED, ct: "cd".repeat(47) } }, 2],
    [{ ...GOOD, sealedR: { ...SEALED, ct: "cd".repeat(8_000_000) } }, 2],
    [{ ...GOOD, sealedR: undefined }, 2],
  ];
  for (const [x, n] of bad) assert.equal(parseHoldingRequest(x, n), null, JSON.stringify(x)?.slice(0, 80));
});
