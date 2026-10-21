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
 *  - changes apply in arrival order, one read-modify-write at a time, each
 *    round applying everything queued to one strict read;
 *  - a failed attempt is retried after 70 s and again after 140 s, each wait
 *    past the skip window; a change arriving meanwhile joins those retries;
 *  - when every attempt fails, each queued change is logged at error level with
 *    a replay payload, counted as dropped in `/api/health`, and its promises
 *    reject. Every retry warning logs the queued payloads too, so a restart
 *    during a wait loses nothing an operator cannot replay.
 * Nothing here turns a failed read into an empty base: `read` throws, nothing is
 * written, and the attempt counts as failed.
 *
 * Change kinds. `Change` may be a union (add / remove / patch, say): every kind
 * is a pure transform of the strictly read base, so one round still makes one
 * read and one write for all of them, and a change of any kind arriving during a
 * retry wait rides that retry. A `run(key, fn)` escape for non-upsert work was
 * the alternative and is worse on both counts: each closure would make its own
 * read and write and retry on its own, and its give-up payload would be code,
 * not data an operator can replay.
 *
 * Merging (optional: `idOf` + `merge`). A change queued while another with the
 * same id still waits replaces it with `merge(earlier, later)`, applied where
 * `later` arrived - after everything queued between the two. So `merge` must
 * give the effect of `earlier` then `later`, and moving `earlier`'s effect past
 * the changes in between must not matter: true when changes to different ids
 * commute, or when only the last change to an id decides where its entry ends
 * up (an upsert that moves the entry to the front). Which changes a write
 * covered is tracked by a generation per enqueue, never by object identity, so
 * a `merge` that returns `earlier` mutated cannot strand a caller: the merged
 * change is written again next round. (A write in flight may see either version
 * of a mutated `earlier`; the next round settles it. Return a new value.)
 * Without `idOf` nothing merges: each change is applied on its own, in arrival
 * order - the choice when changes to one id do not compose by "last wins"
 * (an add then a remove of the same entry, a patch that must not move it).
 */

export const FIRST_WRITE_RETRY_DELAYS_MS: readonly number[] = [70_000, 140_000];

interface CommonOptions<Base, Change> {
  /** Starts every log line, e.g. "[site] Creator directory". */
  label: string;
  /** This queue's name under `/api/health` `directoryWrites`. One queue per name. */
  healthKey: string;
  /** Strict read of the current state. MUST throw when it cannot tell - never return empty for an error. */
  read: (key: string) => Promise<Base>;
  /** Apply `changes` (arrival order) to `base` and write. A throw fails the attempt, which is retried. */
  write: (key: string, base: Base, changes: Change[]) => Promise<void>;
  /** What an operator needs to replay a change, logged as JSON. Default `{ key, change }`. */
  replayPayload?: (key: string, change: Change) => unknown;
  /** The wait before each retry. Default FIRST_WRITE_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
}

type MergeOptions<Change> =
  | {
      /** Queued changes with the same id are merged (see the module doc for the contract). */
      idOf: (change: Change) => string;
      /** A later change over an earlier queued one with the same id. */
      merge: (earlier: Change, later: Change) => Change;
    }
  | { idOf?: undefined; merge?: undefined };

export type FirstWriteRetryOptions<Base, Change> = CommonOptions<Base, Change> & MergeOptions<Change>;

/**
 * `written`: the change is in the feed. `retrying`: the attempt that carried it
 * failed (or the key was already waiting to retry when it arrived) and it is
 * queued for the next retry, which carries on without the caller.
 */
export type FirstAttempt = "written" | "retrying";

export interface QueuedChange {
  /** Resolves once the change is written; rejects if it was given up on. */
  written: Promise<void>;
  /**
   * Settles after ONE attempt, never across a retry wait - for a caller that
   * answers a request. Rejects only when the change is given up on before it was
   * ever told "retrying". Both promises are safe to ignore: a give-up is logged
   * and counted, never an unhandled rejection.
   */
  firstAttempt: Promise<FirstAttempt>;
}

export interface FirstWriteRetryQueue<Change> {
  enqueue(key: string, change: Change): QueuedChange;
}

export interface FirstWriteRetryHealth {
  /** False once any change was dropped, until restart: each one is lost until replayed from the log. */
  ok: boolean;
  /** Changes queued and not yet written (merged changes count once). */
  pending: number;
  /** Keys whose last attempt failed: waiting out a retry, or in one. */
  retrying: number;
  /** Changes given up on since boot. */
  dropped: number;
}

const registry = new Map<string, () => FirstWriteRetryHealth>();

/** Every queue's counters, by `healthKey` - `/api/health` `directoryWrites`. */
export function firstWriteRetryHealth(): Record<string, FirstWriteRetryHealth> {
  return Object.fromEntries([...registry].map(([name, health]) => [name, health()]));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
let sleep = defaultSleep;

/** Tests only — replace the retry wait (every queue). */
export const __firstWriteRetryTestHooks = {
  setSleep(fn: ((ms: number) => Promise<void>) | null): void {
    sleep = fn ?? defaultSleep;
  },
};

interface Waiter {
  told: boolean;
  tell: (v: FirstAttempt) => void;
  failFirst: (e: unknown) => void;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface KeyQueue<Change> {
  /** id -> everything queued for it (merged), with the generation of its last enqueue; in apply order. */
  pending: Map<string | number, { change: Change; gen: number }>;
  /** One per enqueue not yet settled, in arrival order. */
  waiters: Waiter[];
  /** Consecutive failed attempts. */
  failures: number;
  /** In a retry wait: a change arriving now is told "retrying" straight away. */
  waiting: boolean;
}

const noop = () => {};

function newWaiter(): { waiter: Waiter; queued: QueuedChange } {
  const waiter = { told: false } as Waiter;
  const written = new Promise<void>((resolve, reject) => {
    waiter.resolve = resolve;
    waiter.reject = reject;
  });
  const firstAttempt = new Promise<FirstAttempt>((resolve, reject) => {
    waiter.tell = (v) => {
      if (waiter.told) return;
      waiter.told = true;
      resolve(v);
    };
    waiter.failFirst = (e) => {
      if (waiter.told) return;
      waiter.told = true;
      reject(e);
    };
  });
  written.catch(noop);
  firstAttempt.catch(noop);
  return { waiter, queued: { written, firstAttempt } };
}

export function createFirstWriteRetryQueue<Base, Change>(
  opts: FirstWriteRetryOptions<Base, Change>,
): FirstWriteRetryQueue<Change> {
  if (registry.has(opts.healthKey)) throw new Error(`first-write-retry: health key "${opts.healthKey}" is taken`);
  const delays = opts.retryDelaysMs ?? FIRST_WRITE_RETRY_DELAYS_MS;
  const replay = opts.replayPayload ?? ((key: string, change: Change) => ({ key, change }));
  const queues = new Map<string, KeyQueue<Change>>();
  let generation = 0;
  let dropped = 0;

  registry.set(opts.healthKey, () => {
    let pending = 0;
    let retrying = 0;
    for (const q of queues.values()) {
      pending += q.pending.size;
      if (q.failures > 0) retrying++;
    }
    return { ok: dropped === 0, pending, retrying, dropped };
  });

  // Never throws: a payload that will not serialise (a BigInt, a cycle) used to
  // throw inside a retry warning or the give-up, and `drain` - started with
  // `void` - then rejected with that key's callers never settled.
  const payload = (key: string, change: Change): string => {
    try {
      return JSON.stringify(replay(key, change));
    } catch {
      try {
        return String(change);
      } catch {
        return "[unprintable change]";
      }
    }
  };
  const payloads = (key: string, queue: KeyQueue<Change>) => [...queue.pending.values()].map((s) => payload(key, s.change));

  function giveUp(key: string, queue: KeyQueue<Change>, attempts: number, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    for (const payload of payloads(key, queue)) {
      console.error(`${opts.label} change DROPPED after ${attempts} attempt(s) (${reason}) - replay by hand: ${payload}`);
    }
    dropped += queue.pending.size;
    queue.pending.clear();
    for (const w of queue.waiters.splice(0)) {
      w.failFirst(error);
      w.reject(error);
    }
  }

  async function drain(key: string, queue: KeyQueue<Change>): Promise<void> {
    try {
      while (queue.pending.size > 0) {
        let error: unknown;
        try {
          const base = await opts.read(key);
          // Taken after the read, so a change that arrived during it (or during
          // a retry wait) is in this write.
          const batch = [...queue.pending].map(([id, s]) => ({ id, gen: s.gen, change: s.change }));
          const covered = queue.waiters.length;
          await opts.write(key, base, batch.map((b) => b.change));
          // Enqueued again during the write: a newer generation, so it stays for the next round.
          for (const b of batch) if (queue.pending.get(b.id)?.gen === b.gen) queue.pending.delete(b.id);
          for (const w of queue.waiters.splice(0, covered)) {
            w.tell("written");
            w.resolve();
          }
          queue.failures = 0;
          continue;
        } catch (e) {
          error = e;
        }
        if (queue.failures < delays.length) {
          const delay = delays[queue.failures++]!;
          const reason = error instanceof Error ? error.message : String(error);
          // Nobody waits through a retry: the next chance for every queued change is after it.
          for (const w of queue.waiters) w.tell("retrying");
          console.warn(
            `${opts.label} for ${key} not written (${reason}) - retry ${queue.failures}/${delays.length} in ${delay / 1000}s; ` +
              `queued, replayable: [${payloads(key, queue).join(", ")}]`,
          );
          queue.waiting = true;
          try {
            await sleep(delay);
          } finally {
            queue.waiting = false;
          }
          continue;
        }
        giveUp(key, queue, queue.failures + 1, error);
      }
    } catch (e) {
      giveUp(key, queue, queue.failures + 1, e); // a throw outside an attempt: nobody is left waiting
    } finally {
      queues.delete(key);
    }
  }

  return {
    enqueue(key, change) {
      let queue = queues.get(key);
      const idle = !queue;
      if (!queue) {
        queue = { pending: new Map(), waiters: [], failures: 0, waiting: false };
        queues.set(key, queue);
      }
      const gen = ++generation;
      const id = opts.idOf ? opts.idOf(change) : gen;
      const earlier = queue.pending.get(id);
      const merged = earlier === undefined ? change : opts.merge!(earlier.change, change);
      queue.pending.delete(id); // re-added last: where `later` arrived (see the merge contract)
      queue.pending.set(id, { change: merged, gen });
      const { waiter, queued } = newWaiter();
      queue.waiters.push(waiter);
      if (queue.waiting) waiter.tell("retrying");
      if (idle) void drain(key, queue);
      return queued;
    },
  };
}
