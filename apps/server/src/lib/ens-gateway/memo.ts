/**
 * Short-lived memo for signed CCIP-Read answers (#465 §2).
 *
 * The gateway is an unauthenticated public GET whose every miss costs an
 * `eth_call` (two, since the cross-check). A flood therefore exhausts the RPC
 * quota, and an exhausted quota is not a slow gateway — it is a 502 on every
 * lookup, which means every `*.woco.eth` name stops resolving. Cloudflare does
 * NOT absorb this path today (`cf-cache-status: DYNAMIC`, re-confirmed against
 * production 2026-09-02), so the first cache in front of the RPC has to be here.
 *
 * WHY RE-SERVING A SIGNATURE IS SAFE. The stored value is the whole signed
 * response, and what makes it self-limiting is `expires`: the signature commits
 * to an absolute deadline that the L1 resolver checks itself. Handing the same
 * bytes to a second caller cannot extend that deadline, and there is nothing
 * caller-specific in the response to leak — it is bound to (resolver, request,
 * result, expires) and to nothing else. So the memo is a pure request-collapser.
 *
 * TWO INDEPENDENT EXPIRIES, deliberately:
 *   - `ttlMs` bounds how stale a RECORD may be. A record edited on L2 keeps
 *     resolving to its old value for at most this long.
 *   - `expiresAt` (the signature's own deadline, checked again on every hit) is
 *     what stops an entry from ever being served past the point the resolver
 *     would reject it. Belt to the braces: the caller clamps `ttlMs` well below
 *     the signature TTL, and this check means a clock jump or a future
 *     mis-clamping still cannot serve a dead signature.
 *
 * BOUNDED BY CONSTRUCTION. An attacker can mint unbounded distinct keys — every
 * unregistered `*.woco.eth` name still produces a valid signed "unset" — so an
 * unbounded Map here would be the #163 defect on the very route that exists to
 * bound a caller. Capacity is capped and eviction is least-recently-STORED.
 */

export interface MemoEntry<T> {
  value: T;
  /** UNIX SECONDS — the signature's own deadline, not the memo's. */
  expiresAt: bigint;
  /** ms — when this entry stops being fresh enough to serve. */
  staleAt: number;
}

export class ResponseMemo<T> {
  private readonly entries = new Map<string, MemoEntry<T>>();

  constructor(
    /** How long an entry may be served. Must be well under the signature TTL. */
    private readonly ttlMs: number,
    /** Hard cap on entries held at once — the memory bound. */
    private readonly maxEntries = 5_000,
  ) {
    if (!(ttlMs > 0)) throw new Error(`ResponseMemo: ttlMs must be > 0, got ${ttlMs}`);
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`ResponseMemo: maxEntries must be a positive integer, got ${maxEntries}`);
    }
  }

  /** The stored answer for `key`, or null when there is nothing fresh AND still valid. */
  get(key: string, now = Date.now()): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    // Stale by the memo's own clock, or past the deadline the signature commits
    // to. Either way the entry is spent — drop it rather than leave it to be
    // re-tested on every subsequent request.
    if (now >= hit.staleAt || BigInt(Math.floor(now / 1000)) >= hit.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  /** Store a signed answer. Callers must only ever store a SIGNED 200. */
  set(key: string, value: T, expiresAt: bigint, now = Date.now()): void {
    // Re-insert so Map order is least-recently-stored first (the eviction order).
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt, staleAt: now + this.ttlMs });
    this.prune(now);
  }

  /** Entries currently held — surfaced on /api/health so the memo is observable. */
  size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    if (this.entries.size <= this.maxEntries) return;
    // 1. Anything already stale holds nothing useful, whatever its position.
    for (const [k, e] of this.entries) {
      if (now >= e.staleAt) this.entries.delete(k);
    }
    // 2. Still over: evict the head, which insertion order makes the stalest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Target freshness window for a memoised answer (#465 §2 says 30s).
 * "Well below the signature's own TTL" is the requirement; see {@link memoTtlMsFor}.
 */
export const MEMO_TTL_MS = 30_000;

/**
 * The memo window actually used for a given signature TTL.
 *
 * Clamped to half the signature's life so the invariant "a memoised answer
 * always has at least half its TTL left when served" holds even at the minimum
 * configurable TTL. Without the clamp, a future TTL below the memo window would
 * let a hit return a signature the resolver has already stopped accepting — a
 * hard resolution failure rather than a stale-but-usable one.
 */
export function memoTtlMsFor(signatureTtlSeconds: number): number {
  return Math.max(1, Math.min(MEMO_TTL_MS, Math.floor((signatureTtlSeconds * 1000) / 2)));
}
