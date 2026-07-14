/**
 * Exactly-once on-chain registration for a ticket series.
 *
 * `WoCoEventV2.registerEvent` is NOT idempotent: it derives the event id from a
 * sponsor-nonce counter (`keccak256(abi.encode(msg.sender, organiserNonce[msg.sender]++))`,
 * WoCoEventV2.sol:247), not from the manifest. Registering the same series twice
 * therefore mints two independent on-chain events, each with its own supply, and
 * leaves the server's id→series map pointing at whichever landed last. Publish is a
 * two-phase flow (Swarm write, then register) whose phase 2 can fail on its own, so
 * retrying registration is a REQUIREMENT — which makes an exactly-once guard the
 * precondition for offering a retry at all.
 *
 * The guard is a ladder, cheapest first, and it never re-sends a tx that might be
 * in flight:
 *
 *   1. the feed already carries the id                    → nothing to do
 *   2. the id is in the persisted registry (zero I/O)     → tx landed, feed write
 *      didn't; heal the feed. This is the observed failure (the route's own 500
 *      says "Tx confirmed but feed update failed — retry"), and it survives a
 *      restart because the registry is `.data`-backed.
 *   3. a pending-tx marker exists                         → resolve THAT tx: mined
 *      ⇒ adopt its id; reverted/replaced ⇒ safe to send again; still in flight
 *      ⇒ refuse and let the caller come back.
 *   4. otherwise                                          → broadcast, recording the
 *      tx hash before it can mine.
 *
 * Concurrent callers for the same series join one in-flight promise rather than
 * racing to step 4.
 */

import type { EventFeed } from "@woco/shared";
import {
  registerEventOnChain as realRegisterEventOnChain,
  resolveRegisterTx as realResolveRegisterTx,
  type RegisterV2Params,
} from "../chain/sponsor-wallet.js";
import { confirmSeriesOnChain as realConfirmSeriesOnChain } from "./service.js";
import {
  lookupOnChainEventId as realLookupOnChainEventId,
  lookupPendingRegistration as realLookupPending,
  recordPendingRegistration as realRecordPending,
  clearPendingRegistration as realClearPending,
} from "./onchain-registry.js";

export type RegisterResult =
  | { status: "registered"; onChainEventId: string; txHash?: string; feed?: EventFeed }
  /** Already on chain before this call — no tx was sent. */
  | { status: "already"; onChainEventId: string; feed?: EventFeed }
  /** A previous tx is still in the mempool. No tx sent; the caller should retry later. */
  | { status: "pending"; txHash: string };

export interface RegisterParams {
  eventId: string;
  seriesId: string;
  supply: number;
  manifestRef: string;
  v2Params: RegisterV2Params;
  /** The trusted feed's own signer — cold-cache carrier for the confirm read. */
  signerHint?: string;
  /** `onChainEventId` already present on the feed's series, if any. */
  feedOnChainEventId?: string;
}

/** Seams for tests — every one of these either touches the chain or the disk. */
export interface RegisterDeps {
  lookupOnChainEventId: typeof realLookupOnChainEventId;
  lookupPending: typeof realLookupPending;
  recordPending: typeof realRecordPending;
  clearPending: typeof realClearPending;
  resolveRegisterTx: typeof realResolveRegisterTx;
  registerEventOnChain: typeof realRegisterEventOnChain;
  confirmSeriesOnChain: typeof realConfirmSeriesOnChain;
}

const defaultDeps: RegisterDeps = {
  lookupOnChainEventId: realLookupOnChainEventId,
  lookupPending: realLookupPending,
  recordPending: realRecordPending,
  clearPending: realClearPending,
  resolveRegisterTx: realResolveRegisterTx,
  registerEventOnChain: realRegisterEventOnChain,
  confirmSeriesOnChain: realConfirmSeriesOnChain,
};

/** `${eventId}|${seriesId}` → the registration currently running in THIS process. */
const inFlight = new Map<string, Promise<RegisterResult>>();

export function registerSeriesExactlyOnce(
  params: RegisterParams,
  deps: RegisterDeps = defaultDeps,
): Promise<RegisterResult> {
  const key = `${params.eventId}|${params.seriesId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = register(params, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function register(params: RegisterParams, deps: RegisterDeps): Promise<RegisterResult> {
  const { eventId, seriesId, supply, manifestRef, v2Params, signerHint, feedOnChainEventId } = params;

  if (feedOnChainEventId) {
    return { status: "already", onChainEventId: feedOnChainEventId };
  }

  const recorded = deps.lookupOnChainEventId(eventId, seriesId);
  if (recorded) {
    // The tx landed; only the feed write is outstanding. Re-run it — confirm is
    // itself idempotent (it re-records the same id and rewrites the same feed).
    const feed = await deps.confirmSeriesOnChain(eventId, seriesId, recorded, signerHint);
    deps.clearPending(eventId, seriesId);
    console.log(`[register-once] ${eventId}/${seriesId} already registered (${recorded}) — feed healed`);
    return { status: "already", onChainEventId: recorded, feed };
  }

  const pending = deps.lookupPending(eventId, seriesId);
  if (pending) {
    const outcome = await deps.resolveRegisterTx(pending.txHash, pending.nonce);
    if (outcome.status === "pending") {
      console.log(`[register-once] ${eventId}/${seriesId} tx ${pending.txHash} still in flight — not re-sending`);
      return { status: "pending", txHash: pending.txHash };
    }
    if (outcome.status === "registered") {
      const feed = await deps.confirmSeriesOnChain(eventId, seriesId, outcome.onChainEventId, signerHint);
      deps.clearPending(eventId, seriesId);
      console.log(`[register-once] ${eventId}/${seriesId} recovered from broadcast tx ${outcome.txHash}`);
      return { status: "registered", onChainEventId: outcome.onChainEventId, txHash: outcome.txHash, feed };
    }
    // reverted | replaced — that tx can never register anything, so a fresh send is safe.
    console.log(`[register-once] ${eventId}/${seriesId} previous tx ${pending.txHash} ${outcome.status} — re-sending`);
    deps.clearPending(eventId, seriesId);
  }

  const { onChainEventId, txHash } = await deps.registerEventOnChain(
    supply,
    manifestRef,
    v2Params,
    (tx) => deps.recordPending(eventId, seriesId, tx),
  );

  // A throw here leaves the marker in place ON PURPOSE: the tx is already on chain,
  // and step 3 of the next attempt is what turns it back into a completed registration.
  const feed = await deps.confirmSeriesOnChain(eventId, seriesId, onChainEventId, signerHint);
  deps.clearPending(eventId, seriesId);
  return { status: "registered", onChainEventId, txHash, feed };
}
