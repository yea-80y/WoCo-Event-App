// ---------------------------------------------------------------------------
// Pure POD-gate evaluator — the trust-light half of the holdings primitive.
//
// No chain, no I/O: given a `PodHolding` (read trustlessly on-chain by the
// server) and a `PodGateRule`, decide pass/fail. Pure so it runs identically
// client-side (instant UX feedback) and server-side (the authoritative gate at
// claim/order time). See docs/WOCO_SHOP_PLAN.md §4.3.
// ---------------------------------------------------------------------------

import type { PodHolding, PodGateRule, PodGate, PodGateGroup, GateWindow } from "./types.js";

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
 * Read-coordinates a `PodGateGroup` evaluation needs beyond the holdings: the
 * clock and (for count-based windows) how many editions of the GATED tier have
 * been claimed so far. Pure data — the caller reads `tierClaimed` from the
 * series/edition feed it already loads at claim time.
 */
export interface GateEvalContext {
  /** Evaluation clock (Unix ms). Default `Date.now()`. */
  now?: number;
  /**
   * Committed claims of the gated tier (the series/product carrying the gate)
   * so far. Required for `firstN`. Omit for windows that don't need a count.
   * Reservations are deliberately NOT counted — only committed claims advance
   * the phase, which keeps the boundary monotonic (a held-but-unpaid seat can
   * never retreat the gate from open back to holders-only).
   */
  tierClaimed?: number;
}

/**
 * The access phase a `PodGateGroup`'s window puts the gated tier in RIGHT NOW.
 * Decouples "what does out-of-window mean" — which differs per window kind —
 * from the holdings check:
 * - `holders-only` — claimable, but only by an account passing the gate set.
 * - `open`         — claimable by ANYONE (the gate has lapsed; e.g. first-N
 *                    early access is over). No wallet/holdings required.
 * - `closed`       — not claimable by anyone right now (e.g. a time window that
 *                    has not opened / has ended).
 */
export type GatePhase = "holders-only" | "open" | "closed";

/**
 * Pure: which phase is `group`'s window in at `ctx.now`?
 *
 * - `always`  → holders-only (the gate always restricts).
 * - `time`    → holders-only inside [notBefore, notAfter]; `closed` outside.
 * - `firstN`  → holders-only while `tierClaimed < n` (holder-only early access);
 *               `open` once `tierClaimed ≥ n`. If `tierClaimed` is unknown,
 *               fail-safe to holders-only (never silently open a gate).
 * - `reserved`→ DEFERRED (Phase 2b): treated as holders-only so it is safe but
 *               unenforced until holder/non-holder claim accounting exists.
 */
export function computeGatePhase(
  window: GateWindow | undefined,
  ctx: GateEvalContext = {},
): GatePhase {
  const win = window ?? { kind: "always" };
  const now = ctx.now ?? Date.now();
  switch (win.kind) {
    case "always":
      return "holders-only";
    case "time": {
      if (win.notBefore != null && now < win.notBefore) return "closed";
      if (win.notAfter != null && now > win.notAfter) return "closed";
      return "holders-only";
    }
    case "firstN": {
      if (ctx.tierClaimed == null) return "holders-only"; // fail-safe
      return ctx.tierClaimed >= win.n ? "open" : "holders-only";
    }
    case "reserved":
      return "holders-only"; // Phase 2b not built — fail-safe to holder-required
    default:
      return "holders-only";
  }
}

/**
 * Evaluate a `PodGateGroup` against a set of holdings (one per gate in the group).
 *
 * Resolves the window phase first (`computeGatePhase`): `open` passes for
 * everyone, `closed` fails for everyone, `holders-only` falls through to the
 * any/all holdings check against `group.gates`.
 *
 * `holdings` must be pre-fetched by the caller (one holding per unique `manifestRef`
 * in `group.gates`); pass an empty array when a holding is absent (fail-closed
 * for the relevant gate — count 0, no slots).
 */
export function evaluatePodGateGroup(
  holdings: PodHolding[],
  group: PodGateGroup,
  ctx: GateEvalContext = {},
): boolean {
  const phase = computeGatePhase(group.window, ctx);
  if (phase === "open") return true;
  if (phase === "closed") return false;

  if (group.gates.length === 0) return false;

  const now = ctx.now ?? Date.now();
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
