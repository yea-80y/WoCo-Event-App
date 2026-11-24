/**
 * Opening a receipt box, and checking it is THIS order's before anything keeps it.
 * Spec: woco-ops/spec-receipt-note-20261123.md sections 3 and 5; the rule is Fable's
 * carried note from the slice-1 review (section 11a).
 *
 * The box is sealed to the order's pickup key, so only the holder of the secret `r`
 * opens it. Opening proves nothing about its contents, though: the server sealed them.
 * So each receipt is checked against what `r` derives - receipt j, in ascending slot
 * order, must name holder_j and answer_j, every receipt the order's nkCommit, and each
 * signature must be canonical. A box that fails any of it is refused WHOLE: keeping
 * some receipts of a wrong box would hand the buyer a proof for keys they do not hold.
 *
 * What this does NOT check: that the signer owned the slot on chain. That is the
 * verifier's job (section 6), done when a receipt is shown, against a fresh read.
 *
 * Import by subpath and, in the browser, lazily: opening loads the lattice code.
 */

import { holdingBoxSealContext, openBoxJson } from "../crypto/sealed-box.js";
import type { Hex0x } from "../types.js";
import { envelopeTarget, parseHoldingBox, type HoldingBoxV1, type HoldingReceiptEnvelope } from "./box.js";
import { holdingAnswerKey, holdingHolderKey, holdingNk, holdingNkCommit, holdingPickupId, holdingPickupKem } from "./derive.js";
import { recoverTicketHoldingSigner, ticketHoldingDigest } from "./receipt.js";

export type HoldingBoxRefusal =
  /** Not sealed to this order's key, or not a sealed box at all. */
  | "unopenable"
  /** Opened, but not a box this build reads. */
  | "malformed"
  /** A receipt names keys or a count-once value this secret does not give. */
  | "not-this-order"
  /** A signature that is not canonical (low-s, v 27/28). */
  | "bad-signature";

export class HoldingBoxRefusedError extends Error {
  constructor(readonly reason: HoldingBoxRefusal) {
    super(`receipt box refused: ${reason}`);
    this.name = "HoldingBoxRefusedError";
  }
}

export interface CheckedReceipt {
  receipt: HoldingReceiptEnvelope;
  /** The one-time key that signed it: the slot's owner at the sale, if WoCo was honest. */
  signer: string;
  /** The `TicketHolding` EIP-712 digest: what a presentation and the void list name. */
  digest: Hex0x;
}

/**
 * The box's receipts checked against `r`, sorted by slot. The returned box holds them
 * in that order, so two opens of the same box compare equal.
 */
export function checkHoldingBox(
  r: Uint8Array,
  box: HoldingBoxV1,
): { ok: true; box: HoldingBoxV1; receipts: CheckedReceipt[] } | { ok: false; reason: HoldingBoxRefusal } {
  // Copied before sorting: the caller's box is never reordered under it.
  const sorted = [...box.receipts].sort((a, b) => a.slot - b.slot);
  const nkCommit = holdingNkCommit(holdingNk(r));
  const receipts: CheckedReceipt[] = [];
  for (let j = 0; j < sorted.length; j++) {
    const e = sorted[j]!;
    if (e.nkCommit !== nkCommit) return { ok: false, reason: "not-this-order" };
    if (e.holder !== holdingHolderKey(r, j).address) return { ok: false, reason: "not-this-order" };
    if (e.answerKey !== holdingAnswerKey(r, j).address) return { ok: false, reason: "not-this-order" };
    const holding = { eventId: e.eventId, slot: e.slot, holder: e.holder, answerKey: e.answerKey, nkCommit: e.nkCommit };
    const target = envelopeTarget(e);
    const signer = recoverTicketHoldingSigner(target, holding, e.sig);
    if (signer === null) return { ok: false, reason: "bad-signature" };
    receipts.push({ receipt: e, signer, digest: ticketHoldingDigest(target, holding) });
  }
  return { ok: true, box: { v: 1, receipts: sorted }, receipts };
}

/** A box as it parses and checks, or a throw naming why not. */
export function checkedHoldingBox(r: Uint8Array, x: unknown): { box: HoldingBoxV1; receipts: CheckedReceipt[] } {
  const box = parseHoldingBox(x);
  if (!box) throw new HoldingBoxRefusedError("malformed");
  const checked = checkHoldingBox(r, box);
  if (!checked.ok) throw new HoldingBoxRefusedError(checked.reason);
  return { box: checked.box, receipts: checked.receipts };
}

/** Open the sealed box the server made for this order, and check it. Throws `HoldingBoxRefusedError`. */
export async function openHoldingBox(r: Uint8Array, sealed: unknown): Promise<{ box: HoldingBoxV1; receipts: CheckedReceipt[] }> {
  let opened: unknown;
  try {
    opened = await openBoxJson(holdingPickupKem(r).secretKey, sealed, holdingBoxSealContext(holdingPickupId(r)));
  } catch {
    throw new HoldingBoxRefusedError("unopenable");
  }
  return checkedHoldingBox(r, opened);
}
