/**
 * Validating a client-reported `issuedCount` (Gate B, slice 4).
 *
 * Split out from the route so it has a test seam at all — the sibling problem
 * to #314 and #342, where a decision that only exists inside a handler behind
 * `requireAuth` can be established by reading and by nothing else.
 */

import type { PodDirectoryEntry } from "@woco/shared";

export type IssuedCountVerdict =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Decide whether `value` may be written to `entry.issuedCount`.
 *
 * CERTIFICATE BADGES ONLY. The server never sees a certificate issuance — the
 * run is client-signed and written straight to the issuer's own feed — so the
 * client is the only party that knows the number, and this counter is the only
 * way the manager shows progress without walking the whole log. A CHAIN badge's
 * count is derivable server-side from `nextSlot`, so letting a client write it
 * would allow a display number to contradict the chain. Ticket PODs are
 * chain-sourced too and are refused by the same rule.
 *
 * Clamped, then TRUSTED inside the bounds. Shape is something the server can
 * enforce; truth is not. The directory is documented display layer rather than
 * a trust root, and the recomputable truth is the issuer's signed log.
 *
 * NOT a monotonic ratchet, deliberately. Monotonicity would freeze a client's
 * over-report forever, and a later honest run recomputes distinct holders from
 * a log it has just read thoroughly — so it must be able to correct DOWNWARD.
 */
export function validateIssuedCount(
  entry: Pick<PodDirectoryEntry, "certLogOwner" | "supply">,
  value: unknown,
): IssuedCountVerdict {
  if (!entry.certLogOwner) {
    return { ok: false, error: "issuedCount can only be set on a certificate badge" };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > entry.supply
  ) {
    return { ok: false, error: `issuedCount must be an integer 0..${entry.supply}` };
  }
  return { ok: true, value };
}
