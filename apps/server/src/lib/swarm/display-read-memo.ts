/**
 * Memo for DISPLAY reads of a feed-backed list: what a page shows, never the
 * base of a write. Write paths read strictly and never consult it.
 *
 * Three answers from `load`, and the middle one is why this exists:
 *  - something there: reused for `ttlMs`;
 *  - definitely nothing there (bee says the feed was never written, or it holds
 *    an empty list): reused for `emptyTtlMs`. Each re-ask of a never-written
 *    feed is a retrieval miss on its index-0 chunk, and a few misses inside a
 *    minute put that chunk on bee 2.8's one-minute skip list, after which the
 *    write that would create the feed cannot read it either (first-write-retry.ts);
 *  - could not be read: never memoized. A read that could not answer is not "nothing".
 *
 * Concurrent callers share one read. `invalidate` (call it after a write) drops
 * the memo and detaches a read in flight: that read still answers its own
 * caller, but nobody joins it and it is not memoized, since it may have started
 * before the write.
 */

export type DisplayRead<T> = { status: "ok"; data: T } | { status: "error" };

export interface DisplayReadMemoOptions<T> {
  ttlMs: number;
  emptyTtlMs: number;
  isEmpty: (data: T) => boolean;
  /** Keys held at most; the oldest goes first. Default 1024. */
  maxKeys?: number;
}

export interface DisplayReadMemo<T> {
  read(key: string, load: () => Promise<DisplayRead<T>>, opts?: { fresh?: boolean }): Promise<DisplayRead<T>>;
  invalidate(key: string): void;
}

let clock = () => Date.now();

/** Tests only — pin the clock (every memo). */
export const __displayReadMemoTestHooks = {
  setClock(fn: (() => number) | null): void {
    clock = fn ?? (() => Date.now());
  },
};

export function createDisplayReadMemo<T>(opts: DisplayReadMemoOptions<T>): DisplayReadMemo<T> {
  const maxKeys = opts.maxKeys ?? 1024;
  const memo = new Map<string, { at: number; data: T }>();
  const inFlight = new Map<string, Promise<DisplayRead<T>>>();

  return {
    async read(key, load, { fresh = false } = {}) {
      if (!fresh) {
        const m = memo.get(key);
        if (m && clock() - m.at < (opts.isEmpty(m.data) ? opts.emptyTtlMs : opts.ttlMs)) return { status: "ok", data: m.data };
        const joined = inFlight.get(key);
        if (joined) return joined;
      }
      const p = load().catch((): DisplayRead<T> => ({ status: "error" }));
      inFlight.set(key, p);
      try {
        const res = await p;
        if (res.status === "ok" && inFlight.get(key) === p) {
          memo.delete(key);
          memo.set(key, { at: clock(), data: res.data });
          if (memo.size > maxKeys) memo.delete(memo.keys().next().value!);
        }
        return res;
      } finally {
        if (inFlight.get(key) === p) inFlight.delete(key);
      }
    },
    invalidate(key) {
      memo.delete(key);
      inFlight.delete(key);
    },
  };
}
