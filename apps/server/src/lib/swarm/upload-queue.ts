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

// Raised 2→6: the per-chunk Etherna offer-register await was removed (bytes.ts is
// now fire-and-forget), so an upload is a single /bytes POST. 423 Locked (per-bucket
// stamp contention) and 429 are already caught + backed-off by the retry loop in
// bytes.ts/feeds.ts, so a wider pipe is self-protecting — worst case is a retried
// 423, not a failure. Overridable via UPLOAD_CONCURRENCY for quick prod tuning.
const MAX_CONCURRENT = Number(process.env.UPLOAD_CONCURRENCY) || 6;

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

/** A store write nothing can follow (no failover): 5 attempts, a full call each. */
export const FULL_UPLOAD_BUDGET: UploadBudget = { attempts: 5, timeoutMs: BEE_CALL_TIMEOUT_MS };

/**
 * Per-call timeout for a Bee /bzz tar collection upload. Higher than the
 * single-chunk timeout because tars can be megabytes (whole site bundle) and
 * legitimately take longer. Kept under Cloudflare's 125s edge timeout so a
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

export interface UploadBudget {
  attempts: number;
  /** Per attempt, handed to `send`. */
  timeoutMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A store fault worth another attempt: 429, 423 (bee's per-bucket stamp lock,
 * held by a concurrent write to the same batch - an event create stamps several
 * at once), 5xx, or no status at all with a network or timeout signature (bee's
 * chain-RPC backpressure surfaces as TCP resets). Any other 4xx is an answer.
 * The one classifier for SOC and `/bytes` writes.
 */
export function isTransientSwarmError(err: unknown): boolean {
  const e = err as { status?: number; response?: { status?: number }; message?: unknown; code?: unknown } | null;
  const status = e?.status ?? e?.response?.status;
  if (status !== undefined) return status === 429 || status === 423 || status >= 500;
  const msg = String(e?.message ?? "").toLowerCase();
  if (/socket hang up|network|timeout|429/.test(msg)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "EPIPE"].includes(
    String(e?.code ?? "").toUpperCase(),
  );
}

/**
 * One upload, retried while `transient` says the store may answer differently next
 * time. The semaphore is held only for the HTTP call, never across the back-off
 * sleep, so a throttled slot frees at once. Shared by the SOC and `/bytes` writers.
 */
export async function withRetries<T>(
  send: (timeoutMs: number) => Promise<T>,
  budget: UploadBudget,
  transient: (err: unknown) => boolean,
): Promise<T> {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      const release = await beeUploadSem.acquire();
      try {
        return await send(budget.timeoutMs);
      } finally {
        release();
      }
    } catch (err) {
      if (!transient(err) || attempt >= budget.attempts - 1) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}
