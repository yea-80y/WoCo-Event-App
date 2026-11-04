/**
 * Offline ticket verification — the cryptographic core of the scanner.
 *
 * ONE accept path: recover the EIP-191 signer from the QR sig over the locked
 * canonical message and compare against the pre-downloaded on-chain slotOwner.
 * Public Swarm data cannot forge this — the signing key is a per-purchase
 * burner that is discarded immediately after signing, so the only valid QR for
 * a slot is the one emitted at purchase.
 *
 * A series with no `onChainEventId` is rejected outright. The old v1 path
 * matched sha256(sig) against a claim ledger and, when a ledger entry carried
 * no sig hash, accepted on claim-presence with NO signature check at all. That
 * ledger has not been written since the v1 rail was deleted, so the branch was
 * unreachable from a fresh pack — but packs persist in IndexedDB for offline
 * use, and a fail-open path inside the verifier is not something to leave
 * sitting behind a data-shape coincidence.
 */

import { recoverMessageAddress } from "viem";
import {
  buildTicketCanonicalMessage,
  NO_SEAT_INDEX,
  parseTicketQr,
  type CheckinPack,
  type CheckinSeries,
  type TicketQr,
} from "@woco/shared";
import type { TicketSeat } from "@woco/shared/seating/ticket-seat";

export type VerifyVerdict =
  /** `seat`: allocated seating only - the seat as printed, null when its details could not be read. */
  | { status: "valid"; strength: "onchain"; ticket: TicketQr; seriesName: string; seat?: TicketSeat | null }
  /** Genuine, but its sale was refunded in full or charged back (#645): not admitted, and no check-in is recorded. */
  | { status: "refunded"; ticket: TicketQr; seriesName: string }
  /** Genuine and seated, but the ledger says it has no seat now (moved out of it): not admitted. */
  | { status: "no-seat"; ticket: TicketQr; seriesName: string }
  /** `code` is set only where a newer pack could change the answer: the ticket may
   *  have been sold, or its ticket type added or enlarged, since this pack was made. */
  | { status: "invalid"; reason: string; ticket?: TicketQr; code?: PackMissCode }
  | { status: "wrong-event"; ticket: TicketQr }
  | { status: "unreadable" };

/** `unread`: the pack could not read this ticket's owner or seat - never a red verdict. */
export type PackMissCode = "no-owner" | "unknown-series" | "out-of-range" | "unread";

export const UNREAD_REASON = "This ticket couldn't be checked against the ticket list - scan again";
export const SEATS_MISSING_REASON = "This scanner's seat list is out of date - scan again in a moment";

/**
 * Where a seated ticket may sit, by the pack (docs/SEATING.md "Door + tickets"). The
 * seat decides; its label is display and never refuses. Shared by the camera and the
 * roster's manual check-in.
 */
export type DoorSeat =
  | { kind: "unseated" }
  | { kind: "seat"; seat: TicketSeat | null }
  | { kind: "no-seat" }
  /** The seat read failed, or the list has no seats for a seated type. */
  | { kind: "unread"; reason: string };

export function doorSeat(series: CheckinSeries, edition: number): DoorSeat {
  if (!series.seated) return { kind: "unseated" };
  if (!series.seats) return { kind: "unread", reason: SEATS_MISSING_REASON };
  const k = series.seats[edition - 1];
  if (k === null || k === undefined) return { kind: "unread", reason: UNREAD_REASON };
  if (k === NO_SEAT_INDEX) return { kind: "no-seat" };
  return { kind: "seat", seat: series.seatLabels?.[edition - 1] ?? null };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function verifyV2(series: CheckinSeries, ticket: TicketQr): Promise<VerifyVerdict> {
  const owner = series.slotOwners?.[ticket.edition - 1];
  if (owner === null) return { status: "invalid", reason: UNREAD_REASON, ticket, code: "unread" };
  if (!owner || owner === ZERO_ADDRESS) {
    return { status: "invalid", reason: "No ticket issued for this edition", ticket, code: "no-owner" };
  }
  if (!/^0x[0-9a-f]{130}$/i.test(ticket.sig)) {
    return { status: "invalid", reason: "Damaged ticket code", ticket };
  }
  let recovered: string;
  try {
    const message = buildTicketCanonicalMessage({
      onChainEventId: series.onChainEventId!,
      seriesId: ticket.seriesId,
      edition: ticket.edition,
    });
    recovered = await recoverMessageAddress({ message, signature: ticket.sig as `0x${string}` });
  } catch {
    return { status: "invalid", reason: "Not a genuine ticket", ticket };
  }
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    return { status: "invalid", reason: "Not a genuine ticket - it doesn't match the one sold", ticket };
  }
  // Only now, with the ticket proven genuine: a refund is a fact about a real
  // ticket, so a forged QR for a refunded slot must still read invalid above.
  if (series.voidSlots?.includes(ticket.edition - 1)) {
    return { status: "refunded", ticket, seriesName: series.name };
  }
  const place = doorSeat(series, ticket.edition);
  if (place.kind === "no-seat") return { status: "no-seat", ticket, seriesName: series.name };
  if (place.kind === "unread") return { status: "invalid", reason: place.reason, ticket, code: "unread" };
  return {
    status: "valid", strength: "onchain", ticket, seriesName: series.name,
    ...(place.kind === "seat" ? { seat: place.seat } : {}),
  };
}

/** Verify a raw QR payload against the pack. Pure + offline; no nullifier check here. */
export async function verifyTicket(raw: string, pack: CheckinPack): Promise<VerifyVerdict> {
  const ticket = parseTicketQr(raw);
  if (!ticket) return { status: "unreadable" };
  if (ticket.eventId !== pack.eventId) return { status: "wrong-event", ticket };

  const series = pack.series.find((s) => s.seriesId === ticket.seriesId);
  if (!series) return { status: "invalid", reason: "Unknown ticket type for this event", ticket, code: "unknown-series" };
  if (ticket.edition > series.totalSupply) {
    return { status: "invalid", reason: "Edition number out of range", ticket, code: "out-of-range" };
  }
  // Fail closed: without an on-chain event there is no trustworthy owner to
  // recover against, so there is nothing to verify a signature with.
  if (!series.onChainEventId) {
    return { status: "invalid", reason: "This ticket type hasn't been set up for sale", ticket };
  }

  return verifyV2(series, ticket);
}
