/**
 * A receipt box as fulfilment makes one (apps/server/src/lib/holding/keep.ts): one
 * receipt per minted slot, each signed by that slot's own one-time key, sealed to the
 * order's pickup key.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import type { HoldingBoxV1, HoldingReceiptEnvelope } from "../../src/holding/box.js";
import { holdingAnswerKey, holdingHolderKey, holdingNk, holdingNkCommit, holdingPickupId, holdingPickupKem } from "../../src/holding/derive.js";
import { signTicketHolding } from "../../src/holding/receipt.js";
import { holdingBoxSealContext, sealBoxJson } from "../../src/crypto/sealed-box.js";
import { EVENT_ID, TARGET } from "./vectors.js";

/** One-time key for slot `slot`: distinct per slot, never zero. */
export function burnerFor(slot: number): Uint8Array {
  return new Uint8Array(32).fill((slot % 200) + 7);
}

export function makeBox(r: Uint8Array, n: number, firstSlot = 6): HoldingBoxV1 {
  const nkCommit = holdingNkCommit(holdingNk(r));
  const receipts: HoldingReceiptEnvelope[] = [];
  for (let i = 0; i < n; i++) {
    const slot = firstSlot + i;
    const holding = { eventId: EVENT_ID, slot, holder: holdingHolderKey(r, i).address, answerKey: holdingAnswerKey(r, i).address, nkCommit };
    receipts.push({
      ...holding,
      chainId: TARGET.chainId,
      ledger: TARGET.ledger,
      wocoEventId: "evt-1",
      seriesId: "series-1",
      edition: slot + 1,
      sig: signTicketHolding(TARGET, holding, burnerFor(slot)),
    });
  }
  return { v: 1, receipts };
}

export function sealFor(r: Uint8Array, box: unknown) {
  return sealBoxJson(holdingPickupKem(r).publicKey, box, holdingBoxSealContext(holdingPickupId(r)));
}

export function hex(r: Uint8Array): string {
  return bytesToHex(r);
}
