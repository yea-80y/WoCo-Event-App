// ---------------------------------------------------------------------------
// POD gate enforcement (Step 4, item B) — the authoritative claim/order check.
//
// Reads the holder's TRUSTLESS on-chain holding (getOnChainHolding) and runs
// the pure evaluatePodGate against the stored PodGate. Reused by event claims
// and product orders so the gate semantics are identical on both rails.
//
// FAILS CLOSED: any read error (bad chain config, RPC hiccup) returns a
// rejection, never a pass — a flaky holdings read must not open a gate.
// ---------------------------------------------------------------------------

import type { PodGate, Hex0x } from "@woco/shared";
import { evaluatePodGate } from "@woco/shared";
import { getOnChainHolding } from "./holdings.js";

export interface GateDecision {
  ok: boolean;
  /** Human-readable rejection reason (surfaced to the claimer). */
  reason?: string;
}

/**
 * Does `holder` (a wallet address) satisfy `gate`? `holder` MUST be the
 * server-verified claimer/payer address, never one from the request body.
 */
export async function checkPodGate(gate: PodGate, holder: string): Promise<GateDecision> {
  const label = gate.podName ? `"${gate.podName}"` : "the required POD";
  try {
    const holding = await getOnChainHolding({
      holder: holder.toLowerCase() as Hex0x,
      onChainEventId: gate.onChainEventId,
      chainId: gate.chainId,
      manifestRef: gate.manifestRef,
    });
    if (evaluatePodGate(holding, gate)) return { ok: true };

    const need = gate.minCount ?? 1;
    const qty = need > 1 ? `${need}× ` : "";
    return { ok: false, reason: `This requires holding ${qty}${label}. You currently hold ${holding.count}.` };
  } catch (err) {
    console.error("[pod] gate check failed (fail-closed):", err);
    return { ok: false, reason: `Could not verify your ${label} holdings right now — please try again.` };
  }
}
