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

import type { PodGate, PodGateGroup, Hex0x } from "@woco/shared";
import { evaluatePodGateGroup, normalizeGate, verifyPodGateBinding } from "@woco/shared";
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
export async function validatePodGate(
  gate: PodGate | PodGateGroup,
): Promise<{ ok: boolean; error?: string }> {
  if (!gate || typeof gate !== "object") return { ok: false, error: "gate missing" };
  const group = normalizeGate(gate);
  if (group.gates.length === 0) return { ok: false, error: "gate group must have at least one gate" };
  // Validate each gate's shape and on-chain binding independently.
  for (const g of group.gates) {
    if (!g.manifestRef || !g.onChainEventId || !Number.isFinite(g.chainId)) {
      return { ok: false, error: "gate must have manifestRef, onChainEventId and chainId" };
    }
    let ev;
    try {
      ev = await getOnChainEvent(g.onChainEventId, g.chainId);
    } catch (err) {
      return { ok: false, error: `gate chain read failed: ${(err as Error).message}` };
    }
    const binding = verifyPodGateBinding(g, ev?.manifestRef ?? null);
    if (!binding.ok) return binding;
  }
  return { ok: true };
}

/**
 * Does `holder` (a wallet address) satisfy `gate`? `holder` MUST be the
 * server-verified claimer/payer address, never one from the request body.
 * Accepts a single `PodGate` (legacy) or a `PodGateGroup`; normalises
 * internally so both paths use the same evaluator.
 */
export async function checkPodGate(
  gate: PodGate | PodGateGroup,
  holder: string,
): Promise<GateDecision> {
  const group = normalizeGate(gate);
  const holderLc = holder.toLowerCase() as Hex0x;

  // Build a human-readable label for error messages.
  const nameList = group.gates.map((g) => g.podName ? `"${g.podName}"` : "a required POD");
  const label =
    nameList.length === 1
      ? nameList[0]
      : group.mode === "any"
        ? `any of: ${nameList.join(", ")}`
        : `all of: ${nameList.join(", ")}`;

  try {
    // Read every distinct gate's holding in parallel (fail-closed on error).
    const seen = new Set<string>();
    const holdingPromises = group.gates
      .filter((g) => {
        if (seen.has(g.manifestRef.toLowerCase())) return false;
        seen.add(g.manifestRef.toLowerCase());
        return true;
      })
      .map((g) =>
        getOnChainHolding({
          holder: holderLc,
          onChainEventId: g.onChainEventId,
          chainId: g.chainId,
          manifestRef: g.manifestRef,
        }),
      );

    const holdings = await Promise.all(holdingPromises);
    if (evaluatePodGateGroup(holdings, group)) return { ok: true };

    const totalHeld = holdings.reduce((s, h) => s + h.count, 0);
    return {
      ok: false,
      reason: `This requires holding ${label}. You currently hold ${totalHeld > 0 ? totalHeld : "none"}.`,
    };
  } catch (err) {
    console.error("[pod] gate check failed (fail-closed):", err);
    return { ok: false, reason: `Could not verify your holdings right now — please try again.` };
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
  products: { productId: string; name: string; gate?: PodGate | PodGateGroup }[],
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
  products: { productId: string; name: string; gate?: PodGate | PodGateGroup }[],
  lines: { productId: string }[],
): string | null {
  for (const line of lines) {
    const product = products.find((p) => p.productId === line.productId);
    if (product?.gate) return product.name;
  }
  return null;
}
