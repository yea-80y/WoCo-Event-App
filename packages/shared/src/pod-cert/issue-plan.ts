/**
 * What an issuance run should do, decided with no I/O.
 *
 * Split out from the write path deliberately: deciding WHO gets a certificate
 * is arithmetic over two holder lists and a cap, and it is the part most worth
 * testing — the orchestration around it is feed reads and writes, which need a
 * browser and a gateway. Keeping the decision pure means the rules below are
 * covered by ordinary unit tests rather than by inspection.
 */

import type { Hex32 } from "../pod/types.js";

export interface CertIssuancePlan {
  /** Holders to certify in this run, request order, deduped. */
  toIssue: Hex32[];
  /** Requested holders the log already carries — skipped, not re-signed. */
  alreadyHeld: Hex32[];
  /** Distinct holders the badge will have once this run lands. */
  totalAfter: number;
}

export type CertIssuancePlanResult =
  | ({ ok: true } & CertIssuancePlan)
  | { ok: false; error: string };

const ED25519_PUB_RE = /^[0-9a-f]{64}$/;

/**
 * Decide an issuance run.
 *
 * IDEMPOTENT BY HOLDER, which is what makes a crashed or double-clicked run
 * safe to repeat: a holder the log already carries is skipped rather than
 * re-signed. Re-issuing is harmless at a door — a certificate holding is
 * presence, not quantity — but it costs postage and adds log noise, and a run
 * that cannot be repeated cleanly has no recovery story at all.
 *
 * THE CAP IS COUNTED IN DISTINCT HOLDERS, never in certificates. An issuer
 * re-signs when a holder rotates keys or a date was wrong, so counting
 * certificates would let re-issuance consume supply that was never granted to
 * anyone new.
 *
 * The cap is refused HERE, before anything is signed, because nothing at any
 * door enforces it: over-issuance is caught only by auditing the issuer's own
 * log after the fact. Refusing at the point of issuance is the only moment it
 * can be explained to the issuer rather than discovered by a stranger.
 */
export function planCertIssuance(args: {
  requested: readonly Hex32[];
  /** Distinct holders already carried by the badge's log. */
  existingHolders: readonly Hex32[];
  /** The manifest's `totalSupply`. Omit only when it is genuinely unknown. */
  cap?: number;
}): CertIssuancePlanResult {
  const existing = new Set(args.existingHolders ?? []);
  const seen = new Set<string>();
  const toIssue: Hex32[] = [];
  const alreadyHeld: Hex32[] = [];

  for (const holder of args.requested ?? []) {
    if (typeof holder !== "string" || !ED25519_PUB_RE.test(holder)) {
      return { ok: false, error: `not an ed25519 holder key: ${String(holder).slice(0, 24)}` };
    }
    if (seen.has(holder)) continue; // the same holder twice in one request is one certificate
    seen.add(holder);
    if (existing.has(holder)) alreadyHeld.push(holder);
    else toIssue.push(holder);
  }

  if (toIssue.length === 0 && alreadyHeld.length === 0) {
    return { ok: false, error: "no holders to certify" };
  }

  const totalAfter = existing.size + toIssue.length;
  if (args.cap != null) {
    if (!Number.isInteger(args.cap) || args.cap < 1) {
      return { ok: false, error: `invalid supply cap: ${args.cap}` };
    }
    if (totalAfter > args.cap) {
      return {
        ok: false,
        error:
          `this would certify ${totalAfter} holders against a declared supply of ${args.cap} — ` +
          `${totalAfter - args.cap} too many`,
      };
    }
  }

  return { ok: true, toIssue, alreadyHeld, totalAfter };
}
