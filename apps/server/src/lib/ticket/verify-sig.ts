/**
 * Per-ticket signature verification against the on-chain slotOwner.
 *
 * The trust root is `slotOwner[onChainEventId][edition - 1]`. Anyone who can
 * recover that exact address from an EIP-191 sig over our canonical message
 * controls the burner key that the contract recorded at claim time, i.e. they
 * either bought the ticket or received it from someone who did. Public Swarm
 * data alone is insufficient to forge a valid sig.
 *
 * Shared by the /t ticket page (render gate) and the attendee gate
 * (possession proof). Verdicts:
 *   "valid"      — v2 event, sig recovers to the on-chain owner
 *   "invalid"    — v2 event, sig does NOT recover to the owner (forgery attempt)
 *   "unverified" — pre-on-chain (v1) event, or chain read failed
 */

import { verifyMessage } from "ethers";
import { buildTicketCanonicalMessage } from "@woco/shared";
import { getEvent } from "../event/service.js";
import { getSlotData, getActiveChainId } from "../chain/event-contract.js";

export type TicketSigVerdict = "valid" | "invalid" | "unverified";

export async function verifyTicketSig(params: {
  eventId: string;
  seriesId: string;
  edition: number;
  sig: string;
}): Promise<TicketSigVerdict> {
  // Sig must at least look like a 0x-prefixed 65-byte hex string — bail early
  // on garbage rather than letting verifyMessage throw.
  if (!/^0x[0-9a-f]{130}$/i.test(params.sig)) return "invalid";

  const ev = await getEvent(params.eventId).catch(() => null);
  if (!ev) return "unverified";
  const series = ev.series.find((s) => s.seriesId === params.seriesId);
  if (!series) return "unverified";
  if (!series.onChainEventId) return "unverified"; // v1 — no on-chain trust root

  let slot;
  try {
    slot = await getSlotData(series.onChainEventId, params.edition - 1, getActiveChainId());
  } catch (err) {
    console.warn(`[ticket-sig] Slot read failed (edition=${params.edition}):`, err);
    return "unverified";
  }

  // Unclaimed slot: owner is the zero address. A sig over an unowned slot
  // can never be valid — treat as invalid.
  if (!slot.owner || slot.owner === "0x0000000000000000000000000000000000000000") {
    return "invalid";
  }

  let recovered;
  try {
    const canonical = buildTicketCanonicalMessage({
      onChainEventId: series.onChainEventId,
      seriesId: params.seriesId,
      edition: params.edition,
    });
    recovered = verifyMessage(canonical, params.sig).toLowerCase();
  } catch {
    return "invalid";
  }
  return recovered === slot.owner.toLowerCase() ? "valid" : "invalid";
}
