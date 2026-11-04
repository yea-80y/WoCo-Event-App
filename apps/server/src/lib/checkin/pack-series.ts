/**
 * One ticket type's entry in the door scanner's pack: who holds each slot, which
 * slots were refunded, and for allocated seating each slot's seat
 * (docs/SEATING.md "Door + tickets").
 *
 * Seated or not is decided by TWO sources that must agree: the server's own
 * registration record (`registrationSeatingFor`, written only after the ledger said
 * seated) and the ledger's `isSeated`, read in the same batch as the owners. Never the
 * manifest or the event feed. Agreement either way decides; a disagreement (a record
 * that lost its seating fields to an older build's write, or a record missing) sends
 * the series as seated with no seats, which a scanner refuses rather than admitting
 * seatless tickets, and turns `/api/health` `doorSeats` red. With `isSeated`
 * unreadable the record decides: the owner reads are failing then too.
 *
 * Seats decide admission; labels are display. A plan that cannot be read leaves the
 * labels out and the door still admits - the steward sees "seat details unavailable".
 */

import { NO_SEAT_INDEX, type CheckinSeries } from "@woco/shared";
import { ticketSeatOf } from "@woco/shared/seating/plan";
import type { TicketSeat } from "@woco/shared/seating/ticket-seat";
import type { EventContractTarget } from "../chain/event-contract.js";
import type { PinnedPlan } from "../seating/seat-reads.js";
import type { SlotStates } from "./slot-state.js";

export interface PackSeriesInput {
  seriesId: string;
  name: string;
  totalSupply: number;
  onChainEventId?: string;
  swarmManifestRef?: string;
}

export interface PackSeriesDeps {
  contractFor(eventId: string, seriesId: string): EventContractTarget | undefined;
  seatingFor(eventId: string, seriesId: string): { planDigest: string } | null;
  nextSlot(contract: EventContractTarget, onChainEventId: string): Promise<number | null>;
  /** `nextSlot` null = the event could not be read: cached slots only, null up to `supply`. */
  slotStates(
    contract: EventContractTarget,
    onChainEventId: string,
    nextSlot: number | null,
    opts: { seats: boolean; supply: number },
  ): Promise<SlotStates>;
  /** Older contracts (no seats): one owner per slot, null where never read. */
  slotOwners(contract: EventContractTarget, onChainEventId: string, nextSlot: number | null, supply: number): Promise<(string | null)[]>;
  voidedSlots(onChainEventId: string, contract: EventContractTarget): number[];
  plan(swarmManifestRef: string | undefined, planDigest: string): Promise<PinnedPlan>;
}

export async function packSeries(eventId: string, s: PackSeriesInput, deps: PackSeriesDeps): Promise<CheckinSeries> {
  const entry = await buildSeries(eventId, s, deps);
  const key = `${eventId}\u0000${s.seriesId}`;
  if (entry.seated) seatedAtDoor.add(key);
  else seatedAtDoor.delete(key);
  return entry;
}

/** The last pack sent this ticket type as seated (a disagreement included): `/claim` gates old scanners on it. */
export function isSeatedAtDoor(eventId: string, seriesId: string): boolean {
  return seatedAtDoor.has(`${eventId}\u0000${seriesId}`);
}

async function buildSeries(eventId: string, s: PackSeriesInput, deps: PackSeriesDeps): Promise<CheckinSeries> {
  const entry: CheckinSeries = { seriesId: s.seriesId, name: s.name, totalSupply: s.totalSupply };
  // Slot owners come from the contract, which is the only ticket ledger. A series that
  // never finished registering has no slots, so it contributes an empty entry.
  if (!s.swarmManifestRef || !s.onChainEventId) return entry;
  entry.onChainEventId = s.onChainEventId as CheckinSeries["onChainEventId"];
  // Owners are read on the contract the registration lives on (#563), so a ticket on an
  // older contract still verifies at the door after a cutover.
  const contract = deps.contractFor(eventId, s.seriesId);
  const pin = deps.seatingFor(eventId, s.seriesId);
  if (!contract) {
    if (pin) entry.seated = true;
    entry.slotOwners = [];
    return entry;
  }
  // Event unreadable: no slot count, so the readers answer from what they last knew.
  const nextSlot = await deps.nextSlot(contract, s.onChainEventId).catch(() => null);

  if (contract.version !== "ledger2") {
    entry.slotOwners = await deps.slotOwners(contract, s.onChainEventId, nextSlot, s.totalSupply);
    if (pin) {
      // A seated record on a contract with no seats: refuse, as for a disagreement.
      entry.seated = true;
      noteSeatDisagreement(eventId, s.seriesId, true);
    }
    return withVoids(entry, s.onChainEventId, contract, deps);
  }

  const read = await deps.slotStates(contract, s.onChainEventId, nextSlot, { seats: !!pin, supply: s.totalSupply });
  entry.slotOwners = read.owners;
  const recordSeated = !!pin;
  const agreed = read.seated === null || read.seated === recordSeated;
  noteSeatDisagreement(eventId, s.seriesId, !agreed);
  if (!agreed) {
    entry.seated = true;
    console.error(
      `[checkin] ${eventId}/${s.seriesId}: ledger isSeated=${read.seated} but the registration record says ` +
        `${recordSeated ? "seated" : "not seated"} - door refuses this ticket type until repaired`,
    );
    return withVoids(entry, s.onChainEventId, contract, deps);
  }
  if (!pin) return withVoids(entry, s.onChainEventId, contract, deps);

  entry.seated = true;
  entry.seats = read.seats;
  const plan = await deps.plan(s.swarmManifestRef, pin.planDigest).catch(() => null);
  if (plan?.ok) entry.seatLabels = read.seats.map((k): TicketSeat | null => (k !== null && k !== NO_SEAT_INDEX ? ticketSeatOf(plan.plan, k) : null));
  return withVoids(entry, s.onChainEventId, contract, deps);
}

/** Refunded sales (#645), keyed by the same (event, slot) the owners are, on the same contract. */
function withVoids(entry: CheckinSeries, onChainEventId: string, contract: EventContractTarget, deps: PackSeriesDeps): CheckinSeries {
  const refunded = deps.voidedSlots(onChainEventId, contract);
  if (refunded.length > 0) entry.voidSlots = refunded;
  return entry;
}

// ── Health ───────────────────────────────────────────────────────────────────

/** Series whose last pack found the ledger and the registration record disagreeing. */
const disagreeing = new Set<string>();
/** Series the last pack sent as seated. */
const seatedAtDoor = new Set<string>();

function noteSeatDisagreement(eventId: string, seriesId: string, now: boolean): void {
  const key = `${eventId}\u0000${seriesId}`;
  if (now) disagreeing.add(key);
  else disagreeing.delete(key);
}

/** `/api/health` `doorSeats`: a count only (the endpoint is public). */
export function doorSeatsHealth(): { ok: boolean; disagreements: number } {
  return { ok: disagreeing.size === 0, disagreements: disagreeing.size };
}

/** Tests only. */
export function clearDoorSeatsHealth(): void {
  disagreeing.clear();
  seatedAtDoor.clear();
}
