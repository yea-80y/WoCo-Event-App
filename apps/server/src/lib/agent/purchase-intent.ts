/**
 * Agent purchase intents — bind a settlement draw to a specific, fresh purchase.
 *
 * WHY: /api/agent/buy verifies an on-chain USDC Transfer (from = userKernel, to =
 * organiser, exact amount). Without a binding, ANY first-seen matching transfer —
 * one the organiser received for unrelated reasons, or a fresh draw observed
 * on-chain — could be replayed to mint a ticket. The global txHash one-shot only
 * stops reusing the SAME tx twice; it does not stop binding an arbitrary matching
 * transfer. Mirrors the events crypto rail's signed-quote/claimerProof binding,
 * adapted to a rail where the transfer carries no memo.
 *
 * The intent is issued at /quote (or the /buy 402 step) and consumed one-shot at
 * settle. Settle additionally requires the draw's block timestamp to be AFTER the
 * intent was issued — so pre-existing transfers (which predate any intent) can
 * never satisfy it. In-memory + TTL: an intent that doesn't settle simply expires
 * (a restart drops open intents, which only forces a fresh /quote — fail-safe).
 */

import { randomUUID } from "node:crypto";

/** Intents live long enough to grant + draw + settle, not longer. */
const INTENT_TTL_MS = 15 * 60 * 1000;

interface PurchaseIntent {
  intentId: string;
  eventId: string;
  seriesId: string;
  amountAtomic: string;
  organiser: string; // lowercased
  issuedAt: number; // unix seconds — the freshness floor for the draw
  expiresAt: number; // unix ms
}

const intents = new Map<string, PurchaseIntent>();

function sweep(now: number): void {
  for (const [id, it] of intents) if (it.expiresAt <= now) intents.delete(id);
}

export interface IssuedIntent {
  intentId: string;
  /** Unix seconds — the draw's block timestamp must be at or after this. */
  issuedAt: number;
}

/** Issue a one-time intent for a specific purchase. */
export function issuePurchaseIntent(args: {
  eventId: string;
  seriesId: string;
  amountAtomic: string;
  organiser: string;
}): IssuedIntent {
  const nowMs = Date.now();
  sweep(nowMs);
  const issuedAt = Math.floor(nowMs / 1000);
  const intentId = randomUUID();
  intents.set(intentId, {
    intentId,
    eventId: args.eventId,
    seriesId: args.seriesId,
    amountAtomic: args.amountAtomic,
    organiser: args.organiser.toLowerCase(),
    issuedAt,
    expiresAt: nowMs + INTENT_TTL_MS,
  });
  return { intentId, issuedAt };
}

export type PeekResult =
  | { ok: true; issuedAt: number }
  | { ok: false; error: string };

/**
 * Validate (without consuming) that an intent was issued for EXACTLY this
 * purchase and is unexpired; return its `issuedAt` freshness floor. The caller
 * settles first, then calls `deletePurchaseIntent` on success — so a transient
 * settle failure (e.g. a slow-confirming draw) can be retried against the SAME
 * intent rather than being orphaned by a premature consume.
 */
export function peekPurchaseIntent(
  intentId: string,
  expected: { eventId: string; seriesId: string; amountAtomic: string; organiser: string },
): PeekResult {
  const nowMs = Date.now();
  sweep(nowMs);
  const it = intents.get(intentId);
  if (!it) return { ok: false, error: "Purchase intent not found or expired — request a fresh quote" };
  if (
    it.eventId !== expected.eventId ||
    it.seriesId !== expected.seriesId ||
    it.amountAtomic !== expected.amountAtomic ||
    it.organiser !== expected.organiser.toLowerCase()
  ) {
    return { ok: false, error: "Purchase intent does not match this order" };
  }
  return { ok: true, issuedAt: it.issuedAt };
}

/** Burn an intent one-shot after a successful settlement. */
export function deletePurchaseIntent(intentId: string): void {
  intents.delete(intentId);
}
