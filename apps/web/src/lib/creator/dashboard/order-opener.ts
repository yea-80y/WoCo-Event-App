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
      this.port!.postMessage({ type: "open", req, epoch, eventId, jobs });
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
