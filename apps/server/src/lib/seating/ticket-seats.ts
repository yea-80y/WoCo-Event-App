/**
 * Where some of a seated series' tickets sit NOW, as printed: the ledger's `seatOf`
 * (a seat moves only by an organiser-signed move) labelled from the plan the
 * registration pinned (docs/SEATING.md "Door + tickets"). Used where a person is shown
 * one ticket's seat after its sale - a #983 resend, the passport - never the seat at
 * mint from `ticket-sales.json`, which a move leaves behind.
 *
 * Seated or not comes from the registration record alone here: these readers show a
 * seat, they do not admit anyone (the door also checks the ledger's `isSeated`).
 */

import { NO_SEAT_INDEX } from "@woco/shared";
import { ticketSeatOf } from "@woco/shared/seating/plan";
import type { TicketSeat } from "@woco/shared/seating/ticket-seat";
import type { EventContractTarget } from "../chain/event-contract.js";
import { registrationContractFor, registrationSeatingFor } from "../event/onchain-registry.js";
import { readSeatIndexes } from "../checkin/slot-state.js";
import { pinnedSeatPlan, type PinnedPlan } from "./seat-reads.js";

export type CurrentSeats =
  | { kind: "unseated" }
  /** By slot: the seat as printed, or "none" when the ticket has no seat now. */
  | { kind: "seats"; seats: Map<number, TicketSeat | "none"> }
  /** The ledger or the plan could not be read: show nothing rather than a guess. */
  | { kind: "unreadable" };

export interface TicketSeatsDeps {
  seatingFor(eventId: string, seriesId: string): { planDigest: string } | null;
  contractFor(eventId: string, seriesId: string): EventContractTarget | undefined;
  seatIndexes(contract: EventContractTarget, onChainEventId: string, slots: readonly number[]): Promise<Map<number, number>>;
  plan(swarmManifestRef: string | undefined, planDigest: string): Promise<PinnedPlan>;
}

const liveDeps: TicketSeatsDeps = {
  seatingFor: registrationSeatingFor,
  contractFor: registrationContractFor,
  seatIndexes: (contract, id, slots) => readSeatIndexes(contract, id, slots),
  plan: (ref, digest) => pinnedSeatPlan(ref, digest),
};

export async function currentTicketSeats(
  a: { eventId: string; seriesId: string; onChainEventId: string; swarmManifestRef?: string; slots: readonly number[] },
  deps: TicketSeatsDeps = liveDeps,
): Promise<CurrentSeats> {
  const pin = deps.seatingFor(a.eventId, a.seriesId);
  if (!pin) return { kind: "unseated" };
  const contract = deps.contractFor(a.eventId, a.seriesId);
  if (!contract || contract.version !== "ledger2") return { kind: "unreadable" };
  try {
    const [indexes, plan] = await Promise.all([
      deps.seatIndexes(contract, a.onChainEventId, a.slots),
      deps.plan(a.swarmManifestRef, pin.planDigest),
    ]);
    if (!plan.ok) return { kind: "unreadable" };
    const seats = new Map<number, TicketSeat | "none">();
    for (const slot of a.slots) {
      const k = indexes.get(slot);
      if (k === undefined) return { kind: "unreadable" };
      const seat = k === NO_SEAT_INDEX ? "none" : ticketSeatOf(plan.plan, k);
      if (!seat) return { kind: "unreadable" };
      seats.set(slot, seat);
    }
    return { kind: "seats", seats };
  } catch {
    return { kind: "unreadable" };
  }
}
