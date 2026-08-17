/**
 * What the UI calls for likes and follows — the Swarm rail (P1 of
 * docs/SWARM_SOCIAL_PLAN.md), replacing the on-chain EAS path in `likes.ts`.
 *
 * This layer exists to hold three things the component should not know about:
 * the sign-in gate, the mapping from a UI variant to a statement kind, and the
 * seam where public counts arrive.
 *
 * A user's own state comes from their own feed; a COUNT is a tally over many
 * feeds, so it comes from an indexer. `count: null` still means "nobody has
 * counted" — the indexer was unreachable, or has never been asked about this
 * subject — and the UI renders that as absent, deliberately distinct from `0`,
 * which would be a claim that nobody liked it.
 *
 * Counts are also remembered between visits (`lastKnownCount`), so a reader who
 * has seen the number once sees it again immediately and the fetch reconciles
 * behind it. Own state is deliberately NOT remembered: it is per-account, and a
 * stale "Following" would be this module asserting something about the person
 * holding the phone rather than about the world.
 */

import type { LikeSubject, Hex0x } from "@woco/shared";
import { requireAccountForAction } from "../auth/ensure-action.js";
import { get } from "./client.js";
import { readMyStatement, writeMyStatement, type SocialKind } from "../social/social.js";
import { readCachedCount, writeCachedCount } from "../social/count-cache.js";

export interface SocialState {
  liked: boolean;
  /** null until an indexer publishes tallies — never conflate with 0. */
  count: number | null;
}

/** A "follow" pill writes a follow; every other variant writes a like. */
export function kindForVariant(variant: "heart" | "follow"): SocialKind {
  return variant === "follow" ? "follow" : "like";
}

/** The statement format each kind tallies under, for the indexer query. */
const FORMAT: Record<SocialKind, string> = {
  like: "woco.like.v1",
  follow: "woco.follow.v1",
};

/**
 * The public count, or null if nobody could tell us. Never throws: a count is
 * decoration on a button that works without it, so an unreachable indexer must
 * degrade to "no number" rather than to a broken control.
 *
 * A number that arrives is remembered; a failure writes nothing, so the last
 * good figure outlives the outage rather than being overwritten by not knowing.
 */
async function fetchCount(kind: SocialKind, subject: Hex0x): Promise<number | null> {
  try {
    const res = await get<{ count: number }>(
      `/api/social/count?format=${encodeURIComponent(FORMAT[kind])}&subject=${encodeURIComponent(subject)}`,
    );
    const count = res.ok && res.data && typeof res.data.count === "number" ? res.data.count : null;
    if (count !== null) writeCachedCount(kind, subject, count);
    return count;
  } catch {
    return null;
  }
}

/**
 * The last count this browser saw for a subject, or null if it has never seen
 * one. Synchronous on purpose: the point is to have a number in hand at first
 * render, not one promise sooner.
 *
 * Age is not reported alongside it because the caller has nowhere honest to put
 * it — the value is either fresh enough to show or evicted (`TTL.SOCIAL_COUNT`).
 */
export function lastKnownCount(kind: SocialKind, subject: LikeSubject): number | null {
  return readCachedCount(kind, subject.id as Hex0x);
}

/**
 * The caller's own state for a subject, plus the public count.
 *
 * The two are fetched CONCURRENTLY and fail independently, because they come
 * from different places and one failing says nothing about the other: own state
 * is a read of the user's own feed, the count is an indexer's tally over many.
 * Never throws — a display path that cannot read should show "not liked", not
 * an error, and the next visit re-reads.
 */
export async function getSocialState(kind: SocialKind, subject: LikeSubject): Promise<SocialState> {
  const id = subject.id as Hex0x;
  const [liked, count] = await Promise.all([
    readMyStatement(kind, id).catch(() => null),
    fetchCount(kind, id),
  ]);
  return { liked: liked === true, count };
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

  // Deliberately no count refetch. The statement has only just been relayed and
  // the indexer caches for 30s, so an immediate re-ask returns the number from
  // BEFORE this toggle — which would overwrite a correct optimistic value with
  // a stale one and make the button appear to undo itself. The caller keeps its
  // optimistic count; the next natural load reconciles.
  return { liked: next, count: null };
}
