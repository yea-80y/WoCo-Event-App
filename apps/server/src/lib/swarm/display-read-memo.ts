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
 *
 * `staleMs` (off by default): a page visited a few times an hour would otherwise
 * find the memo expired on almost every visit and pay the whole cold read. Past
 * `ttlMs`, a populated entry is answered at once for up to `staleMs` more while
 * one read refreshes it behind; an empty entry never is, so something just
 * created is not hidden for that long.
 */

/** `keep: false`: an answer the caller may show but that must not be memoized (it leaned on a fallback). */
export type DisplayRead<T> = { status: "ok"; data: T; keep?: false } | { status: "error" };

export interface DisplayReadMemoOptions<T> {
  ttlMs: number;
  emptyTtlMs: number;
  isEmpty: (data: T) => boolean;
  /** Keys held at most; the oldest goes first. Default 1024. */
  maxKeys?: number;
  /** Past `ttlMs`, how long a populated entry is still answered while it refreshes behind. Default 0. */
  staleMs?: number;
}

export interface DisplayReadMemo<T> {
  read(key: string, load: () => Promise<DisplayRead<T>>): Promise<DisplayRead<T>>;
  invalidate(key: string): void;
  /** `invalidate` for every key that starts with `prefix`. */
  invalidatePrefix(prefix: string): void;
  /** Drops every memoized entry `match` picks, and detaches EVERY read in flight (its data is not known yet). */
  invalidateWhere(match: (data: T, key: string) => boolean): void;
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
  const staleMs = opts.staleMs ?? 0;
  const memo = new Map<string, { at: number; data: T }>();
  const inFlight = new Map<string, Promise<DisplayRead<T>>>();

  function start(key: string, load: () => Promise<DisplayRead<T>>): Promise<DisplayRead<T>> {
    // Inside an async function: a load that throws before returning a promise
    // is an error answer too, never a rejection out of a display read.
    const p = (async () => load())().catch((): DisplayRead<T> => ({ status: "error" }));
    inFlight.set(key, p);
    return p.then((res) => {
      if (res.status === "ok" && res.keep !== false && inFlight.get(key) === p) {
        memo.delete(key);
        memo.set(key, { at: clock(), data: res.data });
        if (memo.size > maxKeys) memo.delete(memo.keys().next().value!);
      }
      if (inFlight.get(key) === p) inFlight.delete(key);
      return res;
    });
  }

  return {
    async read(key, load) {
      const m = memo.get(key);
      if (m) {
        const age = clock() - m.at;
        const empty = opts.isEmpty(m.data);
        if (age < (empty ? opts.emptyTtlMs : opts.ttlMs)) return { status: "ok", data: m.data };
        if (!empty && age < opts.ttlMs + staleMs) {
          if (!inFlight.has(key)) void start(key, load);
          return { status: "ok", data: m.data };
        }
      }
      return inFlight.get(key) ?? start(key, load);
    },
    invalidate(key) {
      memo.delete(key);
      inFlight.delete(key);
    },
    invalidatePrefix(prefix) {
      for (const key of [...memo.keys()]) if (key.startsWith(prefix)) memo.delete(key);
      for (const key of [...inFlight.keys()]) if (key.startsWith(prefix)) inFlight.delete(key);
    },
    invalidateWhere(match) {
      for (const [key, m] of [...memo.entries()]) if (match(m.data, key)) memo.delete(key);
      inFlight.clear();
    },
  };
}
