/**
 * The last public count this browser actually saw, so a like or follow can
 * paint its number before the indexer answers (#311).
 *
 * Only OBSERVED tallies are remembered. The optimistic ±1 a button applies to
 * its own click is a guess about a number computed somewhere else, and storing
 * it would let one reader's tap come back later as the community's figure.
 *
 * The absent/zero distinction survives the cache. A miss reads back as `null`,
 * which the UI renders as no number at all — never as `0`, which would be a
 * claim that nobody liked it, and a browser that was never told cannot make it.
 */

import type { Hex0x } from "@woco/shared";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache/cache.js";
import type { SocialKind } from "./social.js";

/** A tally is a whole, non-negative number of statements — anything else is not one. */
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Last observed count for this subject, or null if none is remembered.
 *
 * Validated on the way OUT, not only on the way in: localStorage is editable
 * and shared with every other tab of this origin. Without the check a stored
 * `"12"` would render (a string passes `> 0`) and an object would render as
 * `[object Object]`.
 */
export function readCachedCount(kind: SocialKind, subject: Hex0x): number | null {
  const v = cacheGet<unknown>(cacheKey.socialCount(kind, subject));
  return isCount(v) ? v : null;
}

/** Remember a count an indexer actually returned. */
export function writeCachedCount(kind: SocialKind, subject: Hex0x, count: number): void {
  if (!isCount(count)) return;
  cacheSet(cacheKey.socialCount(kind, subject), count, TTL.SOCIAL_COUNT);
}
