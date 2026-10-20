/**
 * One late retry for a save whose read could not say (#943).
 *
 * Bee 2.8 puts a chunk it has failed to retrieve a few times on a one-minute
 * skip list: until that expires, every read of the address answers 500
 * (`/chunks`) or 404 "lookup at failed" (`/feeds`), and our server reports that
 * as 503 - unanswered, never absent. A first save is exactly the case that hits
 * it: the feed has never been written, and the organiser's own screens have
 * already asked about its first version several times. So the read a save rests
 * on comes back inconclusive, and so does trying again inside that minute.
 * Waiting past the minute is the only retry that can work.
 *
 * Once, and only for an inconclusive read (`InconclusiveReadError`): a verdict -
 * a refusal, a version that will never read, a lost race - is shown at once, and
 * a second inconclusive answer reaches the caller as its own error. The wait is
 * cancelled with the page (`signal`): a save the person can no longer see the
 * outcome of must not fire on its own a minute later.
 */

/** Past bee's one-minute skip list, with margin for the server's own retries. */
export const LATE_RETRY_MS = 65_000;

/** A read that could not say - never "absent", never a verdict. The message is what the person sees. */
export class InconclusiveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InconclusiveReadError";
  }
}

/** The page went away (or the account changed) during the wait, so the retry did not run. */
export class LateRetryCancelled extends Error {
  constructor() {
    super("The save was cancelled before it could try again.");
    this.name = "LateRetryCancelled";
  }
}

export interface LateRetry {
  /** Aborted when the page that asked goes away: the retry is then never run. */
  signal?: AbortSignal;
  /** Called once, as the wait starts - the page shows that it is still saving. */
  onWait?: (ms: number) => void;
  /** Test seam: production waits {@link LATE_RETRY_MS}. */
  delayMs?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LateRetryCancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LateRetryCancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt`; if it throws an {@link InconclusiveReadError}, wait once and run
 * it again. `attempt` is re-run whole, so it must re-check anything the wait can
 * change (the signed-in account, above all).
 */
export async function retryOnceIfInconclusive<T>(attempt: () => Promise<T>, opts: LateRetry = {}): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (!(e instanceof InconclusiveReadError)) throw e;
    if (opts.signal?.aborted) throw new LateRetryCancelled();
    const ms = opts.delayMs ?? LATE_RETRY_MS;
    opts.onWait?.(ms);
    await wait(ms, opts.signal);
    return attempt();
  }
}
