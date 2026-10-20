/**
 * Ordered, retrying read-modify-write of a feed that one key's changes rewrite
 * (a creator's directory, say), built for the FIRST write of a feed that does
 * not exist yet.
 *
 * Why the first write (owner report 2026-10-20, verified on production): bee 2.8
 * puts every neighbourhood peer on a node-wide one-minute skip list after a few
 * retrieval misses of the same chunk inside a minute (`pkg/retrieval`,
 * `skiplistDur`). A feed that was never written misses on every read of its
 * index-0 chunk, so after a few reads (a page opening, say) every read of it
 * fails fast for a minute: `GET /feeds` 404 "lookup at failed", `GET /chunks`
 * 500 "read chunk failed". A strict read rightly calls that an error - an
 * unreadable feed is never empty, or the write would wipe what it could not
 * read - and the change used to be dropped with one log line. `writeFeedPage`'s
 * own index resolution probes index 0 again and can fail the same way, so a
 * failed WRITE is retried too.
 *
 * Per key:
 *  - changes apply in arrival order, one read-modify-write at a time;
 *  - queued changes with the same id are merged, so one that arrives while an
 *    earlier one is retrying is written with it, as one;
 *  - a failed attempt is retried after 70 s and again after 140 s, each wait
 *    past the skip window; a change arriving meanwhile joins those retries;
 *  - when every attempt fails, each queued change is logged at error level with
 *    a replay payload, and its promise rejects.
 * Nothing here turns a failed read into an empty base: `read` throws, nothing is
 * written, and the attempt counts as failed.
 */

export const FIRST_WRITE_RETRY_DELAYS_MS: readonly number[] = [70_000, 140_000];

export interface FirstWriteRetryOptions<Base, Change> {
  /** Starts every log line, e.g. "[site] Creator directory". */
  label: string;
  /** Strict read of the current state. MUST throw when it cannot tell - never return empty for an error. */
  read: (key: string) => Promise<Base>;
  /** Apply `changes` (arrival order) to `base` and write. A throw fails the attempt, which is retried. */
  write: (key: string, base: Base, changes: Change[]) => Promise<void>;
  /** Queued changes with the same id are merged. */
  idOf: (change: Change) => string;
  /** A later change over an earlier queued one with the same id. */
  merge: (earlier: Change, later: Change) => Change;
  /** What an operator needs to replay a dropped change, logged as JSON. Default `{ key, change }`. */
  replayPayload?: (key: string, change: Change) => unknown;
  /** The wait before each retry. Default FIRST_WRITE_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
}

export interface FirstWriteRetryQueue<Change> {
  /** Resolves once the change is written; rejects if it was given up on. */
  enqueue(key: string, change: Change): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
let sleep = defaultSleep;

/** Tests only — replace the retry wait (every queue). */
export const __firstWriteRetryTestHooks = {
  setSleep(fn: ((ms: number) => Promise<void>) | null): void {
    sleep = fn ?? defaultSleep;
  },
};

interface KeyQueue<Change> {
  /** id -> everything queued for it, merged, in the order single changes would apply. */
  pending: Map<string, Change>;
  /** One per enqueue not yet settled, in arrival order. */
  waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
}

export function createFirstWriteRetryQueue<Base, Change>(
  opts: FirstWriteRetryOptions<Base, Change>,
): FirstWriteRetryQueue<Change> {
  const delays = opts.retryDelaysMs ?? FIRST_WRITE_RETRY_DELAYS_MS;
  const replay = opts.replayPayload ?? ((key: string, change: Change) => ({ key, change }));
  const queues = new Map<string, KeyQueue<Change>>();

  function giveUp(key: string, queue: KeyQueue<Change>, attempts: number, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    for (const change of queue.pending.values()) {
      console.error(
        `${opts.label} change DROPPED after ${attempts} attempt(s) (${reason}) - replay by hand: ${JSON.stringify(replay(key, change))}`,
      );
    }
    queue.pending.clear();
    for (const w of queue.waiters.splice(0)) w.reject(error);
  }

  async function drain(key: string, queue: KeyQueue<Change>): Promise<void> {
    let failures = 0;
    try {
      while (queue.pending.size > 0) {
        let error: unknown;
        try {
          const base = await opts.read(key);
          // Taken after the read, so a change that arrived during it (or during
          // a retry wait) is in this write.
          const batch = [...queue.pending];
          const covered = queue.waiters.length;
          await opts.write(key, base, batch.map(([, change]) => change));
          // A change merged again during the write stays queued for the next round.
          for (const [id, change] of batch) if (queue.pending.get(id) === change) queue.pending.delete(id);
          for (const w of queue.waiters.splice(0, covered)) w.resolve();
          failures = 0;
          continue;
        } catch (e) {
          error = e;
        }
        if (failures < delays.length) {
          const delay = delays[failures++];
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`${opts.label} for ${key} not written (${reason}) - retry ${failures}/${delays.length} in ${delay / 1000}s`);
          await sleep(delay);
          continue;
        }
        giveUp(key, queue, failures + 1, error);
        failures = 0;
      }
    } catch (e) {
      giveUp(key, queue, failures + 1, e); // a throw outside an attempt: nobody is left waiting
    } finally {
      queues.delete(key);
    }
  }

  return {
    enqueue(key, change) {
      let queue = queues.get(key);
      const idle = !queue;
      if (!queue) {
        queue = { pending: new Map(), waiters: [] };
        queues.set(key, queue);
      }
      const id = opts.idOf(change);
      const earlier = queue.pending.get(id);
      queue.pending.delete(id); // re-added last: the order a run of single changes would apply
      queue.pending.set(id, earlier === undefined ? change : opts.merge(earlier, change));
      const q = queue;
      const done = new Promise<void>((resolve, reject) => q.waiters.push({ resolve, reject }));
      if (idle) void drain(key, q);
      return done;
    },
  };
}
