/**
 * Sliding-window rate limiter, in memory.
 *
 * Split out of `routes/broadcast.ts` so the check and the consume are two
 * explicit steps. They have to be, because the check is worth running twice: an
 * early advisory pass bounds expensive work (the attendee verification costs one
 * Swarm read per series), and a second authoritative pass under a lock is what
 * actually binds. Checking once and recording after a slow send is the race that
 * let N concurrent requests all pass the same limit.
 *
 * Keys are lowercased by the caller's convention (addresses) — see `RateWindow`
 * usage. In-memory by design: the limit is abuse friction, not an accounting
 * record, so losing it on restart is acceptable.
 */

export class RateWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  /** Read-only. A caller that intends to consume must hold the relevant lock. */
  isLimited(key: string, now: number = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  /** Consume one slot. Only safe under the lock the caller checked beneath. */
  record(key: string, now: number = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }
}
