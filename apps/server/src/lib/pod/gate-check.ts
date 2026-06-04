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
import { evaluatePodGate, verifyPodGateBinding } from "@woco/shared";
import { getOnChainHolding } from "./holdings.js";
import { getOnChainEvent } from "../chain/event-contract.js";

export interface GateDecision {
  ok: boolean;
  /** Human-readable rejection reason (surfaced to the claimer). */
  reason?: string;
}

/**
 * Chain-validate a gate at the WRITE boundary (event/product create), so
 * enforcement can trust the stored gate without re-reading.
 *
 * The cynical invariant this closes: `getOnChainHolding` reads slot ownership
 * for `onChainEventId` but does NOT itself check that that event commits the
 * gate's `manifestRef` — the creator snapshots both from their directory entry,
 * so a mismatch (bug / future untrusted client) would silently count the WRONG
 * POD. Here we read `events[onChainEventId].manifestRef` on-chain and require it
 * to equal `gate.manifestRef`, and require the event to actually be registered.
 *
 * NOTE: this is sufficient ONLY because the gate is then stored in a
 * platform-signed Swarm feed (tamper-proof to buyers). If gates ever move to
 * untrusted client-side storage, enforcement MUST re-validate per check.
 */
export async function validatePodGate(gate: PodGate): Promise<{ ok: boolean; error?: string }> {
  if (!gate || typeof gate !== "object") return { ok: false, error: "gate missing" };
  // Shape must be valid before we can read the chain (need eventId + chainId).
  if (!gate.manifestRef || !gate.onChainEventId || !Number.isFinite(gate.chainId)) {
    return { ok: false, error: "gate must have manifestRef, onChainEventId and chainId" };
  }
  let ev;
  try {
    ev = await getOnChainEvent(gate.onChainEventId, gate.chainId);
  } catch (err) {
    return { ok: false, error: `gate chain read failed: ${(err as Error).message}` };
  }
  // Single-sourced binding check (shared, client-reusable) — environment reads
  // the chain, shared logic decides pass/fail.
  return verifyPodGateBinding(gate, ev?.manifestRef ?? null);
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

/**
 * Enforce every gated product in an order against the VERIFIED buyer wallet.
 * `holder` MUST be the server-verified payer (crypto tx.from / EIP-712 binding /
 * spend-permission Kernel address), never a body-supplied address. Each distinct
 * gated product is checked once; the first failure short-circuits. Fails closed
 * via `checkPodGate`.
 */
export async function checkProductGates(
  products: { productId: string; name: string; gate?: PodGate }[],
  lines: { productId: string }[],
  holder: string,
): Promise<GateDecision> {
  const checked = new Set<string>();
  for (const line of lines) {
    if (checked.has(line.productId)) continue;
    checked.add(line.productId);
    const product = products.find((p) => p.productId === line.productId);
    if (!product?.gate) continue;
    const decision = await checkPodGate(product.gate, holder);
    if (!decision.ok) return { ok: false, reason: `${product.name}: ${decision.reason}` };
  }
  return { ok: true };
}

/** Synchronous: does any line reference a gated product? Used by the card rail,
 *  which has no wallet and so must reject gated products outright (a wallet gate
 *  is unsatisfiable by card). Returns the first gated product's name. */
export function firstGatedProduct(
  products: { productId: string; name: string; gate?: PodGate }[],
  lines: { productId: string }[],
): string | null {
  for (const line of lines) {
    const product = products.find((p) => p.productId === line.productId);
    if (product?.gate) return product.name;
  }
  return null;
}
