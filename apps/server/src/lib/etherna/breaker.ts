/**
 * A short circuit breaker on Etherna (#657), shared by reads and writes (#912).
 *
 * Every Etherna-family scan ends with a question to Etherna, the event money
 * path's included, so an Etherna that HANGS would cost every such read the full
 * timeout (the token request and the chunk read, up to 18 s). After a SLOW
 * failure - no answer, or an unhappy one, that took `ETHERNA_SLOW_MS` or more (a
 * timeout, a proxy's 504 after its own wait, a hung sign-in) - Etherna is not
 * asked again for `ETHERNA_BREAKER_MS`: reads say `unavailable` at once, which
 * is what they would have said anyway, and the relay's failover stamps on WoCo
 * without waiting out its own Etherna attempt first.
 *
 * A FAST failure does not trip it: a quick 503 costs no latency, and pausing on
 * one would turn a single blip into 30 s of refused writes for every Etherna
 * family, the client's included (they probe through here).
 *
 * Its own module so the Etherna upload code can trip it without importing the
 * reader, which imports the upload code.
 */

export const ETHERNA_BREAKER_MS = 30_000;
export const ETHERNA_SLOW_MS = 3_000;

const breaker = {
  openUntil: 0,
  reason: null as string | null,
  trips: 0,
  now: () => Date.now(),
  slowMs: ETHERNA_SLOW_MS,
};

/** Is Etherna paused after a slow failure? Then nobody waits on it. */
export function ethernaPaused(): string | null {
  return breaker.now() < breaker.openUntil ? (breaker.reason ?? "paused") : null;
}

/**
 * An Etherna call failed. `startedAt` is `performance.now()` when it began:
 * real elapsed time, whatever clock the breaker is on.
 */
export function noteEthernaFailure(reason: string, startedAt: number): void {
  if (performance.now() - startedAt < breaker.slowMs) return;
  if (breaker.now() >= breaker.openUntil) {
    breaker.trips++;
    console.warn(`[swarm] Etherna paused for ${ETHERNA_BREAKER_MS / 1000}s: ${reason}`);
  }
  breaker.openUntil = breaker.now() + ETHERNA_BREAKER_MS;
  breaker.reason = reason;
}

export function ethernaBreakerHealth(): { open: boolean; reopensAt?: string; reason?: string | null; trips: number } {
  const open = breaker.now() < breaker.openUntil;
  return {
    open,
    ...(open ? { reopensAt: new Date(breaker.openUntil).toISOString(), reason: breaker.reason } : {}),
    trips: breaker.trips,
  };
}

/** Test seam: close the breaker, and optionally pin its clock and what counts as slow. */
export function __resetEthernaBreaker(opts: { now?: () => number; slowMs?: number } = {}): void {
  breaker.openUntil = 0;
  breaker.reason = null;
  breaker.trips = 0;
  breaker.now = opts.now ?? (() => Date.now());
  breaker.slowMs = opts.slowMs ?? ETHERNA_SLOW_MS;
}
