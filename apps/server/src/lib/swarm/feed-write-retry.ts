/**
 * What a feed write does with an error (#120).
 *
 * Pure decision, so the table can be tested without a bee. `writeFeedPage`'s
 * retry loop asks this after every failed attempt and acts on the answer.
 *
 * A **409** would mean "a chunk already exists at this feed index": with one
 * signer for every feed, a stale cached index. Bee 2.7.1's `/soc` never answers
 * it (a failed put is a 400; a re-upload of a taken index is a 201 that keeps
 * the old bytes, `pkg/api/soc.go`), so the branch is kept only in case a
 * gateway does. What actually catches a taken index is the read-back in
 * `writeFeedPage` (#186). On a 409: re-resolve the index, write again, bounded.
 * A `fresh` write (caller asserted "never written") that 409s is NOT a stale
 * cache — it is a violated assumption, and the caller must see it rather than
 * have the write silently appended to a feed it believed it was creating.
 *
 * A **404** from a SOC upload is "batch not found", never "feed empty". It used
 * to rewrite at index 0, which on an existing feed is a lost write (#186).
 */

export type FeedWriteRetryAction =
  /** Transient transport/5xx/429/423 — same index, after a backoff. */
  | { action: "retry-transient" }
  /** 409: drop the cached index, re-discover the real next one, write again after a backoff. */
  | { action: "rediscover-index" }
  | { action: "throw" };

export interface FeedWriteErrorFacts {
  /** HTTP status of the failure, when it had one. */
  status: number | undefined;
  /** `isTransientFeedError(err)` — network / 5xx / 429 / 423. */
  transient: boolean;
  /** 0-based attempt that just failed. */
  attempt: number;
  /** Total attempts the loop allows. */
  maxAttempts: number;
  /** Writing through the Etherna gateway (explicit index, raw SOC). */
  etherna: boolean;
  /** Caller asserted the topic has never been written (`fresh: true`). */
  fresh: boolean;
}

export function decideFeedWriteRetry(f: FeedWriteErrorFacts): FeedWriteRetryAction {
  const last = f.attempt >= f.maxAttempts - 1;
  if (f.transient && !last) return { action: "retry-transient" };
  if (f.status === 409 && !f.fresh && !last) return { action: "rediscover-index" };
  return { action: "throw" };
}
