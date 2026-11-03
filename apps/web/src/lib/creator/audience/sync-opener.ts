/**
 * Opens the audience sync's orders (#201) in a pool of key-holding workers of its own -
 * never a dashboard's, whose lifetime is its page's - or, where there are no workers,
 * on the page in small steps.
 *
 * Keys exist only while one event's orders are being opened: asked for when that
 * opening starts (the run never holds them), handed to a pool made for it - which
 * overwrites the page's copy - and the pool is locked again when it ends, on every
 * way out. So no worker holds a key while the next event is being fetched.
 *
 * The run's binding (same account, same seed address, still unlocked) is read
 * DIRECTLY before the hand-over and after every step. A watcher may also call
 * `lock()` the moment it changes, so workers drop their keys mid-step, but nothing
 * waits on that having run (Fable consult 2026-11-03 Q1). Unbound = "locked", and
 * nothing opened in that call is returned.
 */
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { OpenOutcome } from "../dashboard/order-opener.js";
import type { OpenJob as WorkerJob } from "../dashboard/order-opener-core.js";
import type { DecryptedClaim } from "./attendee-drain.js";
import type { OpenJob } from "./audience-sync.js";

/** Workers at most: beside an open dashboard's four and two verifiers, more would starve the page. */
export const SYNC_POOL_MAX = 2;
/** Orders per message to each worker. */
export const WORKER_BATCH = 50;
/** Opened per step on the page, then the page gets a turn. */
export const PAGE_CHUNK = 16;

/** What the opener needs of an `OrderOpenerPool`. */
export interface SyncPool {
  unlock(epoch: number, secretKeys: Uint8Array[]): void;
  open(epoch: number, eventId: string, jobs: WorkerJob[]): Promise<OpenOutcome>;
  lock(): void;
  keyedFor(epoch: number): boolean;
  readonly width: number;
}

export interface SyncOpenerDeps {
  /** A pool for one event's opening of `jobs` orders; null = no workers here. */
  makePool(jobs: number): SyncPool | null;
  /** The order keys, derived now. Null = locked: nothing is opened. */
  keys(): Promise<Uint8Array[] | null>;
  /** Still the account and unlock the run began under - read live, never cached. */
  bound(): boolean;
  openOnPage(keys: Uint8Array[], box: SealedBoxV2, eventId: string, seriesId: string): Promise<DecryptedClaim>;
  /** Give the page a turn between steps opened on it. */
  pause(): Promise<void>;
}

const wipe = (keys: Uint8Array[] | null | undefined) => {
  for (const k of keys ?? []) k.fill(0);
};

export class SyncOpener {
  private locked = false;
  private epoch = 0;
  /** The pool of the opening in progress. */
  private pool: SyncPool | null = null;
  /** Keys held on the page, only while it opens without workers. */
  private pageKeys: Uint8Array[] | null = null;

  constructor(private readonly deps: SyncOpenerDeps) {}

  /** The run is over (or its keys locked): drop every key now, and open nothing again. */
  lock(): void {
    this.locked = true;
    this.release();
  }

  /** Each job's buyer, in order; null where its box would not open; "locked" = keep nothing. */
  async open(eventId: string, jobs: OpenJob[]): Promise<Array<DecryptedClaim | null> | "locked"> {
    if (this.gone()) return this.stop();
    const epoch = ++this.epoch;
    const out: Array<DecryptedClaim | null> = new Array<DecryptedClaim | null>(jobs.length).fill(null);
    try {
      let pool = (this.pool = this.deps.makePool(jobs.length));
      let i = 0;
      while (i < jobs.length) {
        if (pool) {
          if (!pool.keyedFor(epoch)) {
            const keys = await this.deps.keys();
            // Locked, or another account, while the keys were derived: never handed over.
            if (!keys || this.gone()) {
              wipe(keys);
              return this.stop();
            }
            pool.unlock(epoch, keys);
          }
          const batch = jobs.slice(i, i + WORKER_BATCH * Math.max(1, pool.width));
          const r = await pool.open(
            epoch,
            eventId,
            batch.map((j, id) => ({ id, seriesId: j.seriesId, box: j.box })),
          );
          if (r.kind === "locked" || this.gone()) return this.stop();
          if (r.kind === "unavailable") {
            // No worker after all: the rest open on the page.
            pool.lock();
            pool = this.pool = null;
            continue;
          }
          const data = new Map(r.results.map((x) => [x.id, x.data]));
          batch.forEach((_, id) => {
            const d = data.get(id);
            // No answer for a box counts as one that would not open.
            out[i + id] = d !== undefined ? (d as DecryptedClaim) : null;
          });
          i += batch.length;
          continue;
        }
        if (!this.pageKeys) {
          const keys = await this.deps.keys();
          if (!keys || this.gone()) {
            wipe(keys);
            return this.stop();
          }
          this.pageKeys = keys;
        }
        const keys = this.pageKeys;
        const batch = jobs.slice(i, i + PAGE_CHUNK);
        const res = await Promise.allSettled(batch.map((j) => this.deps.openOnPage(keys, j.box, eventId, j.seriesId)));
        if (this.gone()) return this.stop();
        res.forEach((r, k) => {
          out[i + k] = r.status === "fulfilled" ? r.value : null;
        });
        i += batch.length;
        await this.deps.pause();
      }
      if (this.gone()) return this.stop();
      return out;
    } finally {
      // Keys only while opening: the next event's fetch runs with none held.
      this.release();
    }
  }

  private gone(): boolean {
    return this.locked || !this.deps.bound();
  }

  private stop(): "locked" {
    this.lock();
    return "locked";
  }

  private release(): void {
    this.pool?.lock();
    this.pool = null;
    wipe(this.pageKeys);
    this.pageKeys = null;
  }
}
