/**
 * The organiser's cancel, with its ledger2 half (Fable design consult 2026-11-02).
 *
 * Order is load-bearing:
 *   1. CHECK the signed cancels fully - shape, every series this event's own and on
 *      ledger2, every signature the event's organiser key at the current nonce,
 *      simulated - before anything is written. A stale or malformed signature refuses
 *      the request and cancels nothing: a garbage request must never cancel an event.
 *   2. RECORD the cancellation (`cancel-event.ts`): money stops and refunds start, as
 *      for every event. This is the fail-closed authority the money path reads.
 *   3. RELAY the cancels. If that part fails, the cancellation stands; the response
 *      says so and the dashboard offers "Finish cancelling" with a fresh signature.
 *
 * No signed cancels (an event not on ledger2, an older client) is step 2 alone.
 */

import type { Ledger2RelayResult } from "@woco/shared/ticket/ledger2-terms";
import type { CancelEventResult } from "./cancel-event.js";
import {
  prepareLedger2Relay,
  submitLedger2Relay,
  type Ledger2RelayDeps,
  type RelayRefusal,
} from "./ledger2-relay.js";

export type ChainCancelOutcome = Ledger2RelayResult | { status: "failed"; error: string };

export type CancelOnChainResult =
  | { kind: "refused"; refusal: RelayRefusal }
  | { kind: "done"; recorded: CancelEventResult; chain?: ChainCancelOutcome };

export async function cancelEventWithChain(
  input: {
    eventId: string;
    parent: string;
    seriesIds: readonly string[];
    /** The signed `cancel` items, or undefined when the client sent none. */
    chainCancels: unknown;
    /** Writes the server's record (`cancelEvent` with its live deps). */
    record: () => CancelEventResult;
    /**
     * False when the chain half is over its gas budget: the cancellation is recorded
     * without it, never refused - a budget is no reason to keep selling (sign-off C3).
     */
    chainAllowed?: boolean;
  },
  deps: Ledger2RelayDeps,
): Promise<CancelOnChainResult> {
  const signed = Array.isArray(input.chainCancels) && input.chainCancels.length > 0;
  if (!signed) return { kind: "done", recorded: input.record() };
  if (input.chainAllowed === false) {
    return { kind: "done", recorded: input.record(), chain: { status: "failed", error: "rate_limited" } };
  }

  const prepared = await prepareLedger2Relay(
    {
      eventId: input.eventId,
      parent: input.parent,
      seriesIds: input.seriesIds,
      request: { items: input.chainCancels },
      allowed: new Set(["cancel"]),
      label: "ledger2.cancel",
    },
    deps,
  );
  if (!prepared.ok) {
    // A chain we could not read, a relay that is off, or a change of the organiser's
    // still saving (the per-event lock) is no reason to keep selling: the record still
    // stops the money, and "Finish cancelling" does the chain half later. Only a
    // refusal of what was SIGNED stops here (Fable sign-off C4).
    if (prepared.status === 502 || prepared.status === 503 || prepared.error === "in_flight") {
      return { kind: "done", recorded: input.record(), chain: { status: "failed", error: prepared.error } };
    }
    return { kind: "refused", refusal: prepared };
  }

  let recorded: CancelEventResult;
  try {
    recorded = input.record();
  } catch (err) {
    prepared.prepared.release();
    throw err;
  }
  if (!recorded.ok) {
    prepared.prepared.release();
    return { kind: "done", recorded };
  }

  const sent = await submitLedger2Relay(prepared.prepared, deps);
  return { kind: "done", recorded, chain: sent.ok ? sent.result : { status: "failed", error: sent.error } };
}
