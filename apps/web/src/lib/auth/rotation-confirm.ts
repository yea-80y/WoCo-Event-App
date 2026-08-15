/**
 * Post-rotation confirm judgement (#236) — the pure decision behind
 * recoverAndRekey's "did the owner actually rotate?" check.
 *
 * The read this judges is PINNED to the block the rotation's userOp landed in
 * (the removeAllBackups precedent): a replica that has not seen that block
 * ERRORS instead of answering with pre-rotation state, so "the chain named
 * someone else" can no longer be a lagging replica's stale answer — the case
 * that had the ceremony telling a user their rotation failed when it landed.
 * State at a fixed block is immutable, which is also why a pinned answer is
 * final and only an errored read is worth retrying.
 */

/** What one strict owner read means for the confirm loop. */
export type RotationReadVerdict =
  | "confirmed"     // the pinned chain state names the new owner — done
  | "not-effective" // the chain ANSWERED (at the pinned block, if pinned) and named someone else / nobody
  | "unconfirmed";  // nobody could answer — retryable, and never grounds for "nothing changed"

export function judgeRotationRead(
  read: string | null | "error",
  newOwnerAddress: string,
): RotationReadVerdict {
  if (read === "error") return "unconfirmed";
  if (read !== null && read.toLowerCase() === newOwnerAddress.toLowerCase()) return "confirmed";
  // `null` counts as ANSWERED: the chain said "no owner", which for a
  // just-rotated deployed Kernel is still a definitive not-the-new-owner.
  return "not-effective";
}

/**
 * Should the confirm loop stop after this read? Pinned: any answer is final
 * (block state is immutable — re-asking can only burn the remaining attempts).
 * Unpinned (no blockNumber surfaced): only a confirmed match may stop the
 * loop, because a non-match at "latest" can still become a match once the
 * rotation propagates.
 */
export function rotationReadIsFinal(verdict: RotationReadVerdict, pinned: boolean): boolean {
  if (verdict === "confirmed") return true;
  return pinned && verdict === "not-effective";
}
