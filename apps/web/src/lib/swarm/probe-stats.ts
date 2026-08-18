/**
 * Counts Swarm chunk probes, so latency work can be MEASURED rather than
 * reasoned about.
 *
 * This exists because reasoning about it failed. Four separate rounds of "the
 * tap no longer reads" were reported from stack traces and code inspection;
 * one of them was wrong — a `knownVersion` silently dropped by a spread — and
 * only a browser trace caught it. A probe count per action would have caught it
 * in seconds.
 *
 * WHAT A PROBE COSTS, and why this is the right unit: the expensive thing is
 * not the HTTP request, it is a MISS. A probe past a feed's latest version is a
 * bee network search for a chunk that does not exist — seconds, and it queues
 * behind every other retrieval on the node. That is the pattern that melted the
 * bee in July 2026 and got `VERSION_PROBE_WINDOW` cut to 2. So misses are
 * counted apart from hits: two actions with the same request count can differ
 * by an order of magnitude in cost.
 *
 * DEV ONLY. `report()` no-ops outside a dev build, and nothing here is on a
 * code path that changes behaviour — it counts and it prints.
 */

export interface ProbeCounts {
  /** Resolved from the storage gateway — cheap, the bee had it. */
  gatewayHit: number;
  /** Gateway said no. The expensive one: a network search that found nothing. */
  gatewayMiss: number;
  /** Resolved from the platform API after the gateway missed. */
  serverHit: number;
  /** Neither source had it — a full miss, paid twice. */
  serverMiss: number;
}

const zero = (): ProbeCounts => ({ gatewayHit: 0, gatewayMiss: 0, serverHit: 0, serverMiss: 0 });

let counts = zero();

export function countProbe(kind: keyof ProbeCounts): void {
  counts[kind] += 1;
}

/** A copy of the running totals. */
export function probeCounts(): ProbeCounts {
  return { ...counts };
}

export function resetProbeCounts(): void {
  counts = zero();
}

/** Total probes, and the subset that cost a network search. */
export function probeTotals(c: ProbeCounts): { probes: number; misses: number } {
  return {
    probes: c.gatewayHit + c.gatewayMiss + c.serverHit + c.serverMiss,
    misses: c.gatewayMiss + c.serverMiss,
  };
}

/**
 * Time an action and print what it cost in probes.
 *
 * Returns the action's own result untouched, so it can wrap a call without
 * changing it — instrumentation that alters what it measures is worse than
 * none.
 */
export async function measured<T>(label: string, action: () => Promise<T>): Promise<T> {
  if (!import.meta.env?.DEV) return action();

  const before = probeCounts();
  const started = performance.now();
  try {
    return await action();
  } finally {
    const after = probeCounts();
    const delta: ProbeCounts = {
      gatewayHit: after.gatewayHit - before.gatewayHit,
      gatewayMiss: after.gatewayMiss - before.gatewayMiss,
      serverHit: after.serverHit - before.serverHit,
      serverMiss: after.serverMiss - before.serverMiss,
    };
    const { probes, misses } = probeTotals(delta);
    const ms = Math.round(performance.now() - started);
    // One line, deliberately: this is read against a stopwatch, not parsed.
    console.info(
      `[probes] ${label}: ${ms}ms · ${probes} probes (${misses} miss) ` +
        `· gw ${delta.gatewayHit}/${delta.gatewayMiss} · api ${delta.serverHit}/${delta.serverMiss}`,
    );
  }
}
