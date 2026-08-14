/**
 * What the UI calls for likes and follows — the Swarm rail (P1 of
 * docs/SWARM_SOCIAL_PLAN.md), replacing the on-chain EAS path in `likes.ts`.
 *
 * This layer exists to hold three things the component should not know about:
 * the sign-in gate, the mapping from a UI variant to a statement kind, and the
 * seam where public counts arrive.
 *
 * COUNTS ARE NOT AVAILABLE YET, and that is structural rather than unfinished:
 * a count is a tally over MANY users' feeds, which is an indexer's job, and the
 * indexer is the next piece of #172. A user's own state needs only their own
 * feed, so it works today. `count: null` means "nobody has counted", which the
 * UI renders as absent — deliberately distinct from `0`, which would be a claim
 * that nobody liked it.
 */

import type { LikeSubject, Hex0x } from "@woco/shared";
import { requireAccountForAction } from "../auth/ensure-action.js";
import { readMyStatement, writeMyStatement, type SocialKind } from "../social/social.js";

export interface SocialState {
  liked: boolean;
  /** null until an indexer publishes tallies — never conflate with 0. */
  count: number | null;
}

/** A "follow" pill writes a follow; every other variant writes a like. */
export function kindForVariant(variant: "heart" | "follow"): SocialKind {
  return variant === "follow" ? "follow" : "like";
}

/**
 * The caller's own state for a subject. Never throws — a display path that
 * cannot read a feed should show "not liked", not an error, and the next visit
 * re-reads.
 */
export async function getSocialState(kind: SocialKind, subject: LikeSubject): Promise<SocialState> {
  try {
    const liked = await readMyStatement(kind, subject.id as Hex0x);
    return { liked: liked === true, count: null };
  } catch {
    return { liked: false, count: null };
  }
}

/**
 * Toggle and persist. `null` means the user dismissed sign-in — the caller
 * reverts quietly rather than showing a failure, because nothing failed.
 * A genuine failure throws, so the button can show its retry state.
 */
export async function toggleSocial(
  kind: SocialKind,
  subject: LikeSubject,
  prevLiked: boolean,
): Promise<SocialState | null> {
  const ready = await requireAccountForAction({ context: "attendee" });
  if (!ready) return null;

  const next = !prevLiked;
  const res = await writeMyStatement(kind, subject.id as Hex0x, next);
  if (!res.ok) throw new Error(res.error);
  return { liked: next, count: null };
}
