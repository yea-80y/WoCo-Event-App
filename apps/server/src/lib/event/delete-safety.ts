import type { SeriesSummary } from "@woco/shared";
import { getActiveChainId, getOnChainEvent } from "../chain/event-contract.js";
import { lookupOnChainEventId } from "./onchain-registry.js";
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
  /** The server's OWN registration record — see the `assertNoOrders` note (#435). */
  lookupOnChainEventId: typeof lookupOnChainEventId;
}

const defaultDeps: DeleteSafetyDeps = { getOnChainEvent, getActiveChainId, heldFor, lookupOnChainEventId };

/**
 * Refuse deletion unless every series' ticket count is VERIFIED zero: on-chain
 * claims and live buyer reservations. Fail-closed — if any count cannot be
 * verified, throw rather than risk orphaning paid tickets. The distinction that
 * decides it: a chain read that THROWS (RPC outage) refuses with a retryable
 * error, while `null` (contract reverted EventNotFound — nothing can ever have
 * minted) is a verified zero and allows.
 *
 * WHICH ON-CHAIN EVENT IS COUNTED (#435). The server's OWN record, via
 * `lookupOnChainEventId` — NEVER `s.onChainEventId` off the feed. For a Phase B
 * event that feed is the creator's client-signed SOC, so its id is input, not
 * state: pointing a sold-out series at an empty on-chain event makes this count
 * read zero and hands the creator a delete on an event with paid tickets. That is
 * the sharpest consumer of the #435 defect, and it is the one place a strip
 * upstream is not enough on its own, because the strip can only fire on ids it
 * can attribute.
 *
 * A series carrying a feed id the server has NO record for therefore counts as
 * having no verifiable on-chain event, and BLOCKS. That is the safe direction and
 * the only one available: the count exists to protect paid tickets, so an
 * unverifiable count must refuse, exactly as a thrown chain read does. The cost
 * of being wrong is asymmetric and not close — a wrongly-blocked delete is an
 * organiser asking support to remove an event, a wrongly-allowed one is a buyer
 * holding a ticket to an event that no longer exists.
 */
export async function assertNoOrders(
  eventId: string,
  series: SeriesSummary[],
  deps: DeleteSafetyDeps = defaultDeps,
): Promise<void> {
  const blockers: string[] = [];
  for (const s of series) {
    // The contract is the only ticket ledger. A series the SERVER has no
    // registration record for has no count to verify ANYWHERE — there is nothing
    // to substitute, so it fails closed: refuse rather than read "cannot verify"
    // as zero. A feed that carries an id the server never recorded lands here
    // too, on purpose (#435). (A registered-but-EventNotFound series reads null,
    // which IS a verified zero — nothing can have minted; transport failures
    // throw, per getOnChainEventV2.)
    const recorded = deps.lookupOnChainEventId(eventId, s.seriesId);
    if (!recorded) {
      blockers.push(`"${s.name}": series has no on-chain record — ticket count cannot be verified`);
      continue;
    }
    let claimed: number;
    try {
      const onChain = await deps.getOnChainEvent(recorded, deps.getActiveChainId());
      // nextSlot = slots ever allocated (refunds flag, never free, slots) —
      // overcounting after refunds is the safe direction for delete-safety.
      claimed = onChain ? Number(onChain.nextSlot) : 0;
    } catch (err) {
      console.error(`[event] delete order-check failed for series ${s.seriesId}:`, err);
      throw new Error("Could not verify order status — try again");
    }
    if (claimed > 0) blockers.push(`"${s.name}": ${claimed} ticket(s) issued`);

    const held = deps.heldFor(eventId, s.seriesId);
    if (held > 0) blockers.push(`"${s.name}": ${held} seat(s) currently held by buyers`);
  }
  if (blockers.length > 0) throw new DeleteBlockedError(blockers);
}
