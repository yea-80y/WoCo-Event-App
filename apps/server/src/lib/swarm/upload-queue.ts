/**
 * Global concurrency guard for Bee upload requests.
 *
 * Bee's local node enforces a per-connection rate limit on upload endpoints
 * (SOC, /bytes). When multiple concurrent uploads arrive simultaneously —
 * e.g. sites/publish writing 3 feed topics at once while a prepare-order
 * call is also uploading — Bee responds with HTTP 429 "Too many upload requests".
 *
 * The semaphore is held only for the duration of the individual HTTP call, NOT
 * across retry back-off sleeps. A throttled slot releases immediately on 429 so
 * callers aren't blocked by each other's back-off wait.
 */

const MAX_CONCURRENT = 2;

/**
 * Per-call timeout for a single Bee HTTP request (NOT including retry backoff).
 * Chosen well above any healthy /bytes or SOC write (sub-second with
 * deferred=true) but well under upstream stream timeouts — Cloudflare's QUIC
 * edge drops idle streams after ~100s, and we've observed the Bee silently
 * parking writes for ~300s. Surfacing as ETIMEDOUT lets isTransient*Error
 * catch and retry, and lets the streamText response emit an error chunk
 * instead of the connection being killed mid-flight by the edge.
 */
export const BEE_CALL_TIMEOUT_MS = 60_000;

/**
 * Per-call timeout for a Bee /bzz tar collection upload. Higher than the
 * single-chunk timeout because tars can be megabytes (whole site bundle) and
 * legitimately take longer. Kept under Cloudflare's 100s edge timeout so a
 * stuck upload surfaces as a JSON error to the client instead of a 524.
 */
export const BEE_COLLECTION_TIMEOUT_MS = 90_000;

/**
 * Hard-timeout a promise. Rejects with Error{code:"ETIMEDOUT"} on timeout,
 * which the retry classifiers in bytes.ts / feeds.ts already treat as transient.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${ms}ms`) as Error & { code: string };
          err.code = "ETIMEDOUT";
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.queue.shift()?.();
    };
  }
}

export const beeUploadSem = new Semaphore(MAX_CONCURRENT);
