/**
 * "Storage is busy for about a minute": bee 2.8's skip list on a chunk nobody
 * has written (#943).
 *
 * Every peer that fails to return a chunk goes on a node-wide skip list for that
 * chunk for one minute (`pkg/retrieval`, `skiplistDur`). A feed that was never
 * written misses on every read of its index-0 chunk, so a few reads inside a
 * minute (a page opening, say) leave no peer to ask, and every read of it fails
 * fast until the minute is up: `GET /feeds` 404 "lookup at failed", `GET /chunks`
 * 500 "read chunk failed". That is not "absent" (#186: an unreadable feed is
 * never empty, or the write would wipe what it could not read), so the first
 * save of a new site refuses - and trying again inside the minute fails again.
 *
 * This error only NAMES that refusal so a route can say "try again in a minute"
 * and the client can do it once by itself. It changes no read's classification:
 * every place that throws it threw a plain Error for the same answer before.
 */

/** The skip-list window (1 min) plus a margin for the entries added last. */
export const STORAGE_BUSY_RETRY_MS = 65_000;

/** `ApiResponse.code` for the refusal; the client branches on it. */
export const STORAGE_BUSY_CODE = "STORAGE_BUSY";

export const STORAGE_BUSY_MESSAGE =
  "Storage needs about a minute before this first save can go through - please try again shortly.";

export class FeedLookupCooldownError extends Error {
  readonly code = STORAGE_BUSY_CODE;
  readonly retryAfterMs = STORAGE_BUSY_RETRY_MS;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FeedLookupCooldownError";
  }
}

export function isStorageBusy(err: unknown): err is FeedLookupCooldownError {
  return err instanceof FeedLookupCooldownError;
}

/** The typed 503 body every route answers with (`Retry-After` goes with it). */
export function storageBusyBody(): { ok: false; error: string; code: string; retryAfterMs: number } {
  return { ok: false, error: STORAGE_BUSY_MESSAGE, code: STORAGE_BUSY_CODE, retryAfterMs: STORAGE_BUSY_RETRY_MS };
}

/** `Retry-After` in whole seconds. */
export const STORAGE_BUSY_RETRY_AFTER_HEADER = String(Math.ceil(STORAGE_BUSY_RETRY_MS / 1000));
