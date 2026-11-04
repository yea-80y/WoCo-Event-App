/**
 * Waiting out the SOC relay's write budget (`apps/server/src/lib/swarm/soc-relay-limits.ts`
 * REASON_CALLER / REASON_GLOBAL; a test pins the wording). For a write larger than one
 * minute's budget - a 200,000-seat seat state is ~100 chunks - rather than failing half
 * way. Safe to repeat: a re-sent signed chunk is byte-identical. Opt-in
 * (`writeContentFeed({ paceWhenBusy })`): an everyday write should fail fast instead.
 */

const RELAY_BUSY = ["Too many writes", "write relay is busy"];
export const PACE_MS = [5_000, 15_000, 30_000, 60_000];

export function isRelayBusy(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return RELAY_BUSY.some((s) => msg.includes(s));
}

/** `send`, retried after each of PACE_MS while the relay says it is over budget. */
export async function pacedSend<T>(send: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (err) {
      if (!isRelayBusy(err) || i >= PACE_MS.length) throw err;
      await sleep(PACE_MS[i]!);
    }
  }
}
