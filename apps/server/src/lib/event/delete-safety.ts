import type { SeriesSummary } from "@woco/shared";
import { getActiveChainId, getOnChainEvent } from "../chain/event-contract.js";
import { heldFor } from "./reservation-store.js";

/** Thrown when a delete is blocked by existing tickets/holds; `blockers` lists
 *  the human-readable reasons per series. Mapped to HTTP 409 by the route. */
export class DeleteBlockedError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(`Event has existing orders — cannot delete. ${blockers.join("; ")}`);
    this.name = "DeleteBlockedError";
    this.blockers = blockers;
  }
}

/** Injectable so tests can pin the fail-closed contract (#243) — the chain read
 *  is otherwise unreachable: the client pre-disables delete whenever orders
 *  exist, so nothing exercises these branches in practice. */
export interface DeleteSafetyDeps {
  getOnChainEvent: typeof getOnChainEvent;
  getActiveChainId: typeof getActiveChainId;
  heldFor: typeof heldFor;
}

const defaultDeps: DeleteSafetyDeps = { getOnChainEvent, getActiveChainId, heldFor };

/**
 * Refuse deletion unless every series' ticket count is VERIFIED zero: on-chain
 * claims and live buyer reservations. Fail-closed — if any count cannot be
 * verified, throw rather than risk orphaning paid tickets. The distinction that
 * decides it: a chain read that THROWS (RPC outage) refuses with a retryable
 * error, while `null` (contract reverted EventNotFound — nothing can ever have
 * minted) is a verified zero and allows.
 */
export async function assertNoOrders(
  series: SeriesSummary[],
  deps: DeleteSafetyDeps = defaultDeps,
): Promise<void> {
  const blockers: string[] = [];
  for (const s of series) {
    // The contract is the only ticket ledger. A series with no on-chain
    // record has no count to verify ANYWHERE — there is nothing to
    // substitute, so it fails closed: refuse rather than read "cannot
    // verify" as zero. (A registered-but-EventNotFound series reads null,
    // which IS a verified zero — nothing can have minted; transport
    // failures throw, per getOnChainEventV2.)
    if (!s.onChainEventId) {
      blockers.push(`"${s.name}": series has no on-chain record — ticket count cannot be verified`);
      continue;
    }
    let claimed: number;
    try {
      const onChain = await deps.getOnChainEvent(s.onChainEventId, deps.getActiveChainId());
      // nextSlot = slots ever allocated (refunds flag, never free, slots) —
      // overcounting after refunds is the safe direction for delete-safety.
      claimed = onChain ? Number(onChain.nextSlot) : 0;
    } catch (err) {
      console.error(`[event] delete order-check failed for series ${s.seriesId}:`, err);
      throw new Error("Could not verify order status — try again");
    }
    if (claimed > 0) blockers.push(`"${s.name}": ${claimed} ticket(s) issued`);

    const held = deps.heldFor(s.seriesId);
    if (held > 0) blockers.push(`"${s.name}": ${held} seat(s) currently held by buyers`);
  }
  if (blockers.length > 0) throw new DeleteBlockedError(blockers);
}
