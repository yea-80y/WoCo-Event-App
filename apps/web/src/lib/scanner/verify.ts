/**
 * Offline ticket verification — the cryptographic core of the scanner.
 *
 * v2 (on-chain series): recover the EIP-191 signer from the QR sig over the
 * locked canonical message and compare against the pre-downloaded on-chain
 * slotOwner. Public Swarm data cannot forge this — the burner private key
 * exists only in the buyer's ticket.
 *
 * v1 (Swarm-only series): the QR sig is the creator's ed25519 edition sig,
 * which is public feed data. We match sha256(sig) against the claim ledger —
 * this proves the ticket was genuinely claimed, but NOT who holds it; the
 * one-time-use nullifier is the real gate. Surfaced as a distinct verdict so
 * the UI can badge it honestly.
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
  | { status: "valid"; strength: "onchain" | "ledger"; ticket: TicketQr; seriesName: string }
  | { status: "invalid"; reason: string; ticket?: TicketQr }
  | { status: "wrong-event"; ticket: TicketQr }
  | { status: "unreadable" };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

async function verifyV1(series: CheckinSeries, ticket: TicketQr): Promise<VerifyVerdict> {
  const entry = series.claimedEditions?.find((e) => e.edition === ticket.edition);
  if (!entry) {
    return { status: "invalid", reason: "No claim recorded for this edition", ticket };
  }
  // Ledger entries without a sig hash (blob fetch failed at pack time) fall
  // back to claim-presence only — still gated by the nullifier.
  if (entry.sigHash && (await sha256Hex(ticket.sig)) !== entry.sigHash.toLowerCase()) {
    return { status: "invalid", reason: "Signature does not match the claim ledger", ticket };
  }
  return { status: "valid", strength: "ledger", ticket, seriesName: series.name };
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

  return series.onChainEventId ? verifyV2(series, ticket) : verifyV1(series, ticket);
}
