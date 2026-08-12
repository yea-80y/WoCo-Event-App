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
  parseTicketQr,
  type CheckinPack,
  type CheckinSeries,
  type TicketQr,
} from "@woco/shared";

export type VerifyVerdict =
  | { status: "valid"; strength: "onchain"; ticket: TicketQr; seriesName: string }
  | { status: "invalid"; reason: string; ticket?: TicketQr }
  | { status: "wrong-event"; ticket: TicketQr }
  | { status: "unreadable" };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function verifyV2(series: CheckinSeries, ticket: TicketQr): Promise<VerifyVerdict> {
  const owner = series.slotOwners?.[ticket.edition - 1];
  if (!owner || owner === ZERO_ADDRESS) {
    return { status: "invalid", reason: "No ticket issued for this edition", ticket };
  }
  if (!/^0x[0-9a-f]{130}$/i.test(ticket.sig)) {
    return { status: "invalid", reason: "Malformed signature", ticket };
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
    return { status: "invalid", reason: "Signature does not verify", ticket };
  }
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    return { status: "invalid", reason: "Signature does not match the on-chain ticket owner", ticket };
  }
  return { status: "valid", strength: "onchain", ticket, seriesName: series.name };
}

/** Verify a raw QR payload against the pack. Pure + offline; no nullifier check here. */
export async function verifyTicket(raw: string, pack: CheckinPack): Promise<VerifyVerdict> {
  const ticket = parseTicketQr(raw);
  if (!ticket) return { status: "unreadable" };
  if (ticket.eventId !== pack.eventId) return { status: "wrong-event", ticket };

  const series = pack.series.find((s) => s.seriesId === ticket.seriesId);
  if (!series) return { status: "invalid", reason: "Unknown ticket type for this event", ticket };
  if (ticket.edition > series.totalSupply) {
    return { status: "invalid", reason: "Edition number out of range", ticket };
  }
  // Fail closed: without an on-chain event there is no trustworthy owner to
  // recover against, so there is nothing to verify a signature with.
  if (!series.onChainEventId) {
    return { status: "invalid", reason: "Ticket type is not registered on-chain", ticket };
  }

  return verifyV2(series, ticket);
}
