/**
 * The audience sync's read of one event's orders (#201): the dashboard's path, run to
 * the end in the background instead of the server's full read (one chain read and one
 * Swarm download per ticket on the server). Rows come from the chain with the server's
 * erasure answer (`BrowserOrders`), sealed orders from the gateway through a queue of
 * this read's own (`DetailQueue`, bundles checked in the key-free verifier).
 *
 * - A foreground read in this tab (an open dashboard) goes first: this read waits for
 *   it before its chain read, its queue holds while one is busy, and it keeps half of
 *   the gateway's allowance spare (gateway-share.ts).
 * - Drained = nothing queued or being fetched. Roots still retrying then get
 *   DRAIN_GRACE_MS from that moment - once, not restarted by each retry - and are left
 *   without a box: transient, so the event is read again next run. The whole read
 *   stops at DRAIN_CAP_MS the same way.
 * - A root that ends missing (a 404 after the recent-sale recheck) or unreadable is
 *   final: its rows come back `lost` (audience-sync.ts `SyncOrder`); so is a sold slot
 *   with no order reference at all.
 * - An answer too old to fetch on, with the server refusing a new one twice in a row,
 *   ends the read early; the fresh read below then fails the event.
 * - Nothing is handed on for opening under an erasure answer older than
 *   COVERAGE_STALE_MS: a fresh one is read first, and a root it erases loses its box
 *   (the queue forgets it). No fresh answer = this event fails this run.
 * - A ledger this browser cannot read (`loadRows` null) is read by the server, as on
 *   the dashboard - the only way to the full read. A read that FAILS never falls back
 *   to it (Fable consult 2026-11-01 Q7).
 * - The queue is stopped and `dispose` called on every way out.
 *
 * Kept free of browser globals so these rules are tested directly; the live wiring
 * is `sync-live.ts`.
 */
import type { OrderEntry } from "@woco/shared";
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import type { EventOrdersResponse } from "../../api/events.js";
import type { RequestSigningOptions } from "../../auth/request-session.js";
import type { RowsRead } from "../dashboard/browser-orders.js";
import { COVERAGE_STALE_MS, type Coverage, type DetailProgress, type DetailState } from "../dashboard/detail-queue.js";
import type { SyncOrder } from "./audience-sync.js";

/** After the queue has nothing left to fetch, how long roots still retrying may take. */
export const DRAIN_GRACE_MS = 2 * 60_000;
/** One event's read never takes longer, holds and pauses included: the run holds the hour meanwhile. */
export const DRAIN_CAP_MS = 10 * 60_000;
/** How often a wait looks again. */
export const DRAIN_TICK_MS = 1_000;
/** Fresh erasure answers refused in a row, on an answer already too old to fetch on, before the read stops waiting. */
export const STALLED_AFTER_FAILS = 2;
/** The sync's queue stops with half the gateway's allowance left, not a quarter: other tabs, the door, the dashboard. */
export const SYNC_HEADROOM_SHARE = 0.5;

export interface SyncReader {
  loadRows(opts?: RequestSigningOptions): Promise<RowsRead | null>;
  build(boxFor: (root: string) => SealedBoxV2 | undefined): EventOrdersResponse;
  rootOf(order: { seriesId: string; edition: number }): string | null;
}

export interface SyncQueue {
  cover(c: Coverage): void;
  box(root: string): SealedBoxV2 | undefined;
  state(root: string): DetailState | undefined;
  progress(): DetailProgress;
  stop(): void;
}

export interface SyncOrdersDeps {
  reader: SyncReader;
  /** This read's own queue, wired to these hooks. */
  makeQueue(hooks: { wantCoverage(): void; onChange(): void }): SyncQueue;
  /** The server's full read: only for a ledger the browser cannot read. */
  serverRead(): Promise<OrderEntry[]>;
  foregroundBusy(): boolean;
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Called once on every way out. */
  dispose?(): void;
  /** How many of the event's orders have arrived (or ended unfetchable), of how many. */
  onProgress?(done: number, total: number): void;
}

/** A background read never starts a sign-in. */
const BACKGROUND: RequestSigningOptions = { establish: false };

/** Every sold ticket of the event, with its sealed order where it was fetched. Throws when the event cannot be read now. */
export async function readEventOrders(deps: SyncOrdersDeps): Promise<SyncOrder[]> {
  const deadline = deps.now() + DRAIN_CAP_MS;
  let queue: SyncQueue | null = null;
  try {
    if (!(await waitFor(deps, () => !deps.foregroundBusy(), deadline))) {
      throw new Error("the dashboard kept the gateway busy");
    }
    const read = await deps.reader.loadRows(BACKGROUND);
    if (!read) return await deps.serverRead();

    let coveredAt = read.coverage.at;
    let refreshing: Promise<void> | null = null;
    let refreshFails = 0;
    const refresh = (): Promise<void> =>
      (refreshing ??= deps.reader
        .loadRows(BACKGROUND)
        .then((r) => {
          if (!r) throw new Error("this event's ledger can no longer be read here");
          q.cover(r.coverage);
          coveredAt = r.coverage.at;
          refreshFails = 0;
        })
        .catch((err: unknown) => {
          refreshFails++;
          throw err;
        })
        .finally(() => {
          refreshing = null;
        }));
    // The answer is too old to fetch on and the server has not given a new one twice
    // running: nothing will move until it does, so stop now rather than at the cap
    // (Fable sign-off 2026-11-03 #1). The fresh read below then decides.
    const stalled = () => deps.now() - coveredAt >= COVERAGE_STALE_MS && refreshFails >= STALLED_AFTER_FAILS;
    let changed: (() => void) | null = null;
    const q = (queue = deps.makeQueue({
      // The queue keeps asking while it waits; a failed answer only means it waits longer.
      wantCoverage: () => void refresh().catch(() => {}),
      onChange: () => changed?.(),
    }));
    q.cover(read.coverage);
    await drain(deps, q, deadline, (fn) => (changed = fn), stalled);
    if (refreshing) await (refreshing as Promise<void>).catch(() => {});
    // Never handed on under an old answer: one fresh read, or this event fails.
    if (deps.now() - coveredAt >= COVERAGE_STALE_MS) await refresh();

    return deps.reader.build((root) => q.box(root)).orders.map((o): SyncOrder => {
      if (o.encryptedOrder || o.erased) return o;
      const root = deps.reader.rootOf(o);
      // A sold slot with no order reference has nothing to fetch, ever: final, as a 404 is.
      if (root === null) return { ...o, lost: `slot:${o.seriesId}:${o.edition}` };
      const state = q.state(root);
      return state === "missing" || state === "unreadable" ? { ...o, lost: root } : o;
    });
  } finally {
    queue?.stop();
    deps.dispose?.();
  }
}

/** Resolves true once `ok()` holds, false at the deadline. */
function waitFor(deps: SyncOrdersDeps, ok: () => boolean, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const look = () => {
      if (ok()) return resolve(true);
      if (deps.now() >= deadline) return resolve(false);
      deps.setTimer(look, DRAIN_TICK_MS);
    };
    look();
  });
}

/** Until nothing is queued or fetching and retries had their grace, or the deadline. */
function drain(
  deps: SyncOrdersDeps,
  q: SyncQueue,
  deadline: number,
  onChange: (fn: (() => void) | null) => void,
  stalled: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    let idleSince: number | null = null;
    let timer: unknown = null;
    let done = false;
    let told = -1;
    const tell = (p: DetailProgress) => {
      const settled = p.ready + p.missing + p.unreadable;
      if (settled === told) return;
      told = settled;
      try {
        deps.onProgress?.(settled, p.total);
      } catch {
        /* the status line only */
      }
    };
    const finish = () => {
      done = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      onChange(null);
      resolve();
    };
    const check = () => {
      if (done) return;
      const now = deps.now();
      const p = q.progress();
      tell(p);
      if (now >= deadline || stalled()) return finish();
      if (p.waiting === 0 && p.retrying === 0) return finish();
      // The grace runs ONCE, from the first moment only retries were left: a retry going
      // back into the queue does not restart it, or one failing root would hold the read.
      if (p.waiting === 0) idleSince ??= now;
      if (idleSince !== null && now - idleSince >= DRAIN_GRACE_MS) finish();
    };
    const tick = () => {
      timer = deps.setTimer(() => {
        timer = null;
        check();
        if (!done) tick();
      }, DRAIN_TICK_MS);
    };
    onChange(check);
    check();
    if (!done) tick();
  });
}
