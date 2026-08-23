/**
 * Bounded parallel map.
 *
 * The point is the ceiling, not the speed. An unbounded `Promise.all` over a
 * per-item network call scales its burst with someone else's data — the number
 * of tickets an organiser sold, the number of slots on a contract — so the
 * busiest event is the one that trips the provider's rate limit. A fixed number
 * of workers draining a shared cursor keeps the burst flat no matter how large
 * the input grows.
 *
 * Results stay in input order regardless of completion order, so callers can
 * index into them by the position they passed in.
 *
 * Lifted verbatim from `routes/checkin.ts`, where it already guarded exactly
 * this read (#201). It lives here so the orders route uses the same ceiling
 * rather than a second copy that can drift.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/**
 * How many contract slot reads may be in flight at once.
 *
 * Every slot is one `eth_call` to the RPC provider. Eight is what the door
 * scanner's pack build has used against the same contract and the same provider
 * since it shipped, so it is a measured ceiling rather than a guess.
 */
export const SLOT_READ_CONCURRENCY = 8;
