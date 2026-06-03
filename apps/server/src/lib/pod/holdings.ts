// ---------------------------------------------------------------------------
// POD holdings reader — the chain half of the holdings primitive (§4.3/§4.4).
//
// Answers "what does wallet A hold of POD type M?" from the TRUSTLESS on-chain
// source (WoCoEventV2 slot ownership), NOT the platform-written collection feed.
// The pure `evaluatePodGate` (shared) then decides pass/fail against a rule.
//
// Built ONCE here; reused by event gating, product gating, and milestone
// eligibility. Gating is a WoCoEventV2 feature (the `dropGate` slot is V2-only),
// so this reader requires the active deployment on `chainId` to be V2.
// ---------------------------------------------------------------------------

import type { Hex0x, Bytes32Hex, PodHolding } from "@woco/shared";
import { getDeployedContract } from "../chain/event-contract.js";
import { querySlotsOwnedV2 } from "../chain/event-contract-v2.js";

export interface HoldingQuery {
  /** Wallet whose holdings to read (lowercased by the reader). */
  holder: Hex0x;
  /** On-chain eventId (0x bytes32) that committed `manifestRef`. */
  onChainEventId: string;
  /** Chain the event lives on. */
  chainId: number;
  /** POD-type identity to stamp on the returned holding (the gate keys on it). */
  manifestRef: Bytes32Hex;
}

/**
 * Read `holder`'s on-chain holding of one POD type. Returns a zero-count
 * holding (never throws) when the holder owns nothing — only configuration
 * problems (no V2 contract on the chain) throw, since those are caller bugs.
 */
export async function getOnChainHolding(q: HoldingQuery): Promise<PodHolding> {
  const c = getDeployedContract(q.chainId);
  if (!c) throw new Error(`POD holdings: no WoCoEvent contract deployed on chain ${q.chainId}`);
  if (c.version !== "v2") {
    throw new Error(
      `POD holdings/gating require WoCoEventV2; chain ${q.chainId} is on ${c.version}`,
    );
  }

  const slots = await querySlotsOwnedV2(
    q.onChainEventId,
    q.holder.toLowerCase(),
    c.address,
    q.chainId,
  );

  return { manifestRef: q.manifestRef, count: slots.length, slots };
}
