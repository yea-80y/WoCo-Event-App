/**
 * Parse a seating plan, fully (`parseSeatPlan`: digest, closed schema, the walk,
 * label identity), always. A big plan parses in a Worker so the page stays live:
 * ~2 s at the 200,000-seat ceiling on a laptop, longer on a phone. Without Worker
 * support it parses here, the same way. The Worker starts through
 * `startModuleWorker`, so it runs on woco.eth.limo too, where the app's chunks are
 * on another origin (#1087).
 */

import { parseSeatPlan, type SeatPlan } from "@woco/shared/seating/plan";
import { startModuleWorker } from "@woco/shared/web/module-worker";

/** Up to this many seats the plan parses on the page's own thread. */
export const PARSE_IN_PAGE_MAX_SEATS = 20_000;

export async function parsePlan(bytes: Uint8Array, digest: string, seats: number): Promise<SeatPlan | null> {
  if (seats <= PARSE_IN_PAGE_MAX_SEATS || typeof Worker === "undefined") return parseSeatPlan(bytes, digest);
  let worker: Worker;
  try {
    // Loaded here, not at the top: only a bundler can resolve `?worker&url`.
    const { default: workerUrl } = await import("./parse-worker.ts?worker&url");
    worker = startModuleWorker(workerUrl);
  } catch {
    return parseSeatPlan(bytes, digest);
  }
  try {
    return await new Promise<SeatPlan | null>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<SeatPlan | null>) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      const copy = bytes.slice().buffer;
      worker.postMessage({ bytes: copy, digest }, [copy]);
    });
  } catch {
    // A worker that would not start (a page policy, an old browser): parse here instead.
    return parseSeatPlan(bytes, digest);
  } finally {
    worker.terminate();
  }
}
