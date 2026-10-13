/**
 * Erase one attendee order, wherever it is (#546) - the one path an erasure
 * request (`POST /api/ops/attendee-batch/orders/:root/burn`) and the retention
 * sweep (#547) share, so both treat a held order, a stored one and a store in
 * flight alike.
 *
 *   - Being stored right now: refused. Deleting the hold underneath the store
 *     would land the order on Swarm with nothing left to say it was erased.
 *   - Only held (not yet on Swarm): the hold is deleted, which is real deletion,
 *     and a chunkless tombstone keeps who it was for and why it went, so a later
 *     request is answered "erased" and nothing can store it again.
 *   - On Swarm: every chunk's slot is burned (`burnOrder`), resumable.
 *
 * Synchronous from the in-flight check to the tombstone, so no store can start
 * between. Throws on anything else; the caller reports it.
 */

import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { burnOrder, type BurnDeps } from "./burn.js";
import { getHeldOrder, releaseHeldOrder } from "./held-orders.js";
import { getOrderRecord, recordErasedBeforeStore, type Erasure, type OrderRecord } from "./ledger.js";
import { isStoreInFlight } from "./writer.js";

export type EraseOutcome =
  | { kind: "in-flight" }
  | { kind: "hold-not-deleted" }
  | { kind: "not-found" }
  | { kind: "deleted-before-store" }
  | { kind: "burned"; record: OrderRecord };

export async function eraseOrder(rawRoot: string, erasure: Erasure, burnDeps?: BurnDeps): Promise<EraseOutcome> {
  const root = rawRoot.toLowerCase().replace(/^0x/, "");
  if (isStoreInFlight(root)) return { kind: "in-flight" };
  const heldBefore = getHeldOrder(root);
  if (heldBefore && !releaseHeldOrder(root)) return { kind: "hold-not-deleted" };
  if (!getOrderRecord(root)) {
    if (!heldBefore) return { kind: "not-found" };
    const eventId = heldBefore.eventId;
    const organiser = eventId ? getRecordedFeedSigner(eventId)?.creatorAddress : undefined;
    recordErasedBeforeStore(
      root,
      {
        ...(eventId ? { eventId } : {}),
        ...(heldBefore.seriesId ? { seriesId: heldBefore.seriesId } : {}),
        ...(heldBefore.emailHash ? { emailHash: heldBefore.emailHash } : {}),
        ...(organiser ? { organiser } : {}),
        ...(heldBefore.retainMonths !== undefined ? { retainMonths: heldBefore.retainMonths } : {}),
      },
      Date.now(),
      erasure,
    );
    return { kind: "deleted-before-store" };
  }
  return { kind: "burned", record: await burnOrder(root, burnDeps, erasure) };
}
