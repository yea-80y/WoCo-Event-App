/**
 * Sliding-window rate limiter for routes that SPEND something on a caller's
 * behalf — postage (a 4096-byte chunk per feed/SOC write), chain reads, gas.
 *
 * One module, because the routes that needed one each grew a private copy
 * (likes, campaign, shops, agent — four shapes of the same twelve lines) and none
 * of them bounds its memory: every copy keys a Map on caller-chosen input and
 * never evicts, so a caller who varies the key grows the process without limit.
 * That is the #163 class of defect, on routes whose whole purpose is to bound a
 * caller. The limiter here caps its key count and evicts the least recently
 * touched key first.
 *
 * Windows are checked together: `[{ 10/min }, { 60/hour }]` allows a short burst
 * AND caps the sustained rate, which is what "sized for human cadence" needs — a
 * publish legitimately writes a dozen chunks in a few seconds, and nobody
 * legitimately does that continuously.
 *
 * Deliberately not a middleware: the key is the route's decision (parent address,
 * normalised client IP, both), and a route may want to PEEK every key before
 * RECORDING any so a request refused on its second key has not already been
 * charged against its first. `allowAll` does exactly that.
 */

export interface RateWindow {
  /** Maximum hits allowed inside `windowMs`. */
  limit: number;
  windowMs: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly longestMs: number;
  /** Per-key history is trimmed to the largest `limit` — keeping more can never
   *  change an answer, and it bounds per-key memory as well as key count. */
  private readonly keepMax: number;

  constructor(
    private readonly windows: readonly RateWindow[],
    /** Hard cap on distinct keys held at once (the memory bound). */
    private readonly maxKeys = 10_000,
  ) {
    if (windows.length === 0) throw new Error("SlidingWindowLimiter: at least one window");
    for (const w of windows) {
      if (!Number.isInteger(w.limit) || w.limit < 1) throw new Error(`SlidingWindowLimiter: bad limit ${w.limit}`);
      if (!(w.windowMs > 0)) throw new Error(`SlidingWindowLimiter: bad windowMs ${w.windowMs}`);
    }
    this.longestMs = Math.max(...windows.map((w) => w.windowMs));
    this.keepMax = Math.max(...windows.map((w) => w.limit));
  }

  /** Would a hit for `key` be allowed right now? Records nothing. */
  peek(key: string, now = Date.now()): boolean {
    const recent = this.hits.get(key);
    if (!recent) return true;
    for (const w of this.windows) {
      const since = now - w.windowMs;
      let n = 0;
      for (const t of recent) if (t > since) n++;
      if (n >= w.limit) return false;
    }
    return true;
  }

  /** Record a hit for `key` (whether or not the caller checked first). */
  record(key: string, now = Date.now()): void {
    const since = now - this.longestMs;
    const prev = this.hits.get(key);
    let recent = prev ? prev.filter((t) => t > since) : [];
    recent.push(now);
    if (recent.length > this.keepMax) recent = recent.slice(-this.keepMax);
    // Re-insert so Map order = least recently touched first (eviction order).
    this.hits.delete(key);
    this.hits.set(key, recent);
    this.prune(now);
  }

  /** Check-and-record for one key. */
  allow(key: string, now = Date.now()): boolean {
    if (!this.peek(key, now)) {
      // Drop expired history so a key that stays over the limit does not also
      // stay at its size ceiling forever.
      this.trim(key, now);
      return false;
    }
    this.record(key, now);
    return true;
  }

  /**
   * Check EVERY key, then record EVERY key — so a request refused on its second
   * key is not charged against its first. Refused requests are not recorded at
   * all: a caller already over one limit cannot use refusals to burn another.
   */
  allowAll(keys: readonly string[], now = Date.now()): boolean {
    for (const k of keys) {
      if (!this.peek(k, now)) {
        this.trim(k, now);
        return false;
      }
    }
    for (const k of keys) this.record(k, now);
    return true;
  }

  /** Distinct keys currently held — for tests and health reporting. */
  size(): number {
    return this.hits.size;
  }

  private trim(key: string, now: number): void {
    const recent = this.hits.get(key);
    if (!recent) return;
    const since = now - this.longestMs;
    const kept = recent.filter((t) => t > since);
    if (kept.length === 0) this.hits.delete(key);
    else if (kept.length !== recent.length) this.hits.set(key, kept);
  }

  private prune(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    // 1. Keys whose newest hit has aged out of every window hold nothing useful.
    const since = now - this.longestMs;
    for (const [k, ts] of this.hits) {
      if (ts.length === 0 || ts[ts.length - 1]! <= since) this.hits.delete(k);
    }
    // 2. Still over: evict least recently touched. Map order is insertion order
    //    and `record` re-inserts on every hit, so the head is the stalest key.
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value as string;
      this.hits.delete(oldest);
    }
  }
}
