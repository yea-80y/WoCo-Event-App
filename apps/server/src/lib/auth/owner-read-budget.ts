/**
 * Per-client budget for UNCACHED Kernel-owner chain reads (#163, #210).
 *
 * `verifyDelegation` runs before any authorization, so an unauthenticated caller
 * can send self-signed delegations naming an arbitrary `message.parent`. Every
 * new parent misses the owner cache and costs one eth_call on the shared public
 * RPC — the same RPC the payment path reads — and, until #210, a store write.
 * Varying the parent per request turned that into an RPC amplifier, and a
 * failing RPC is what puts known-deployed accounts into refuse (#208): the
 * attacker's lever was "make auth fail for everyone".
 *
 * What is bounded is the COST, not the request: only a read that would actually
 * reach the chain draws on the budget. Steady-state traffic (cache hits) never
 * touches it, so a legitimate account costs at most one unit per cache TTL per
 * device. A venue behind one address (#253's /64 concern) spends one unit per
 * cold device per TTL — the cap below is sized for that, not for per-request
 * volume. Over budget, the read is reported as `"error"` and the existing rules
 * decide: refuse for a known-deployed account, counterfactual for an unknown one
 * — never a grant the chain did not give.
 *
 * Sliding window over a bounded map: entries older than the window are dropped
 * on access, and the map itself is capped so the budget cannot become the thing
 * that grows — at the cap, the oldest window is evicted to admit a newcomer,
 * because auth availability for a new legitimate client outranks exactness of a
 * ten-thousand-address caller's accounting. Residual stated plainly: a
 * distributed caller still reaches the RPC at `cap × addresses` per window; the
 * edge (Cloudflare) is the layer for that, not this module.
 */

const WINDOW_MS = 60_000;
/** Uncached owner reads a single client address may trigger per window. */
const READS_PER_WINDOW = 120;
/** Hard cap on tracked client addresses — a sweep runs when it is reached. */
const MAX_TRACKED_CLIENTS = 10_000;

interface Window {
  start: number;
  count: number;
}

const _windows = new Map<string, Window>();

/** Test seams — a fake clock and a reset; null restores Date.now. */
let _now: (() => number) | null = null;
export function _setOwnerReadBudgetClockForTests(now: (() => number) | null): void {
  _now = now;
}
export function _resetOwnerReadBudgetForTests(): void {
  _windows.clear();
}
const now = () => (_now ? _now() : Date.now());

function sweep(t: number): void {
  for (const [k, w] of _windows) {
    if (t - w.start >= WINDOW_MS) _windows.delete(k);
  }
}

/**
 * Spend one unit of `clientKey`'s read budget. True = the read may proceed.
 *
 * Called only at the moment a chain read is about to happen — cache hits, and
 * requests that never reach the owner check, cost nothing.
 */
export function takeOwnerReadBudget(clientKey: string): boolean {
  const t = now();
  let w = _windows.get(clientKey);
  if (!w || t - w.start >= WINDOW_MS) {
    if (!w && _windows.size >= MAX_TRACKED_CLIENTS) {
      sweep(t);
      // Still full after the sweep: every tracked client is inside the window.
      // Evict the oldest-started one and admit the newcomer — the evicted client
      // merely gets a fresh window early, which is a small inexactness in the
      // accounting of whoever is saturating the map, not a grant of anything.
      if (_windows.size >= MAX_TRACKED_CLIENTS) {
        let oldestKey: string | undefined;
        let oldestStart = Infinity;
        for (const [k, ww] of _windows) {
          if (ww.start < oldestStart) {
            oldestStart = ww.start;
            oldestKey = k;
          }
        }
        if (oldestKey !== undefined) _windows.delete(oldestKey);
      }
    }
    w = { start: t, count: 0 };
    _windows.set(clientKey, w);
  }
  if (w.count >= READS_PER_WINDOW) return false;
  w.count++;
  return true;
}

/** For tests and /api/health: how many client addresses are currently tracked. */
export function ownerReadBudgetTrackedClients(): number {
  return _windows.size;
}
