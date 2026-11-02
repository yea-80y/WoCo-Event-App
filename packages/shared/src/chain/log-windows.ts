/**
 * Paging for `eth_getLogs` scans. Public endpoints cap a query's block range (the
 * Arbitrum One public RPC refuses more than 10,000,000 blocks, measured 2026-11-01), so
 * every scan from a deploy block to the head is cut into windows no wider than that.
 */

export const LOG_SCAN_WINDOW = 10_000_000;

/** Inclusive `[from, to]` ranges covering `start..latest`, none wider than `size`. */
export function logScanWindows(start: number, latest: number, size = LOG_SCAN_WINDOW): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = start; from <= latest; from += size) out.push([from, Math.min(from + size - 1, latest)]);
  return out;
}
