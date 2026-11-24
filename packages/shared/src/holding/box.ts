/**
 * What a receipt box holds once opened: the signed receipts of one order.
 * Spec: woco-ops/spec-receipt-note-20261123.md section 3 (envelope) and 5.
 *
 * VERSIONED, not frozen: a later box version may add notes (the new contract) or drop
 * fields. Every hint here (WoCo event and series ids, edition) is untrusted: a verifier
 * trusts only what the signature covers, checked against the chain.
 */

import { HOLDING_MAX_TICKETS } from "./derive.js";
import type { HoldingTarget, TicketHolding } from "./receipt.js";

export const HOLDING_BOX_VERSION = 1;

export interface HoldingReceiptEnvelope extends TicketHolding {
  chainId: number;
  ledger: string;
  /** WoCo's event and series ids: hints, never trusted. */
  wocoEventId: string;
  seriesId: string;
  /** slot + 1, the number on the ticket. */
  edition: number;
  /** The one-time key's signature over the receipt (`signTicketHolding`). */
  sig: string;
}

export interface HoldingBoxV1 {
  v: 1;
  receipts: HoldingReceiptEnvelope[];
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const SIG_RE = /^0x[0-9a-f]{130}$/;
/** WoCo event and series ids: the rule the sealed-order contexts use (`crypto/sealed-box.ts`). */
const ID_RE = /^[0-9a-z-]{1,64}$/;

export function envelopeTarget(e: HoldingReceiptEnvelope): HoldingTarget {
  return { chainId: e.chainId, ledger: e.ledger };
}

function isEnvelope(x: unknown): x is HoldingReceiptEnvelope {
  const e = x as Partial<HoldingReceiptEnvelope> | null;
  return (
    !!e && typeof e === "object" &&
    Number.isSafeInteger(e.chainId) && (e.chainId as number) > 0 &&
    typeof e.ledger === "string" && ADDRESS_RE.test(e.ledger) &&
    typeof e.eventId === "string" && BYTES32_RE.test(e.eventId) &&
    Number.isSafeInteger(e.slot) && (e.slot as number) >= 0 &&
    e.edition === (e.slot as number) + 1 &&
    typeof e.holder === "string" && ADDRESS_RE.test(e.holder) &&
    typeof e.answerKey === "string" && ADDRESS_RE.test(e.answerKey) &&
    typeof e.nkCommit === "string" && BYTES32_RE.test(e.nkCommit) &&
    typeof e.wocoEventId === "string" && ID_RE.test(e.wocoEventId) &&
    typeof e.seriesId === "string" && ID_RE.test(e.seriesId) &&
    typeof e.sig === "string" && SIG_RE.test(e.sig)
  );
}

/** Exactly the known fields, in one order: whatever else an envelope carried is not kept. */
function envelopeOf(e: HoldingReceiptEnvelope): HoldingReceiptEnvelope {
  return {
    eventId: e.eventId,
    slot: e.slot,
    holder: e.holder,
    answerKey: e.answerKey,
    nkCommit: e.nkCommit,
    chainId: e.chainId,
    ledger: e.ledger,
    wocoEventId: e.wocoEventId,
    seriesId: e.seriesId,
    edition: e.edition,
    sig: e.sig,
  };
}

/**
 * A box, or null for anything else. Receipts of one order share chain, ledger, event,
 * nkCommit and WoCo's event and series hints, and have distinct slots: a box that mixes
 * orders is refused whole. Each envelope comes back REBUILT from its known fields, so
 * nothing else a box carried reaches a buyer's copy.
 */
export function parseHoldingBox(x: unknown): HoldingBoxV1 | null {
  const b = x as Partial<HoldingBoxV1> | null;
  if (!b || typeof b !== "object" || b.v !== HOLDING_BOX_VERSION || !Array.isArray(b.receipts)) return null;
  if (b.receipts.length < 1 || b.receipts.length > HOLDING_MAX_TICKETS) return null;
  if (!b.receipts.every(isEnvelope)) return null;
  const first = b.receipts[0]!;
  const slots = new Set<number>();
  for (const e of b.receipts) {
    if (e.chainId !== first.chainId || e.ledger !== first.ledger || e.eventId !== first.eventId || e.nkCommit !== first.nkCommit) return null;
    if (e.wocoEventId !== first.wocoEventId || e.seriesId !== first.seriesId) return null;
    if (slots.has(e.slot)) return null;
    slots.add(e.slot);
  }
  return { v: 1, receipts: b.receipts.map(envelopeOf) };
}
