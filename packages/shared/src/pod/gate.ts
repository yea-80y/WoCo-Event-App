// ---------------------------------------------------------------------------
// Pure POD-gate evaluator — the trust-light half of the holdings primitive.
//
// No chain, no I/O: given a `PodHolding` (read trustlessly on-chain by the
// server) and a `PodGateRule`, decide pass/fail. Pure so it runs identically
// client-side (instant UX feedback) and server-side (the authoritative gate at
// claim/order time). See docs/WOCO_SHOP_PLAN.md §4.3.
// ---------------------------------------------------------------------------

import type { PodHolding, PodGateRule } from "./types.js";

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
