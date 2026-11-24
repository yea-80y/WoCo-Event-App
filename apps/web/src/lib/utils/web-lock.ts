/**
 * One holder of a named lock at a time: across this browser's tabs where it has Web
 * Locks, within this tab (a per-name chain) where it has not. Another DEVICE is never
 * covered - a lock narrows a race between tabs, it cannot close one between devices.
 *
 * Imports nothing: the manifest edits and the receipt saves both use it.
 */

/** The part of the Web Locks API used here. */
export interface WebLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** The `ifAvailable` form, for a job that should run in one tab only. */
export interface WebLocksIfAvailable {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

function browserLocks(): (WebLocks & WebLocksIfAvailable) | undefined {
  return (globalThis as { navigator?: { locks?: WebLocks & WebLocksIfAvailable } }).navigator?.locks;
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `edit` holding `name`, waiting for any other holder first. Past `timeoutMs` the
 * caller gets an error and the lock is released for the next one, though `edit` may
 * still finish: never blocking every later edit for the life of the tab is worth that.
 * `locks` is a test seam (null = this tab's chain).
 */
export function withWebLock<T>(
  name: string,
  edit: () => Promise<T>,
  opts: { timeoutMs: number; locks?: WebLocks | null; timeoutMessage?: string },
): Promise<T> {
  const bounded = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(opts.timeoutMessage ?? `${name} did not finish within ${Math.round(opts.timeoutMs / 1000)}s`)),
        opts.timeoutMs,
      );
      edit().then(resolve, reject).finally(() => clearTimeout(timer));
    });
  const locks = opts.locks === undefined ? browserLocks() : opts.locks;
  if (locks) return locks.request(name, bounded);

  const run = (chains.get(name) ?? Promise.resolve()).then(bounded, bounded);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(name, tail);
  void tail.then(() => {
    if (chains.get(name) === tail) chains.delete(name);
  });
  return run;
}

const heldHere = new Set<string>();

/**
 * Run `job` holding `name` only if nobody holds it now - in any tab where the browser
 * has Web Locks, else in this tab. Resolves `{ ran: false }` without running it
 * otherwise. Held for as long as `job` runs: give it its own bound. `locks`: a test seam
 * (null = this tab only).
 */
export async function ifLockFree<T>(
  name: string,
  job: () => Promise<T>,
  opts: { locks?: WebLocksIfAvailable | null } = {},
): Promise<{ ran: true; value: T } | { ran: false }> {
  const locks = opts.locks === undefined ? browserLocks() : opts.locks;
  if (locks) {
    return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? { ran: true as const, value: await job() } : { ran: false as const }));
  }
  if (heldHere.has(name)) return { ran: false };
  heldHere.add(name);
  try {
    return { ran: true, value: await job() };
  } finally {
    heldHere.delete(name);
  }
}
