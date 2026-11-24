/**
 * The chain reads behind each receipt record's own clock (`sweepHoldingsDue`, spec
 * 13a item 4). The end is read for the record's OWN chain, ledger and on-chain event:
 * what its receipts are signed over. The registration record only supplies the
 * contract version; when it is missing or names another contract (a lost or re-pointed
 * `onchain-events.json` entry), the version is ledger2, the only one receipts are
 * issued on (`planHolding`), so such a record is still deleted on time, never kept for
 * good. Store the version in the record before receipts are issued on a v3 contract.
 */

import { chainTimeMs, contractKey } from "../chain/event-contract.js";
import { chainEventEndMsAt } from "../event/end-date-guard.js";
import { registrationContractFor } from "../event/onchain-registry.js";
import { sweepHoldingsDue, type HoldingDueDeps } from "./store.js";

export const liveHoldingDueDeps: HoldingDueDeps = {
  chainEnd: async (r) => {
    const own = { chainId: r.issued.chainId, address: r.issued.ledger.toLowerCase() };
    const reg = registrationContractFor(r.eventId, r.seriesId);
    const version = reg && contractKey(reg) === contractKey({ ...own, version: reg.version }) ? reg.version : "ledger2";
    return chainEventEndMsAt({ ...own, version }, r.issued.onChainEventId);
  },
  chainNow: chainTimeMs,
  now: () => Date.now(),
};

export function runHoldingDueSweep(): Promise<{ removed: number; endUnknown: number }> {
  return sweepHoldingsDue(liveHoldingDueDeps);
}
