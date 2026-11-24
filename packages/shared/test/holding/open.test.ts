/**
 * Opening a receipt box (`src/holding/open.ts`): the slice-1 review's carried rule -
 * receipt j, in ascending slot order, names holder_j and answer_j, every receipt the
 * order's nkCommit, every signature canonical - and a box failing any of it refused whole.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HoldingBoxRefusedError, checkHoldingBox, checkedHoldingBox, openHoldingBox } from "../../src/holding/open.js";
import { ticketHoldingDigest } from "../../src/holding/receipt.js";
import { holdingCopySealContext, sealBoxJson } from "../../src/crypto/sealed-box.js";
import { holdingPickupId, holdingPickupKem } from "../../src/holding/derive.js";
import type { HoldingBoxV1 } from "../../src/holding/box.js";
import { burnerFor, makeBox, sealFor } from "./box-fixture.js";
import { R, TARGET } from "./vectors.js";

const OTHER = new Uint8Array(32).fill(9);
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert.ok(e instanceof HoldingBoxRefusedError, String(e));
    return e.reason;
  }
  assert.fail("not refused");
}

function clone(box: HoldingBoxV1): HoldingBoxV1 {
  return JSON.parse(JSON.stringify(box)) as HoldingBoxV1;
}

test("a box made for this order opens, sorted by slot, with each signer and digest", async () => {
  const box = makeBox(R, 3);
  const shuffled = { v: 1 as const, receipts: [box.receipts[2]!, box.receipts[0]!, box.receipts[1]!] };
  const opened = await openHoldingBox(R, await sealFor(R, shuffled));
  assert.deepEqual(opened.box, box);
  assert.deepEqual(opened.receipts.map((c) => c.receipt.slot), [6, 7, 8]);
  for (const c of opened.receipts) {
    assert.equal(c.signer, new Wallet(`0x${bytesToHex(burnerFor(c.receipt.slot))}`).address.toLowerCase());
    const { eventId, slot, holder, answerKey, nkCommit } = c.receipt;
    assert.equal(c.digest, ticketHoldingDigest(TARGET, { eventId, slot, holder, answerKey, nkCommit }));
  }
});

test("checking never reorders the caller's box", () => {
  const box = makeBox(R, 3);
  const shuffled: HoldingBoxV1 = { v: 1, receipts: [box.receipts[1]!, box.receipts[0]!, box.receipts[2]!] };
  const before = JSON.stringify(shuffled);
  assert.equal(checkHoldingBox(R, shuffled).ok, true);
  assert.equal(JSON.stringify(shuffled), before);
});

test("only this order's secret opens it, under the box's own context", async () => {
  const sealed = await sealFor(R, makeBox(R, 2));
  assert.equal(await refusal(openHoldingBox(OTHER, sealed)), "unopenable");
  // The right key, the wrong use: the copy context.
  const asCopy = await sealBoxJson(holdingPickupKem(R).publicKey, makeBox(R, 2), holdingCopySealContext(holdingPickupId(R)));
  assert.equal(await refusal(openHoldingBox(R, asCopy)), "unopenable");
  assert.equal(await refusal(openHoldingBox(R, { v: 2, enc: "00", ct: "00" })), "unopenable");
  assert.equal(await refusal(openHoldingBox(R, null)), "unopenable");
});

test("opened but not a box this build reads", async () => {
  assert.equal(await refusal(openHoldingBox(R, await sealFor(R, { v: 2, receipts: makeBox(R, 1).receipts }))), "malformed");
  assert.equal(await refusal(openHoldingBox(R, await sealFor(R, { v: 1, receipts: [] }))), "malformed");
  assert.equal(await refusal(() => checkedHoldingBox(R, "box")), "malformed");
});

test("a box for ANOTHER order, sealed to this one's key, is refused", async () => {
  assert.equal(await refusal(openHoldingBox(R, await sealFor(R, makeBox(OTHER, 2)))), "not-this-order");
});

test("receipt j must name holder_j and answer_j: swaps, gaps and strays are refused", async () => {
  const good = makeBox(R, 3);

  const swappedHolders = clone(good);
  [swappedHolders.receipts[0]!.holder, swappedHolders.receipts[1]!.holder] = [good.receipts[1]!.holder, good.receipts[0]!.holder];
  assert.equal(await refusal(() => checkedHoldingBox(R, swappedHolders)), "not-this-order");

  const swappedAnswers = clone(good);
  [swappedAnswers.receipts[1]!.answerKey, swappedAnswers.receipts[2]!.answerKey] = [good.receipts[2]!.answerKey, good.receipts[1]!.answerKey];
  assert.equal(await refusal(() => checkedHoldingBox(R, swappedAnswers)), "not-this-order");

  // Position 1 missing: what was receipt 2 now sits at position 1 with holder_2.
  const gap: HoldingBoxV1 = { v: 1, receipts: [good.receipts[0]!, good.receipts[2]!] };
  assert.equal(await refusal(() => checkedHoldingBox(R, gap)), "not-this-order");

  // Slot order decides the position, not the order in the array: slots swapped, keys kept.
  const slotsSwapped = clone(good);
  slotsSwapped.receipts[0]!.slot = 7;
  slotsSwapped.receipts[0]!.edition = 8;
  slotsSwapped.receipts[1]!.slot = 6;
  slotsSwapped.receipts[1]!.edition = 7;
  assert.equal(await refusal(() => checkedHoldingBox(R, slotsSwapped)), "not-this-order");

  const strayAnswer = clone(good);
  strayAnswer.receipts[2]!.answerKey = `0x${"12".repeat(20)}`;
  assert.equal(await refusal(() => checkedHoldingBox(R, strayAnswer)), "not-this-order");
});

test("every receipt must carry the order's nkCommit", async () => {
  // The whole box under another order's value: parse refuses mixed values, so all change.
  const other = makeBox(OTHER, 1).receipts[0]!.nkCommit;
  const box = clone(makeBox(R, 2));
  for (const e of box.receipts) e.nkCommit = other;
  assert.equal(await refusal(() => checkedHoldingBox(R, box)), "not-this-order");
});

test("a signature that is not canonical is refused; a valid one over other values is not ours", async () => {
  const good = makeBox(R, 2);

  const highS = clone(good);
  const sig = highS.receipts[1]!.sig;
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130), 16);
  highS.receipts[1]!.sig = `${sig.slice(0, 66)}${(SECP256K1_N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
  assert.equal(await refusal(() => checkedHoldingBox(R, highS)), "bad-signature");

  const vZero = clone(good);
  vZero.receipts[0]!.sig = `${good.receipts[0]!.sig.slice(0, 130)}00`;
  assert.equal(await refusal(() => checkedHoldingBox(R, vZero)), "bad-signature");

  // A canonical signature recovers SOME address: opening keeps it as the signer, and the
  // chain check (the verifier, spec section 6) is what refuses a signer that never owned it.
  const otherSlotSig = clone(good);
  otherSlotSig.receipts[0]!.sig = good.receipts[1]!.sig;
  const checked = checkHoldingBox(R, otherSlotSig);
  assert.ok(checked.ok);
  assert.notEqual(checked.receipts[0]!.signer, new Wallet(`0x${bytesToHex(burnerFor(6))}`).address.toLowerCase());
});
