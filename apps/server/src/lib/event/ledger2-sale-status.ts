/**
 * A ledger2 registration's cutoff and cancellation, read FRESH on the sale path
 * (reserve, create-checkout). On ledger2 the organiser can extend the cutoff and
 * cancel by signature through ANY relay, not only ours, so neither is remembered
 * here (Fable design consult 2026-11-02, #995).
 *
 * A chain cancellation the server's own record does not have is refused at the sale
 * and raised on `/api/health` (`ledger2Relay.chainCancelledUnrecorded`) - never
 * written into the money path's record from a chain read: refunding everyone is the
 * organiser's confirmation to give (the dashboard's "Confirm cancellation").
 */

import type { EventContractTarget } from "../chain/event-contract.js";
import { getEventStatusLedger } from "../chain/event-contract-ledger.js";

export interface SaleStatus {
  endMs: number;
  cancelled: boolean;
}

/** Null for a registration not on ledger2, or one the ledger does not know. Throws on transport failure. */
export async function ledger2SaleStatus(contract: EventContractTarget, onChainEventId: string): Promise<SaleStatus | null> {
  if (contract.version !== "ledger2") return null;
  const s = await getEventStatusLedger(onChainEventId, contract.address, contract.chainId);
  return s ? { endMs: s.eventEndTs * 1000, cancelled: s.cancelled } : null;
}

const MAX_NOTED = 100;
/** `${eventId}\0${onChainEventId}` -> first seen, insertion-ordered. */
const noted = new Map<string, { eventId: string; onChainEventId: string; seenAt: number }>();

/** The sale path met a cancellation on chain for an event the server still sells. */
export function noteChainCancelled(eventId: string, onChainEventId: string, now: number = Date.now()): void {
  const k = `${eventId}\u0000${onChainEventId.toLowerCase()}`;
  if (noted.has(k)) return;
  if (noted.size >= MAX_NOTED) noted.delete(noted.keys().next().value!);
  noted.set(k, { eventId, onChainEventId: onChainEventId.toLowerCase(), seenAt: now });
  console.warn(
    `[ledger2] event ${eventId} is cancelled ON CHAIN (${onChainEventId}) but not in the server's record: ` +
      "sales refused; the organiser confirms the cancellation from the dashboard",
  );
}

/**
 * Those the server's record has not confirmed. Only a CONFIRMED cancellation clears an
 * entry: while the record is unreadable ("unknown") nothing is known to be resolved.
 */
export function chainCancelledUnrecorded(
  gateOf: (eventId: string) => "open" | "cancelled" | "unknown",
): Array<{ eventId: string; onChainEventId: string; seenAt: string }> {
  const out: Array<{ eventId: string; onChainEventId: string; seenAt: string }> = [];
  for (const [k, v] of noted) {
    if (gateOf(v.eventId) === "cancelled") {
      noted.delete(k);
      continue;
    }
    out.push({ eventId: v.eventId, onChainEventId: v.onChainEventId, seenAt: new Date(v.seenAt).toISOString() });
  }
  return out;
}

/** Tests only. */
export function _resetChainCancelledForTests(): void {
  noted.clear();
}
