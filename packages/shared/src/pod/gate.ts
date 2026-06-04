// ---------------------------------------------------------------------------
// Pure POD-gate evaluator — the trust-light half of the holdings primitive.
//
// No chain, no I/O: given a `PodHolding` (read trustlessly on-chain by the
// server) and a `PodGateRule`, decide pass/fail. Pure so it runs identically
// client-side (instant UX feedback) and server-side (the authoritative gate at
// claim/order time). See docs/WOCO_SHOP_PLAN.md §4.3.
// ---------------------------------------------------------------------------

import type { PodHolding, PodGateRule, PodGate, PodGateGroup } from "./types.js";

/**
 * Does `holding` satisfy `rule` at time `now` (Unix ms)?
 *
 * - Time window: a rule outside [`notBefore`, `notAfter`] does NOT pass — the
 *   caller (event/product config) decides what an out-of-window gate means
 *   (closed vs. a different phase); the evaluator only answers "passing now?".
 * - First-N: when `maxSlotExclusive` is set, only owned slots with index <
 *   that value count (slots are allocation-order → "first N buyers").
 * - Count: passes when the qualifying holdings ≥ `minCount` (default 1).
 *
 * The holding MUST be for the same POD type as the rule; callers pass a holding
 * read for `rule.manifestRef`. A mismatched `manifestRef` always fails closed.
 */
export function evaluatePodGate(
  holding: PodHolding,
  rule: PodGateRule,
  now: number = Date.now(),
): boolean {
  if (holding.manifestRef.toLowerCase() !== rule.manifestRef.toLowerCase()) return false;
  if (rule.notBefore != null && now < rule.notBefore) return false;
  if (rule.notAfter != null && now > rule.notAfter) return false;

  const min = rule.minCount ?? 1;
  const qualifying =
    rule.maxSlotExclusive != null
      ? holding.slots.filter((s) => s < rule.maxSlotExclusive!).length
      : holding.count;

  return qualifying >= min;
}

/**
 * Upcast a stored `PodGate | PodGateGroup` to a `PodGateGroup` so enforcement
 * code has a single shape to work with. Old single-gate records become a
 * `{ mode:"any", gates:[gate], window:{kind:"always"} }` group transparently.
 */
export function normalizeGate(g: PodGate | PodGateGroup): PodGateGroup {
  if ("gates" in g) return g as PodGateGroup;
  return { mode: "any", gates: [g as PodGate], window: { kind: "always" } };
}

/**
 * Evaluate a `PodGateGroup` against a set of holdings (one per gate in the group)
 * at time `now`.
 *
 * Phase 1: `always` and `time` windows enforced. `firstN` / `reserved` are
 * treated as open (Phase 2 — needs claim-count reads).
 *
 * `holdings` must be pre-fetched by the caller (one holding per unique `manifestRef`
 * in `group.gates`); pass an empty array when a holding is absent (fail-closed
 * for the relevant gate — count 0, no slots).
 */
export function evaluatePodGateGroup(
  holdings: PodHolding[],
  group: PodGateGroup,
  now: number = Date.now(),
): boolean {
  const win = group.window ?? { kind: "always" };
  if (win.kind === "time") {
    if (win.notBefore != null && now < win.notBefore) return false;
    if (win.notAfter != null && now > win.notAfter) return false;
  }
  // firstN / reserved not enforced until Phase 2 (treat as always-active).

  if (group.gates.length === 0) return false;

  const results = group.gates.map((gate) => {
    const holding = holdings.find(
      (h) => h.manifestRef.toLowerCase() === gate.manifestRef.toLowerCase(),
    ) ?? { manifestRef: gate.manifestRef, count: 0, slots: [] };
    return evaluatePodGate(holding, gate, now);
  });

  return group.mode === "any" ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Pure write-boundary validation for a stored `PodGate`: shape + the
 * security-critical binding that `onChainEventId` actually commits the gate's
 * `manifestRef` on-chain.
 *
 * The CHAIN READ is environment-specific (server chain lib today; the client's
 * own reader when feed signing moves client-side per [[signing_role_architecture]]),
 * so the caller reads `events[onChainEventId].manifestRef` and passes it in
 * (`null` when the event is unregistered). Keeping the comparison here means the
 * server and a future client signer validate gates with ONE implementation — the
 * gate stays verifiable by anyone, with no server secret.
 */
export function verifyPodGateBinding(
  gate: { manifestRef: string; onChainEventId?: string; chainId?: number; minCount?: number },
  onChainManifestRef: string | null,
): { ok: boolean; error?: string } {
  if (!gate?.manifestRef || !gate.onChainEventId || !Number.isFinite(gate.chainId as number)) {
    return { ok: false, error: "gate must have manifestRef, onChainEventId and chainId" };
  }
  if (gate.minCount != null && (!Number.isInteger(gate.minCount) || gate.minCount < 1)) {
    return { ok: false, error: "gate minCount must be a positive integer" };
  }
  if (!onChainManifestRef) {
    return { ok: false, error: "gate references an unregistered on-chain event" };
  }
  if (onChainManifestRef.toLowerCase() !== gate.manifestRef.toLowerCase()) {
    return { ok: false, error: "gate manifestRef does not match the on-chain event commitment" };
  }
  return { ok: true };
}
