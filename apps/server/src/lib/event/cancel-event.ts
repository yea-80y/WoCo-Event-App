/**
 * Cancel an event and refund every buyer (#644) — the one core both the
 * organiser route and the ops route call, so "everyone is refunded when an
 * event does not happen" still has a tool when an organiser has vanished.
 *
 * Order is load-bearing:
 *   1. persist the cancellation — from this write on, checkout, seat holds and
 *      fulfilment refuse the event (cancellations.ts). Nothing else happens if
 *      it cannot be persisted.
 *   2. unlist it and drop cached copies, so it leaves every listing.
 *   3. start the refunds (async) and expire the event's still-open checkouts
 *      (async, best effort) — the second shrinks the window in which a buyer can
 *      pay after the cancellation; fulfilment refunds whoever pays in it anyway.
 */

import { CANCELLATION_RETURNS_PLATFORM_FEE, organiserCancelClosesAt } from "@woco/shared";
import { recordCancellation, type CancellationGate, type EventCancellation } from "./cancellations.js";

export interface CancelEventDeps {
  unlist(eventId: string): void;
  invalidateCaches(eventId: string): void;
  kickRefunds(): void;
  /** Expire open Checkout Sessions for this event on `account`. Best effort; resolves with how many. */
  expireOpenSessions(eventId: string, account: string): Promise<number>;
}

export type CancelEventResult =
  | { ok: true; created: boolean; cancellation: EventCancellation }
  | { ok: false; reason: "not-persisted" };

export function cancelEvent(
  input: { eventId: string; by: string; organiserAccount?: string },
  deps: CancelEventDeps,
): CancelEventResult {
  const recorded = recordCancellation({
    eventId: input.eventId,
    by: input.by,
    feeReturned: CANCELLATION_RETURNS_PLATFORM_FEE,
  });
  if (!recorded) return { ok: false, reason: "not-persisted" };

  // Repeated on a second call on purpose: each step is idempotent, and a crash
  // between the write above and these must be repairable by pressing again.
  for (const step of [() => deps.unlist(input.eventId), () => deps.invalidateCaches(input.eventId), () => deps.kickRefunds()]) {
    try {
      step();
    } catch (err) {
      console.error(`[cancel-event] ${input.eventId}: a follow-up step failed (the cancellation stands):`, err);
    }
  }
  if (input.organiserAccount) {
    void deps.expireOpenSessions(input.eventId, input.organiserAccount)
      .then((n) => {
        if (n > 0) console.log(`[cancel-event] ${input.eventId}: expired ${n} open checkout(s)`);
      })
      .catch((err) => console.warn(`[cancel-event] ${input.eventId}: could not expire open checkouts:`, err));
  }
  if (recorded.created) console.warn(`[cancel-event] ${input.eventId} CANCELLED by ${input.by} — refunding every sale`);
  return { ok: true, created: recorded.created, cancellation: recorded.cancellation };
}

/**
 * Whether the organiser's window to cancel has closed (owner policy): an event
 * that ended days ago happened, and its takings may be paid out. A press on one
 * already cancelled is the repair path, so it is never refused; ops never asks.
 */
export function organiserCancelClosed(
  event: { endDate?: string; startDate?: string },
  gate: CancellationGate,
  now: number,
): boolean {
  if (gate === "cancelled") return false;
  const closesAt = organiserCancelClosesAt(event);
  return closesAt !== null && now > closesAt;
}
