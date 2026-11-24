/**
 * Collecting and erasing a receipt (`src/holding/pickup.ts`), the receipt seal
 * contexts (`src/crypto/sealed-box.ts`) and the box format (`src/holding/box.ts`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedDataEncoder, hashMessage } from "ethers";
import {
  HOLDING_ERASE_WINDOW_SECS,
  checkErasePickup,
  erasePickupDigest,
  erasePickupStatement,
  holdingKeepFragment,
  parseHoldingKeepFragment,
  signErasePickup,
} from "../../src/holding/pickup.js";
import { holdingPickupSigner } from "../../src/holding/derive.js";
import {
  HOLDING_BOX_SEAL_INFO,
  HOLDING_COPY_SEAL_INFO,
  HOLDING_SECRET_SEAL_INFO,
  holdingBoxSealContext,
  holdingCopySealContext,
  holdingSecretSealContext,
} from "../../src/crypto/sealed-box.js";
import { parseHoldingBox } from "../../src/holding/box.js";
import { buildTicketCanonicalMessage } from "../../src/ticket/canonical.js";
import { EVENT_ID, G, HOLDING, R, SLOT, T0, TARGET } from "./vectors.js";

const ROOT = "ef".repeat(32);

test("keep link: golden, and it round-trips", () => {
  assert.equal(holdingKeepFragment(R, ROOT), G.keep);
  assert.deepEqual(parseHoldingKeepFragment(G.keep), { r: R, boxRoot: ROOT });
  const noRoot = holdingKeepFragment(R);
  assert.deepEqual(parseHoldingKeepFragment(noRoot), { r: R });
  assert.throws(() => holdingKeepFragment(R.slice(1)));
  assert.throws(() => holdingKeepFragment(R, ROOT.toUpperCase()));
});

test("keep link: anything malformed is refused", () => {
  const k = G.keep.split("&")[0]!.split("k=")[1]!;
  for (const bad of [
    "",
    "#/other?k=" + k,
    "#/keep",
    "#/keep?b=" + ROOT,
    "#/keep?k=" + k.slice(1),
    "#/keep?k=" + k + "=",
    "#/keep?k=" + k + "&b=" + ROOT.slice(1),
    "#/keep?k=" + k + "&b=" + ROOT.toUpperCase(),
    "#/keep?k=" + k + "&x=1",
    "#/keep?k=" + k + "&k=" + k,
    "#/keep?k=" + k + "&b=" + ROOT + "&b=" + ROOT,
    "#/keep?k=" + k.slice(0, -1) + "B",
  ]) {
    assert.equal(parseHoldingKeepFragment(bad), null, bad);
  }
});

test("erase: golden, equal to ethers, and checked by signer, pickup id and window", () => {
  const s = erasePickupStatement(G.pickupId, T0);
  assert.deepEqual(s.domain, { name: "WoCo Holding Pickup", version: "1" });
  assert.equal(TypedDataEncoder.hash(s.domain, { ErasePickup: [...s.fields] }, s.message), G.eraseDigest);
  assert.equal(erasePickupDigest(G.pickupId, T0), G.eraseDigest);
  const sig = signErasePickup(G.pickupId, T0, holdingPickupSigner(R).privateKey);
  assert.equal(sig, G.eraseSig);
  assert.equal(HOLDING_ERASE_WINDOW_SECS, 5 * 60);
  const base = { pickupId: G.pickupId, issuedAt: T0, signature: sig, expectedSigner: G.pickupSigner, nowSecs: T0 };
  assert.equal(checkErasePickup(base), true);
  assert.equal(checkErasePickup({ ...base, nowSecs: T0 + HOLDING_ERASE_WINDOW_SECS }), true);
  assert.equal(checkErasePickup({ ...base, nowSecs: T0 - HOLDING_ERASE_WINDOW_SECS }), true);
  assert.equal(checkErasePickup({ ...base, nowSecs: T0 + HOLDING_ERASE_WINDOW_SECS + 1 }), false);
  assert.equal(checkErasePickup({ ...base, nowSecs: T0 - HOLDING_ERASE_WINDOW_SECS - 1 }), false);
  assert.equal(checkErasePickup({ ...base, expectedSigner: `0x${"33".repeat(20)}` }), false);
  assert.equal(checkErasePickup({ ...base, pickupId: "00".repeat(32) }), false);
  assert.equal(checkErasePickup({ ...base, issuedAt: T0 + 1, nowSecs: T0 + 1 }), false);
  assert.equal(checkErasePickup({ ...base, pickupId: "not-hex" }), false);
  assert.throws(() => erasePickupStatement(G.pickupId.toUpperCase(), T0));
});

test("an erase can never pass as a door QR or a receipt", () => {
  const door = hashMessage(buildTicketCanonicalMessage({ onChainEventId: EVENT_ID, seriesId: "series-1", edition: SLOT + 1 }));
  assert.equal(new Set([door, G.receiptDigest, G.eraseDigest, G.presentationDigest]).size, 4);
});

test("seal contexts: three distinct FROZEN labels, bound to the pickup id", () => {
  assert.equal(HOLDING_SECRET_SEAL_INFO, "woco/holding/v1/secret");
  assert.equal(HOLDING_BOX_SEAL_INFO, "woco/holding/v1/box");
  assert.equal(HOLDING_COPY_SEAL_INFO, "woco/holding/v1/copy");
  assert.equal(new Set([HOLDING_SECRET_SEAL_INFO, HOLDING_BOX_SEAL_INFO, HOLDING_COPY_SEAL_INFO]).size, 3);
  for (const [ctx, info] of [
    [holdingSecretSealContext, HOLDING_SECRET_SEAL_INFO],
    [holdingBoxSealContext, HOLDING_BOX_SEAL_INFO],
    [holdingCopySealContext, HOLDING_COPY_SEAL_INFO],
  ] as const) {
    const c = ctx(G.pickupId);
    assert.equal(c.info, info);
    assert.equal(c.aad, `${info}:${G.pickupId}`);
    assert.throws(() => ctx(G.pickupId.toUpperCase()));
    assert.throws(() => ctx(G.pickupId.slice(1)));
  }
});

test("box: a well-formed order is accepted, a mixed or malformed one refused whole", () => {
  const env = {
    ...HOLDING,
    chainId: TARGET.chainId,
    ledger: TARGET.ledger,
    wocoEventId: "event-1",
    seriesId: "series-1",
    edition: SLOT + 1,
    sig: G.receiptSig,
  };
  const second = { ...env, slot: SLOT + 1, edition: SLOT + 2, holder: G.holders[1]!, answerKey: G.answerKeys[1]! };
  assert.ok(parseHoldingBox({ v: 1, receipts: [env, second] }));
  for (const bad of [
    null,
    { v: 2, receipts: [env] },
    { v: 1, receipts: [] },
    { v: 1, receipts: new Array(101).fill(env) },
    { v: 1, receipts: [env, { ...second, nkCommit: `0x${"00".repeat(32)}` }] },
    { v: 1, receipts: [env, { ...second, chainId: 8453 }] },
    { v: 1, receipts: [env, { ...second, eventId: `0x${"cd".repeat(32)}` }] },
    { v: 1, receipts: [env, { ...second, ledger: `0x${"00".repeat(20)}` }] },
    { v: 1, receipts: [env, { ...env }] },
    { v: 1, receipts: [{ ...env, edition: SLOT }] },
    { v: 1, receipts: [{ ...env, sig: G.receiptSig.slice(0, -2) }] },
    { v: 1, receipts: [{ ...env, wocoEventId: "Event:1" }] },
    { v: 1, receipts: [{ ...env, holder: "0x12" }] },
  ]) {
    assert.equal(parseHoldingBox(bad), null);
  }
});
