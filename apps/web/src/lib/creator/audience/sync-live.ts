/**
 * The audience sync's live reader and opener (#201): `sync-orders.ts` and
 * `sync-opener.ts` wired to the dashboard's read path. Loaded on first use, so the
 * chain client, the queue and the worker code stay out of the organiser pages' boot chunk.
 */
import type { SealedBoxV2 } from "@woco/shared/crypto/sealed-box-shape";
import { getEventOrders } from "../../api/events.js";
import { BrowserOrders } from "../dashboard/browser-orders.js";
import { canReadLedger, liveBrowserOrdersDeps, liveBundleVerifier, liveGatewayFetcher, liveOrderOpenerWorker } from "../dashboard/browser-orders-live.js";
import type { BundleVerifier } from "../dashboard/bundle-verifier.js";
import { DetailQueue } from "../dashboard/detail-queue.js";
import { foregroundBusy } from "../dashboard/gateway-share.js";
import { OrderOpenerPool, poolWidth } from "../dashboard/order-opener.js";
import type { SyncOrder } from "./audience-sync.js";
import type { DecryptedClaim } from "./attendee-drain.js";
import { SYNC_POOL_MAX, SyncOpener } from "./sync-opener.js";
import { SYNC_HEADROOM_SHARE, readEventOrders } from "./sync-orders.js";

const setTimer = (cb: () => void, ms: number): unknown => setTimeout(cb, ms);
const clearTimer = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

/** One event's orders, read in the browser to the end (sync-orders.ts). */
export function readOrders(eventId: string, progress?: (done: number, total: number) => void): Promise<SyncOrder[]> {
  let verifier: BundleVerifier | null = null;
  return readEventOrders({
    ...(progress ? { onProgress: progress } : {}),
    reader: new BrowserOrders(liveBrowserOrdersDeps(eventId), canReadLedger),
    makeQueue(hooks) {
      // Bundles checked in the key-free worker, off the page's thread (#1061).
      verifier = liveBundleVerifier();
      return new DetailQueue({
        ...liveGatewayFetcher(verifier),
        now: Date.now,
        setTimer,
        clearTimer,
        random: Math.random,
        wantCoverage: hooks.wantCoverage,
        onChange: hooks.onChange,
        headroomShare: SYNC_HEADROOM_SHARE,
        holdWhile: foregroundBusy,
      });
    },
    // A ledger this browser cannot read: the server reads it, as for the dashboard.
    serverRead: async () => (await getEventOrders(eventId, { establish: false })).orders,
    foregroundBusy,
    now: Date.now,
    setTimer,
    clearTimer,
    dispose: () => verifier?.dispose(),
  });
}

/** This run's opener: its own pool per event, at most SYNC_POOL_MAX workers. */
export function syncOpener(deps: { bound(): boolean; keys(): Promise<Uint8Array[] | null> }): SyncOpener {
  return new SyncOpener({
    ...deps,
    makePool: (jobs) =>
      typeof Worker === "undefined"
        ? null
        : new OrderOpenerPool(
            liveOrderOpenerWorker,
            () => Math.min(SYNC_POOL_MAX, poolWidth(jobs, navigator.hardwareConcurrency)),
          ),
    async openOnPage(keys: Uint8Array[], box: SealedBoxV2, eventId: string, seriesId: string) {
      const [{ openJsonWithAnyKey }, { orderSealContext }] = await Promise.all([
        import("../../keyring/order-keys.js"),
        import("@woco/shared/crypto/sealed-box"),
      ]);
      // Bound to THIS event and the SLOT's series, never the payload's own.
      return openJsonWithAnyKey<DecryptedClaim>(keys, box, orderSealContext(eventId, seriesId));
    },
    pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
}
