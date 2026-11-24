/**
 * The chain reads behind each receipt record's own clock (`sweepHoldingsDue`, spec
 * 13a item 4). The end is read on the registration the receipts were signed against,
 * the same record and contract the order-retention sweep reads; a record naming any
 * other ledger is kept, never guessed.
 */

import { chainTimeMs, contractKey } from "../chain/event-contract.js";
import { chainEventEndMsAt } from "../event/end-date-guard.js";
import { registrationContractFor } from "../event/onchain-registry.js";
import { sweepHoldingsDue, type HoldingDueDeps } from "./store.js";

export const liveHoldingDueDeps: HoldingDueDeps = {
  chainEnd: async (r) => {
    const contract = registrationContractFor(r.eventId, r.seriesId);
    if (!contract || contractKey(contract) !== `${r.issued.chainId}:${r.issued.ledger.toLowerCase()}`) return null;
    return chainEventEndMsAt(contract, r.issued.onChainEventId);
  },
  chainNow: chainTimeMs,
  now: () => Date.now(),
};

export function runHoldingDueSweep(): Promise<{ removed: number; endUnknown: number }> {
  return sweepHoldingsDue(liveHoldingDueDeps);
}
