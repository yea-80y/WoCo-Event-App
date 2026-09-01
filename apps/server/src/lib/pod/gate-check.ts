// ---------------------------------------------------------------------------
// POD gate enforcement (Step 4, item B) — the authoritative claim/order check.
//
// Reads the holder's holding from whichever TRUSTLESS source the stored gate
// declares — on-chain slot ownership (getOnChainHolding) or an issuer-signed
// POD certificate the holder presents (getCertHolding) — and runs the pure
// evaluatePodGate against it. The evaluator never learns which; both sources
// produce a PodHolding and it cannot tell them apart. Reused by event claims
// and product orders so the gate semantics are identical on both rails.
//
// A gate with no `holdingSource` is a CHAIN gate (see the rule on PodGate);
// one naming a source this build does not know REFUSES rather than falling
// into the chain arm, which would enforce the wrong proof entirely.
//
// FAILS CLOSED: any read error (bad chain config, RPC hiccup, unreadable
// manifest) returns a rejection, never a pass — a flaky holdings read must not
// open a gate.
// ---------------------------------------------------------------------------

import type {
  PodGate, PodGateGroup, Hex0x, HolderPubkey, GateEvalContext, GatePhase, PodHolding,
  PodCertPresentation, PodCertChallengeExpectation,
} from "@woco/shared";
import {
  evaluatePodGateGroup, computeGatePhase, normalizeGate, verifyPodGateBinding,
  isCertPodGate, isKnownHoldingSource, verifyCertPodGateShape, findDuplicateGateManifestRef,
} from "@woco/shared";
import { getOnChainHolding } from "./holdings.js";
import { getCertHolding, loadVerifiedBadgeManifest } from "./cert-holdings.js";
import { getOnChainEvent } from "../chain/event-contract.js";

/**
 * What a claimer supplied to satisfy CERTIFICATE gates, plus what the server
 * remembers about the challenge it issued.
 *
 * `presentations` is the only part that comes from the request. `expect` MUST
 * be rebuilt from the server's own challenge record, keyed by the presented
 * nonce — a presentation that names its own audience, nonce and expiry proves
 * nothing at all. Same rule as "the server uses the VERIFIED parentAddress,
 * never one from the request body".
 */
export interface GateEvidence {
  presentations: PodCertPresentation[];
  expect: PodCertChallengeExpectation;
  /**
   * The claimer's VERIFIED POD identity — the ed25519 key the route already
   * authenticated, never one from the body. Required, not optional, so a route
   * wiring evidence cannot forget it: a certificate must name the identity
   * actually claiming, or a cooperative holder can answer challenges for
   * strangers. The certificate-rail twin of the wallet-must-be-the-claimer rule.
   */
  expectedHolder: HolderPubkey;
}

export interface GateDecision {
  ok: boolean;
  /** Human-readable rejection reason (surfaced to the claimer). */
  reason?: string;
}

/**
 * Resolve the current access phase of a stored gate (`holders-only`/`open`/
 * `closed`). Pure pass-through to the shared `computeGatePhase` — exposed here
 * so route handlers branch on the SAME phase the evaluator uses (e.g. allow
 * email/card in the `open` phase, demand a wallet only when `holders-only`).
 *
 * `ctx.tierClaimed` (committed claims of the gated tier) is required for a
 * `firstN` window and is read by the caller from the series feed it already
 * loads. Mirrors the shape a future client-side feed signer will use — this is
 * pure and chain-free (see [[signing_role_architecture]]).
 */
export function gatePhase(
  gate: PodGate | PodGateGroup,
  ctx: GateEvalContext = {},
): GatePhase {
  return computeGatePhase(normalizeGate(gate).window, ctx);
}

/**
 * Does this gate's window need the gated tier's committed claim count to resolve
 * its phase? Only `firstN` does today (`reserved` is deferred/fail-safe and
 * `always`/`time` are count-independent). Lets the claim/checkout paths skip an
 * extra feed read for the common case.
 */
export function gateNeedsClaimCount(gate: PodGate | PodGateGroup): boolean {
  return normalizeGate(gate).window?.kind === "firstN";
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

  // One badge may appear only ONCE per group, whatever its source. Enforcement
  // reads one holding per manifestRef and matches holdings by manifestRef
  // alone, so a duplicate would evaluate the second gate against the first
  // gate's holding — under `mode: "all"`, counting a single proof twice.
  const dup = findDuplicateGateManifestRef(group);
  if (dup) {
    return { ok: false, error: `the same POD is listed twice in this gate (${dup.slice(0, 10)}…)` };
  }

  // Validate each gate's shape and its trust binding, per source.
  for (const g of group.gates) {
    if (!isKnownHoldingSource(g)) {
      return { ok: false, error: "gate asks for a holding source this server does not know how to check" };
    }

    if (isCertPodGate(g)) {
      const shape = verifyCertPodGateShape(g);
      if (!shape.ok) return shape;
      // Prove the gate is ENFORCEABLE before storing it: the ref resolves, the
      // manifest is genuinely the one `manifestRef` names, and it yields a
      // conformant issuer key. This is organiser UX — catching a dead ref where
      // it can still be explained — NOT the trust check, which is re-proved on
      // every use. A transient Swarm failure here is a refusal worth retrying.
      if (!(await loadVerifiedBadgeManifest(g, { bypassCache: true }))) {
        return { ok: false, error: "could not read this POD's manifest to confirm who issues it — try again" };
      }
      continue;
    }

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
 * Does `holder` (a wallet address) satisfy `gate` right now? `holder` MUST be
 * the server-verified claimer/payer address, never one from the request body.
 * Accepts a single `PodGate` (legacy) or a `PodGateGroup`; normalises internally
 * so both paths use the same evaluator.
 *
 * `ctx` carries the evaluation clock + the gated tier's committed claim count
 * (for `firstN`). Threaded straight into the pure `evaluatePodGateGroup` so the
 * holdings read and the window phase resolve against one consistent snapshot.
 */
export async function checkPodGate(
  gate: PodGate | PodGateGroup,
  holder: string,
  ctx: GateEvalContext = {},
  evidence?: GateEvidence,
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

  // A source this build cannot evaluate is a PERMANENT refusal, so say so here
  // rather than letting the throw below land in the generic catch, whose
  // message promises a retry that can never succeed.
  if (group.gates.some((g) => !isKnownHoldingSource(g))) {
    return {
      ok: false,
      reason: "This requires a kind of proof this platform cannot check — the organiser needs to reconfigure it.",
    };
  }

  try {
    // Read every distinct gate's holding in parallel, per source (fail-closed
    // on error — a throw here is caught below and rejects the whole check,
    // deliberately unchanged even under `mode: "any"`).
    const seen = new Set<string>();
    const holdingPromises = group.gates
      .filter((g) => {
        if (seen.has(g.manifestRef.toLowerCase())) return false;
        seen.add(g.manifestRef.toLowerCase());
        return true;
      })
      .map((g) => resolveHolding(g, holderLc, evidence));

    const holdings = await Promise.all(holdingPromises);
    if (evaluatePodGateGroup(holdings, group, ctx)) return { ok: true };

    // Say the useful thing when the claimer simply has not been asked for a
    // certificate yet — "you hold none" would be a lie about evidence nobody
    // requested.
    const awaitingProof =
      computeGatePhase(group.window, ctx) === "holders-only" &&
      group.gates.some((g) => isCertPodGate(g)) &&
      !evidence;
    if (awaitingProof) {
      return {
        ok: false,
        reason: `This requires holding ${label}, proved with a certificate you have not presented yet.`,
      };
    }

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
 * One gate, one holding, from whichever source the gate declares.
 *
 * An unrecognised source THROWS rather than returning an empty holding: the
 * caller's catch rejects the whole check, which is the right answer for a
 * config this build cannot evaluate. Falling through to the chain arm would
 * enforce the wrong proof against a gate that asked for something else.
 */
async function resolveHolding(
  gate: PodGate,
  holderLc: Hex0x,
  evidence?: GateEvidence,
): Promise<PodHolding> {
  if (!isKnownHoldingSource(gate)) {
    throw new Error(`unknown POD gate holding source for ${gate.manifestRef}`);
  }
  if (isCertPodGate(gate)) {
    // No presentation supplied = nothing proved. Zero, not an error: the
    // claimer may simply not have been through the challenge handshake.
    if (!evidence) return { manifestRef: gate.manifestRef, count: 0, slots: [] };
    return getCertHolding(gate, evidence.presentations, evidence.expect, evidence.expectedHolder);
  }
  return getOnChainHolding({
    holder: holderLc,
    onChainEventId: gate.onChainEventId,
    chainId: gate.chainId,
    manifestRef: gate.manifestRef,
  });
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
