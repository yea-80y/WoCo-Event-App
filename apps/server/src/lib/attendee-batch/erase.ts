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
 * Either way the order's tickets leave the door: their sealed door entries are deleted
 * and a removal reaches every online scanner (`removeDoorEntries`). The sale record is
 * how an order root finds its tickets; none (a sale never recorded) leaves the door copy
 * to the roster sweep, 2 days after the event.
 *
 * Synchronous from the in-flight check to the tombstone, so no store can start
 * between. Throws on anything else; the caller reports it.
 */

import { getRecordedFeedSigner } from "../event/feed-signer-record.js";
import { burnOrder, type BurnDeps } from "./burn.js";
import { getHeldOrder, releaseHeldOrder } from "./held-orders.js";
import { getOrderRecord, recordErasedBeforeStore, type Erasure, type OrderRecord } from "./ledger.js";
import { isStoreInFlight } from "./writer.js";
import { getSale, saleSessionsByOrderRef } from "../stripe/ticket-sales.js";
import { removeDoorEntries } from "../checkin/door-entries.js";

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
    forgetAtTheDoor(root);
    return { kind: "deleted-before-store" };
  }
  const record = await burnOrder(root, burnDeps, erasure);
  forgetAtTheDoor(root);
  return { kind: "burned", record };
}

/** The order's tickets, by the sale that carries its root. Never throws. */
function forgetAtTheDoor(root: string): void {
  try {
    const sessionId = saleSessionsByOrderRef().get(root);
    const sale = sessionId ? getSale(sessionId) : undefined;
    if (!sale?.eventId || !sale.seriesId || sale.slots.length === 0) {
      if (!sale) console.warn(`[erase] no sale record for ${root.slice(0, 10)}… - its door copy goes with the roster sweep`);
      return;
    }
    const seriesId = sale.seriesId;
    removeDoorEntries(sale.eventId, sale.slots.map((slot) => ({ seriesId, edition: slot + 1 })));
  } catch (err) {
    console.error("[erase] door entries could not be told:", err);
  }
}
