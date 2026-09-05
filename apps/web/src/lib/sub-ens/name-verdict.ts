/**
 * The DECISION half of display verification (plan doc §3 point F), kept free of
 * imports so it is testable under plain node and so the policy can be read in
 * one screen.
 *
 * The rule is fail-closed: a name claimed by a feed is rendered only when the
 * chain has said it belongs to the address the feed belongs to. Everything else
 * — not yet checked, checked and wrong, no such name, nobody answered —
 * renders nothing. `GET /api/sub-ens/check/:label` is public, unauthenticated
 * and RPC-backed, so a fail-open rule would let anyone who can exhaust the RPC
 * quota get a forged name rendered for every viewer.
 */

/** A verdict we are willing to remember: the on-chain owner, or null for "no
 *  such name". A FAILED lookup is not a verdict and is never stored. */
export interface OwnerVerdict {
  owner: string | null;
  checkedAt: number;
}

/**
 * How long a verdict is treated as fresh (no background revalidation).
 *
 * A negative verdict expires sooner because it is the one that changes under
 * the viewer's feet: a name minted seconds ago reads as "none" until the mint
 * lands, and the viewer would otherwise sit on that. A positive verdict going
 * stale means a name changed hands — not the failure this module exists for.
 */
export const FRESH_MS = { found: 10 * 60 * 1000, none: 2 * 60 * 1000 } as const;

/** May `verdict` be rendered as belonging to `expected`? */
export function verdictAllows(verdict: OwnerVerdict | null, expected: string | null | undefined): boolean {
  if (!verdict || !verdict.owner || !expected) return false;
  return verdict.owner.toLowerCase() === expected.toLowerCase();
}

/** Is `verdict` fresh enough to skip a revalidation? */
export function verdictIsFresh(verdict: OwnerVerdict | null, now: number = Date.now()): boolean {
  if (!verdict) return false;
  const window = verdict.owner ? FRESH_MS.found : FRESH_MS.none;
  return now - verdict.checkedAt < window;
}
