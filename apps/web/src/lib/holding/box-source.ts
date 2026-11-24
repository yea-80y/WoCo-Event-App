/**
 * Getting an order's receipt box, opened and checked (spec-receipt-note 5.2).
 *
 * Swarm FIRST, by the box's root (the `b` in a ticket email's Keep link, or the root the
 * server names): no call to WoCo's server at all. The pickup API only when that fails -
 * the box not stored yet, a gateway that cannot serve it, or a box re-made after a
 * ticket was replaced (the old root then holds the old box).
 *
 * Whatever served the bytes, they must hash to the root asked for (`boxFromBytes`), and
 * the box must open under the order's secret and pass the receipt check
 * (`@woco/shared/holding/open`) before anything keeps it.
 */
import type { HoldingBoxV1 } from "@woco/shared/holding/box";
import type { CheckedReceipt, HoldingBoxRefusal } from "@woco/shared/holding/open";
import type { PickupResult } from "../api/holdings.js";
import { buildEnv } from "../build-env.js";
import { boxFromBytes, MAX_BOX_BYTES } from "../creator/dashboard/order-box.js";
import { WOCO_GATEWAY_URL } from "../swarm/gateways.js";

export type BoxSourceResult =
  | { kind: "ok"; box: HoldingBoxV1; receipts: CheckedReceipt[]; boxRoot: string }
  /** The server has no receipt for this secret: never one, not paid, or already erased. */
  | { kind: "not-found" }
  /** Nothing answered properly: try again later. */
  | { kind: "later" }
  /** A box was found and it is not this order's (or not readable): never kept. */
  | { kind: "refused"; reason: HoldingBoxRefusal };

export interface BoxSourceDeps {
  /** The sealed box stored at `root`, or null when the gateway could not serve it. */
  fromSwarm(root: string): Promise<unknown | null>;
  pickup(pickupId: string): Promise<PickupResult>;
}

export const liveBoxSourceDeps: BoxSourceDeps = {
  fromSwarm: fetchSealedBox,
  pickup: async (pickupId) => (await import("../api/holdings.js")).pickupHolding(pickupId),
};

/** The order's box, opened and checked. `boxRoot`: where to look first. */
export async function fetchHoldingBox(r: Uint8Array, boxRoot: string | undefined, deps: BoxSourceDeps = liveBoxSourceDeps): Promise<BoxSourceResult> {
  const [{ openHoldingBox, HoldingBoxRefusedError }, { holdingPickupId }] = await Promise.all([
    import("@woco/shared/holding/open"),
    import("@woco/shared/holding/derive"),
  ]);
  let refusal: HoldingBoxRefusal | null = null;
  const open = async (sealed: unknown, root: string): Promise<BoxSourceResult | null> => {
    try {
      return { kind: "ok", ...(await openHoldingBox(r, sealed)), boxRoot: root };
    } catch (e) {
      if (!(e instanceof HoldingBoxRefusedError)) throw e;
      refusal = e.reason;
      return null;
    }
  };

  const tried = new Set<string>();
  if (boxRoot) {
    tried.add(boxRoot);
    const sealed = await deps.fromSwarm(boxRoot);
    const got = sealed === null ? null : await open(sealed, boxRoot);
    if (got) return got;
  }

  const picked = await deps.pickup(holdingPickupId(r));
  if (picked.kind !== "ok") {
    // A box that failed the check is the answer that matters; the server's "none" may
    // only mean its copy is already gone.
    return refusal ? { kind: "refused", reason: refusal } : picked;
  }
  if (picked.box) {
    const got = await open(picked.box, picked.boxRoot);
    if (got) return got;
  } else if (!tried.has(picked.boxRoot)) {
    const sealed = await deps.fromSwarm(picked.boxRoot);
    const got = sealed === null ? null : await open(sealed, picked.boxRoot);
    if (got) return got;
  }
  return refusal ? { kind: "refused", reason: refusal } : { kind: "later" };
}

/**
 * A sealed box from our gateway: the attendee batch is on our bee, and the gateway lists
 * every holding root (#965). `no-store`, as for orders: a browser copy on disk would
 * outlive an erasure.
 */
async function fetchSealedBox(root: string): Promise<unknown | null> {
  const gateway = buildEnv(() => import.meta.env.VITE_GATEWAY_URL as string | undefined) || WOCO_GATEWAY_URL;
  let resp: Response;
  try {
    resp = await fetch(`${gateway}/bytes/${root}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch {
    return null;
  }
  if (!resp.ok || Number(resp.headers.get("content-length")) > MAX_BOX_BYTES) return null;
  try {
    const got = boxFromBytes(root, new Uint8Array(await resp.arrayBuffer()));
    return got.kind === "ok" ? got.box : null;
  } catch {
    return null;
  }
}
