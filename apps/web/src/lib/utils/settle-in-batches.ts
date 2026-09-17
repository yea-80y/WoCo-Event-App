/**
 * `Promise.allSettled` with at most `limit` calls in flight, results in input
 * order. For per-row reads (one Swarm read per invite or follow) that must not
 * fan out all at once against one gateway.
 */
export async function settleInBatches<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await run(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
