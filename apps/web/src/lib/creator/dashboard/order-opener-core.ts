/**
 * The order-opening worker's logic (#965), kept free of `self` so it is tested
 * directly; `order-opener.worker.ts` only wires it to the worker's messages.
 *
 * Opening thousands of sealed orders on the page's own thread froze it (~4 ms
 * each on a laptop, more on a phone). The worker holds the organiser's order
 * keys for one unlock EPOCH: keys arrive with an epoch, every request names the
 * epoch it was made under, and a request from any other epoch is refused rather
 * than opened. "lock" overwrites the keys it holds (best effort: JS cannot
 * promise no other copy exists) and closes the worker.
 *
 * State is this closure only: nothing is written to IndexedDB, the Cache API or
 * any shared channel, and replies go to the page that started the worker.
 */
import type { SealContext } from "@woco/shared/crypto/sealed-box";

export interface OpenJob {
  id: number;
  /** The SLOT's series: the box is bound to it, never to its own payload's. */
  seriesId: string;
  box: unknown;
}

export type OpenerRequest =
  | { type: "keys"; epoch: number; secretKeys: Uint8Array[] }
  | { type: "open"; req: number; epoch: number; eventId: string; jobs: OpenJob[] }
  | { type: "lock" };

/** `data` absent = that box did not open. */
export interface OpenResult {
  id: number;
  data?: unknown;
}

export type OpenerReply =
  | { type: "opened"; req: number; epoch: number; results: OpenResult[] }
  /** The request's epoch is not the worker's: nothing was opened. */
  | { type: "stale"; req: number };

export interface OpenerCoreDeps {
  open(secretKeys: Uint8Array[], box: unknown, ctx: SealContext): Promise<unknown>;
  context(eventId: string, seriesId: string): SealContext;
  post(reply: OpenerReply): void;
  close(): void;
}

function wipe(keys: Uint8Array[]): void {
  for (const k of keys) k.fill(0);
}

export function createOpenerCore(deps: OpenerCoreDeps): (msg: OpenerRequest) => Promise<void> {
  let keys: Uint8Array[] = [];
  let epoch: number | null = null;

  return async function handle(msg: OpenerRequest): Promise<void> {
    if (msg.type === "keys") {
      wipe(keys);
      keys = msg.secretKeys;
      epoch = msg.epoch;
      return;
    }
    if (msg.type === "lock") {
      wipe(keys);
      keys = [];
      epoch = null;
      deps.close();
      return;
    }
    if (msg.epoch !== epoch || keys.length === 0) {
      deps.post({ type: "stale", req: msg.req });
      return;
    }
    const results: OpenResult[] = [];
    for (const job of msg.jobs) {
      try {
        results.push({ id: job.id, data: await deps.open(keys, job.box, deps.context(msg.eventId, job.seriesId)) });
      } catch {
        results.push({ id: job.id });
      }
      // Locked (or re-keyed) while this ran: what it opened is not sent.
      if (epoch !== msg.epoch) {
        deps.post({ type: "stale", req: msg.req });
        return;
      }
    }
    deps.post({ type: "opened", req: msg.req, epoch: msg.epoch, results });
  };
}
