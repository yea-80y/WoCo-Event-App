/**
 * Resolving a HASH-LESS pending-registration marker (#318).
 *
 * A marker without a `txHash` means the process journalled its intent to
 * broadcast `registerEvent` at a reserved nonce and then died before the
 * broadcast could be proven — almost always BEFORE the tx ever left the
 * process (the intent write and the hash upgrade are milliseconds apart).
 * The next attempt must decide: did that registration happen?
 *
 * `registerEvent` is not idempotent (the contract mints a fresh event id per
 * call), so the ladder is ordered to make "re-send" a PROVEN answer, never a
 * guess:
 *
 *  1. Did a registration for this manifest ever land? The full sponsor
 *     registration walk answers definitively — found means ADOPT it. The walk
 *     THROWING means nothing can be decided this attempt; the caller surfaces
 *     the error and the organiser retries.
 *  2. Was the reserved nonce slot consumed on chain (`latest > nonce`)? Nonces
 *     mine strictly in order, so a consumed slot plus step 1's "absent" proves
 *     the slot went to some OTHER sponsor tx — our registration never mined
 *     and never can (a mined-but-reverted registerEvent also registers
 *     nothing). Safe to re-send.
 *  3. Is anything visible in the mempool at or beyond the slot
 *     (`pendingCount > nonce`)? Then a tx MAY still mine there — refuse and
 *     come back; on an L2 this window is seconds.
 *  4. Otherwise nothing on chain and nothing in the visible mempool holds the
 *     slot: the tx was never broadcast (the common crash) or was dropped.
 *     Safe to re-send.
 *
 * RESIDUAL, documented rather than solved: a broadcast that reached only a
 * mempool our RPC cannot see would read as step 4 and be re-sent, minting
 * twice if the ghost later mines. That needs a crash inside the milliseconds
 * between the intent write and the hash write, AND a partitioned mempool view
 * — strictly rarer than the unjournalled-broadcast hole this replaces, which
 * needed only the disk fault.
 */

import type { PendingRegistration } from "./onchain-registry.js";
import { findOnChainEventIdByManifestRef as realFindByManifestRef } from "./onchain-registry.js";

export type IntentResolution =
  /** The registration LANDED — adopt this id, never re-send. */
  | { status: "registered"; onChainEventId: string }
  /** Proven never-registered and provably not in flight — a fresh send is safe. */
  | { status: "resend" }
  /** A tx may still be in flight at the reserved nonce — refuse, retry later. */
  | { status: "pending" };

/** Seams for tests — both touch the chain. */
export interface IntentDeps {
  /** Definitive manifest lookup — throws when the chain walk fails (never "absent by default"). */
  findByManifestRef: typeof realFindByManifestRef;
  /** Sponsor account's mined ("latest") and mempool-inclusive ("pending") tx counts. */
  getSponsorTxCounts: () => Promise<{ latest: number; pendingCount: number }>;
}

async function realGetSponsorTxCounts(): Promise<{ latest: number; pendingCount: number }> {
  const [{ getSponsorAddress }, { getActiveChainId, getChainRpcUrl }, { JsonRpcProvider }] =
    await Promise.all([
      import("../chain/sponsor-wallet.js"),
      import("../chain/event-contract.js"),
      import("ethers"),
    ]);
  const address = getSponsorAddress();
  // A throwaway provider is fine here: this runs only while resolving a
  // crash-orphaned intent marker — a rare recovery path, never a hot one.
  const provider = new JsonRpcProvider(getChainRpcUrl(getActiveChainId()));
  const [latest, pendingCount] = await Promise.all([
    provider.getTransactionCount(address, "latest"),
    provider.getTransactionCount(address, "pending"),
  ]);
  return { latest, pendingCount };
}

export const defaultIntentDeps: IntentDeps = {
  findByManifestRef: realFindByManifestRef,
  getSponsorTxCounts: realGetSponsorTxCounts,
};

export async function resolveRegistrationIntent(
  marker: Pick<PendingRegistration, "nonce">,
  manifestRef: string,
  deps: IntentDeps = defaultIntentDeps,
): Promise<IntentResolution> {
  // Step 1 — the positive proof outranks every nonce inference. Throws propagate.
  const onChainEventId = await deps.findByManifestRef(manifestRef);
  if (onChainEventId) return { status: "registered", onChainEventId };

  const { latest, pendingCount } = await deps.getSponsorTxCounts();

  // Step 2 — slot consumed by something that (per step 1) was not our
  // registration. Our tx can never mine at it.
  if (latest > marker.nonce) return { status: "resend" };

  // Step 3 — something occupies the slot in the visible mempool.
  if (pendingCount > marker.nonce) return { status: "pending" };

  // Step 4 — slot untouched everywhere we can see.
  return { status: "resend" };
}
