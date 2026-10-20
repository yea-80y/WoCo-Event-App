/**
 * The server's "storage needs about a minute" refusal (#943, `STORAGE_BUSY`).
 *
 * The first save of a new site can meet our storage node's one-minute pause on
 * a record nobody has written yet. The server refuses that save rather than
 * guess (nothing it could not check is ever written), and says how long to wait.
 * Trying again inside the minute fails the same way, so the request is sent once
 * more after `retryAfterMs`, by itself, and the screen says what is happening.
 */

import type { ApiResponse } from "@woco/shared";

export const STORAGE_BUSY_CODE = "STORAGE_BUSY";

/** Used when the refusal carries no usable wait. */
const DEFAULT_WAIT_MS = 65_000;
/** A wait outside this is a server bug, not a reason to hang a save. */
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 120_000;

export interface StorageBusyRetryOptions {
  /** Told the wait before the retry, so the screen can say "this can take about a minute". */
  onWait?: (ms: number) => void;
  /** Aborted (the screen went away): no retry is sent, and the wait rejects with an AbortError. */
  signal?: AbortSignal;
}

export function isStorageBusy(resp: { ok: boolean; code?: string }): boolean {
  return !resp.ok && resp.code === STORAGE_BUSY_CODE;
}

/** The refusal's `retryAfterMs`, bounded; the default when absent or unusable. */
export function storageBusyWaitMs(resp: unknown): number {
  const v = (resp as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, v));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException("The save was cancelled", "AbortError");
}

let sleep = defaultSleep;

/** Tests only — replace the wait. */
export const __storageBusyTestHooks = {
  setSleep(fn: ((ms: number, signal?: AbortSignal) => Promise<void>) | null): void {
    sleep = fn ?? defaultSleep;
  },
};

/**
 * `send()`, and once more after the server's wait if it answered STORAGE_BUSY.
 * A second STORAGE_BUSY is returned as it is, for the caller to show.
 */
export async function retryOnceIfStorageBusy<T>(
  send: () => Promise<ApiResponse<T>>,
  opts: StorageBusyRetryOptions = {},
): Promise<ApiResponse<T>> {
  const first = await send();
  if (!isStorageBusy(first)) return first;
  const wait = storageBusyWaitMs(first);
  opts.onWait?.(wait);
  await sleep(wait, opts.signal); // rejects on abort: no second request
  return send();
}
