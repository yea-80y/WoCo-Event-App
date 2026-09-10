// ---------------------------------------------------------------------------
// Pure POD-gate evaluator — the trust-light half of the holdings primitive.
//
// No chain, no I/O: given a `PodHolding` (read trustlessly on-chain by the
// server) and a `PodGateRule`, decide pass/fail. Pure so it runs identically
// client-side (instant UX feedback) and server-side (the authoritative gate at
// claim/order time). See docs/WOCO_SHOP_PLAN.md §4.3.
// ---------------------------------------------------------------------------

import type {
  PodHolding, PodGateRule, PodGate, ChainPodGate, CertPodGate, PodGateGroup, GateWindow,
} from "./types.js";

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
 * Which holding source does this gate draw from? Absent discriminant = chain,
 * per the rule recorded on `PodGate`: every gate written before the field
 * existed passed a chain binding check, and chain is the stricter reading.
 */
export function isCertPodGate(gate: PodGate): gate is CertPodGate {
  return (gate as CertPodGate)?.holdingSource === "pod-cert";
}

/**
 * Is this a holding source this build knows how to enforce? A gate carrying an
 * unrecognised `holdingSource` — written by a newer client than the server
 * reading it — must REFUSE rather than fall into the chain arm, which would
 * enforce the wrong proof against a config that asked for something else.
 */
export function isKnownHoldingSource(gate: PodGate): boolean {
  const src = (gate as { holdingSource?: unknown })?.holdingSource;
  return src === undefined || src === "chain" || src === "pod-cert";
}

/**
 * Pure write-boundary validation of a CERTIFICATE gate's shape.
 *
 * Two of these refusals exist because the configuration would otherwise be
 * storable, silent, and permanently unpassable — a gate no attendee on earth
 * can open, failing closed with nothing to say. TypeScript already makes both
 * nearly inexpressible (`minCount?: 1`, no `maxSlotExclusive` field), but
 * stored JSON and casts do not read TypeScript, so the runtime check is the
 * authoritative one.
 *
 * The manifest binding — that `swarmManifestRef` resolves to a manifest whose
 * digest IS `manifestRef` — is environment-specific (it needs a Swarm read) and
 * so lives with the caller, exactly as the chain arm's read does.
 */
export function verifyCertPodGateShape(gate: CertPodGate): { ok: boolean; error?: string } {
  if (!gate?.manifestRef || !/^0x[0-9a-f]{64}$/.test(gate.manifestRef)) {
    return { ok: false, error: "gate manifestRef must be 0x-prefixed lowercase bytes32" };
  }
  if (typeof gate.swarmManifestRef !== "string" || !/^[0-9a-f]{64}$/.test(gate.swarmManifestRef)) {
    return { ok: false, error: "certificate gate needs a swarmManifestRef to resolve its issuer from" };
  }
  if (gate.minCount != null && gate.minCount !== 1) {
    return {
      ok: false,
      error: "a certificate proves you hold this badge, not how many — a minimum above 1 can never pass",
    };
  }
  if ((gate as { maxSlotExclusive?: unknown }).maxSlotExclusive != null) {
    return {
      ok: false,
      error: "first-N ordering only exists on the chain rail — certificates carry no allocation order",
    };
  }
  return { ok: true };
}

/**
 * The first `manifestRef` appearing twice in a group, or null.
 *
 * Duplicates were harmless while one source existed — the same holding checked
 * twice is idempotent. With two sources they are a live defect: enforcement
 * reads ONE holding per `manifestRef` and `evaluatePodGateGroup` matches
 * holdings by `manifestRef` alone, so a group pairing a chain gate and a
 * certificate gate for the SAME badge would evaluate the second against the
 * first's holding — under `mode: "all"`, counting one proof twice. Cheapest
 * structural fix is to refuse the duplicate where it is written.
 */
export function findDuplicateGateManifestRef(group: PodGateGroup): string | null {
  const seen = new Set<string>();
  for (const g of group.gates) {
    const ref = g.manifestRef?.toLowerCase();
    if (!ref) continue;
    if (seen.has(ref)) return ref;
    seen.add(ref);
  }
  return null;
}

/**
 * Pure write-boundary validation for a stored CHAIN gate: shape + the
 * security-critical binding that `onChainEventId` actually commits the gate's
 * `manifestRef` on-chain.
 *
 * SCOPE: the chain arm only. The certificate arm's equivalent is
 * {@link verifyCertPodGateShape} plus a manifest-digest check, and the two are
 * not merely different mechanisms — they are load-bearing at different times.
 * This check is the ONLY place the wrong-POD substitution is ever caught,
 * because `getOnChainHolding` does not re-check the binding at enforcement;
 * checking once is sufficient only because the gate is then stored in a
 * platform-signed feed. The certificate arm re-proves its trust root on EVERY
 * use, which is why it stays sound even if gates move to untrusted client
 * storage — the property Gate B's serverless endgame needs.
 *
 * The CHAIN READ is environment-specific (server chain lib today; the client's
 * own reader when feed signing moves client-side per [[signing_role_architecture]]),
 * so the caller reads `events[onChainEventId].manifestRef` and passes it in
 * (`null` when the event is unregistered). Keeping the comparison here means the
 * server and a future client signer validate gates with ONE implementation — the
 * gate stays verifiable by anyone, with no server secret.
 */
export function verifyPodGateBinding(
  gate: Partial<ChainPodGate> & { manifestRef: string },
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
