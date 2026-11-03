/**
 * The page's side of the order-opening worker (#965; protocol in
 * order-opener-core.ts).
 *
 * Keys are handed over once per unlock epoch and TRANSFERRED, so the page's own
 * copy of those buffers is detached rather than left behind. `lock()` tells the
 * worker to overwrite its keys, terminates it, and answers every request still
 * waiting as locked: nothing opened under an old epoch reaches the page.
 *
 * A worker that cannot start (a script the browser refuses, a load error) answers
 * "unavailable", and the caller opens on the page instead - slower, never stuck.
 */
import type { OpenJob, OpenResult, OpenerReply, OpenerRequest } from "./order-opener-core.js";

/** What the page needs of a Worker. */
export interface OpenerPort {
  postMessage(msg: OpenerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: { data: OpenerReply }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

export type OpenOutcome =
  | { kind: "opened"; results: OpenResult[] }
  /** Locked (or re-keyed) while it ran: keep nothing. */
  | { kind: "locked" }
  /** No worker: open on the page. */
  | { kind: "unavailable" };

/**
 * A batch the worker has not answered in this long means it is stuck: treat it as
 * gone and open on the page. A batch is ~50 boxes at a few ms each, so this is
 * minutes of headroom even on a slow phone.
 */
export const OPEN_TIMEOUT_MS = 60_000;

export class OrderOpener {
  private port: OpenerPort | null = null;
  private keyedEpoch: number | null = null;
  private broken = false;
  private nextReq = 0;
  private readonly waiting = new Map<number, (o: OpenOutcome) => void>();

  constructor(
    private readonly spawn: () => OpenerPort,
    private readonly timeoutMs: number = OPEN_TIMEOUT_MS,
  ) {}

  /** The worker holds keys for this epoch. */
  keyedFor(epoch: number): boolean {
    return this.port !== null && this.keyedEpoch === epoch;
  }

  /** False once the worker failed to start, stopped answering, or could not take a job: it never comes back. */
  get usable(): boolean {
    return !this.broken;
  }

  /**
   * Hand over this unlock's keys. Each is copied into its own buffer and that copy
   * transferred; the caller's arrays are overwritten, so no page-side copy remains
   * from this hand-over (a key may be a view on a shared buffer, which is why it is
   * not transferred as it is).
   */
  unlock(epoch: number, secretKeys: Uint8Array[]): void {
    if (this.broken) return;
    if (!this.port) {
      try {
        this.port = this.spawn();
      } catch {
        this.fail();
        return;
      }
      this.port.onmessage = (e) => this.reply(e.data);
      this.port.onerror = () => this.fail();
    }
    this.keyedEpoch = epoch;
    const copies = secretKeys.map((k) => k.slice());
    for (const k of secretKeys) k.fill(0);
    this.port.postMessage({ type: "keys", epoch, secretKeys: copies }, copies.map((k) => k.buffer as ArrayBuffer));
  }

  open(epoch: number, eventId: string, jobs: OpenJob[]): Promise<OpenOutcome> {
    if (this.broken) return Promise.resolve({ kind: "unavailable" });
    if (!this.port || this.keyedEpoch !== epoch) return Promise.resolve({ kind: "locked" });
    const req = ++this.nextReq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Stuck: never block every later run on it (Fable sign-off S5).
        if (this.waiting.has(req)) this.fail();
      }, this.timeoutMs);
      this.waiting.set(req, (o) => {
        clearTimeout(timer);
        resolve(o);
      });
      try {
        this.port!.postMessage({ type: "open", req, epoch, eventId, jobs });
      } catch (err) {
        // The browser could not copy a job to the worker (a reactive proxy did exactly
        // this, 2026-11-02): open on the page instead - never stop with nothing said.
        console.error("[order-opener] could not hand orders to the worker; opening them on the page:", err);
        this.fail();
      }
    });
  }

  /** Overwrite and drop the worker's keys; every waiting request reads as locked. */
  lock(): void {
    if (this.port) {
      this.port.postMessage({ type: "lock" });
      this.port.terminate();
    }
    this.port = null;
    this.keyedEpoch = null;
    this.settleAll({ kind: "locked" });
  }

  private reply(r: OpenerReply): void {
    const resolve = this.waiting.get(r.req);
    if (!resolve) return;
    this.waiting.delete(r.req);
    resolve(r.type === "opened" && r.epoch === this.keyedEpoch ? { kind: "opened", results: r.results } : { kind: "locked" });
  }

  private fail(): void {
    this.broken = true;
    this.port?.terminate();
    this.port = null;
    this.keyedEpoch = null;
    this.settleAll({ kind: "unavailable" });
  }

  private settleAll(o: OpenOutcome): void {
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const resolve of all) resolve(o);
  }
}

/** Workers at most, whatever the device: past this the page, the download and the device's other work compete. */
export const POOL_MAX = 4;
/** One more worker per this many orders: a small event never starts more than one. */
export const ORDERS_PER_WORKER = 1_000;

/** How many workers a list of `rows` orders gets on a device with `cores` threads (one left for the page). */
export function poolWidth(rows: number, cores: number | undefined): number {
  const byCores = Math.min(POOL_MAX, Math.max(1, (cores ?? 2) - 1));
  return Math.max(1, Math.min(byCores, Math.ceil(rows / ORDERS_PER_WORKER)));
}

/**
 * Several opening workers for a long list (#1061 fix 2). One worker opens about 200
 * orders a second, so 24k took two minutes on one however fast the page was.
 *
 * Each worker is an `OrderOpener` with every rule it has: keys for one epoch,
 * transferred, a lock that overwrites and terminates, a timeout. The pool adds only:
 * - each worker gets its OWN copy of the keys, and the caller's arrays are overwritten;
 * - a step is split across the keyed workers and answered as one; any "locked" share
 *   makes the whole step locked, so nothing from an old epoch is kept;
 * - a worker that gives out mid-step hands its share to the rest; with none left the
 *   step is "unavailable" and the page opens it itself;
 * - `lock()` locks every worker.
 *
 * How many workers is decided at each unlock, from `wanted()`, and never shrinks. A gone
 * worker never comes back, but a later unlock that wants more starts new ones - at most
 * POOL_MAX started per pool, ever.
 */
export class OrderOpenerPool {
  private readonly openers: OrderOpener[] = [];
  private epoch: number | null = null;

  constructor(
    private readonly spawn: () => OpenerPort,
    private readonly wanted: () => number,
    private readonly timeoutMs: number = OPEN_TIMEOUT_MS,
  ) {}

  /** At least one worker holds keys for this epoch. */
  keyedFor(epoch: number): boolean {
    return this.keyed(epoch).length > 0;
  }

  /** Workers that can take a share of the next step. */
  get width(): number {
    return this.epoch === null ? 0 : this.keyed(this.epoch).length;
  }

  unlock(epoch: number, secretKeys: Uint8Array[]): void {
    const want = Math.max(1, Math.min(POOL_MAX, this.wanted()));
    while (this.openers.length < want) this.openers.push(new OrderOpener(this.spawn, this.timeoutMs));
    this.epoch = epoch;
    // Every copy made, then the caller's arrays overwritten at once - before any hand-over
    // can throw, as the single worker did (Fable sign-off #1061 fix 2, F3).
    const copies = this.openers.map(() => secretKeys.map((k) => k.slice()));
    for (const k of secretKeys) k.fill(0);
    this.openers.forEach((o, i) => {
      try {
        o.unlock(epoch, copies[i]);
      } finally {
        // OrderOpener overwrites what it is given, except when its worker is gone.
        for (const k of copies[i]) k.fill(0);
      }
    });
  }

  open(epoch: number, eventId: string, jobs: OpenJob[]): Promise<OpenOutcome> {
    if (this.openers.length > 0 && !this.openers.some((o) => o.usable)) return Promise.resolve({ kind: "unavailable" });
    const keyed = this.keyed(epoch);
    if (keyed.length === 0) return Promise.resolve({ kind: "locked" });
    return this.spread(keyed, epoch, eventId, jobs);
  }

  lock(): void {
    this.epoch = null;
    for (const o of this.openers) o.lock();
  }

  private keyed(epoch: number): OrderOpener[] {
    return this.openers.filter((o) => o.usable && o.keyedFor(epoch));
  }

  private async spread(openers: OrderOpener[], epoch: number, eventId: string, jobs: OpenJob[]): Promise<OpenOutcome> {
    const size = Math.ceil(jobs.length / openers.length);
    const shares = openers.map((o, i) => ({ o, jobs: jobs.slice(i * size, (i + 1) * size) })).filter((s) => s.jobs.length > 0);
    const outs = await Promise.all(shares.map((s) => s.o.open(epoch, eventId, s.jobs)));
    if (outs.some((o) => o.kind === "locked")) return { kind: "locked" };
    const results = outs.flatMap((o) => (o.kind === "opened" ? o.results : []));
    const redo = shares.filter((_, i) => outs[i].kind === "unavailable").flatMap((s) => s.jobs);
    if (redo.length === 0) return { kind: "opened", results };
    // A worker gave out (it is unusable now, so this ends): its share goes to the rest.
    const rest = this.keyed(epoch);
    // None keyed but some still usable: a lock or re-key landed between rounds (F2).
    if (rest.length === 0) return this.openers.some((o) => o.usable) ? { kind: "locked" } : { kind: "unavailable" };
    const again = await this.spread(rest, epoch, eventId, redo);
    return again.kind === "opened" ? { kind: "opened", results: [...results, ...again.results] } : again;
  }
}
