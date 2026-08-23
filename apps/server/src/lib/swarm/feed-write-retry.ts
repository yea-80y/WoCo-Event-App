/**
 * What a feed write does with an error (#120).
 *
 * Pure decision, so the table can be tested without a bee. `writeFeedPage`'s
 * retry loop asks this after every failed attempt and acts on the answer.
 *
 * The one that matters: a **409** means "a chunk already exists at this feed
 * index". Every feed is written by the single platform signer, so a 409 is not
 * a concurrent writer — it is a STALE cached index. The cache is primed from
 * read responses without any ordering against writes, so a read that started
 * before a write landed can resolve after it and re-prime the cache backwards
 * (`readFeedPage` → `rememberNextIndex`). The old branch cleared the cache and
 * threw, which healed the NEXT call and failed this one — a self-healing blip
 * that cost the caller's operation (an event publish, a directory update; and
 * on the v1 rail it was a sale). Now: clear, re-discover, write again. A 409
 * can never corrupt — SOC immutability is what refused the write — so retrying
 * is safe by construction; it is only bounded so a broken lookup cannot spin.
 *
 * Re-discovery means: WoCo bee → upload without an index, bee-js calls
 * `findNextIndex` (a feed lookup); Etherna → our own strict read, because that
 * path posts a raw SOC and cannot delegate. A `fresh` write (caller asserted
 * "never written") that 409s is NOT a stale cache — it is a violated
 * assumption, and the caller must see it rather than have the write silently
 * appended to a feed it believed it was creating.
 */

export type FeedWriteRetryAction =
  /** Transient transport/5xx/429/423 — same index, after a backoff. */
  | { action: "retry-transient" }
  /** 404 on the chunk lookup (WoCo bee only, first attempt): drop cache, write at 0. */
  | { action: "reset-to-zero" }
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
  // WoCo path only: an Etherna 404 is a gateway/batch error, and blindly
  // rewriting at index 0 would dedupe against the existing SOC (lost write).
  if (!f.etherna && f.status === 404 && f.attempt === 0) return { action: "reset-to-zero" };
  if (f.status === 409 && !f.fresh && !last) return { action: "rediscover-index" };
  return { action: "throw" };
}
