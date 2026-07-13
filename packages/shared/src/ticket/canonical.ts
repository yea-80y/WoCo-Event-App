/**
 * Canonical per-ticket signing message — LOCKED FORMAT.
 *
 * The exact bytes signed by the burner wallet at claim time AND rebuilt by the
 * verifier at the door. Any change orphans every existing ticket — version
 * with `woco-ticket-v2` instead.
 *
 *   woco-ticket-v1\n
 *   {eventIdHex}\n         lowercase, 0x-prefixed bytes32 (on-chain eventId)
 *   {seriesId}\n           the Swarm/series UUID, verbatim
 *   {edition}\n            decimal, no padding, 1-indexed (slot + 1)
 *
 * EIP-191 (`personal_sign`) wraps this with `\x19Ethereum Signed Message:\n{len}`
 * before hashing — so verifiers MUST use `verifyMessage` / `recoverAddress`
 * with the personal-sign prefix, not raw keccak256.
 *
 * The signing key is the per-purchase burner whose address is recorded as
 * `slotOwner[onChainEventId][edition - 1]` on the WoCoEvent contract. The on-
 * chain owner is the trust root; anything verifiable against `ecrecover` of
 * this message + that address is a genuine ticket.
 */

export const TICKET_CANONICAL_VERSION = "woco-ticket-v1" as const;

export function buildTicketCanonicalMessage(params: {
  /** On-chain eventId — 0x-prefixed bytes32, lowercased. */
  onChainEventId: string;
  /** Swarm series UUID. */
  seriesId: string;
  /** 1-indexed edition number (slot + 1). */
  edition: number;
}): string {
  const eventId = params.onChainEventId.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(eventId)) {
    throw new Error(`Invalid onChainEventId: ${params.onChainEventId}`);
  }
  if (!params.seriesId) throw new Error("seriesId is required");
  if (!Number.isInteger(params.edition) || params.edition < 1) {
    throw new Error(`Invalid edition: ${params.edition}`);
  }
  return `${TICKET_CANONICAL_VERSION}\n${eventId}\n${params.seriesId}\n${params.edition}\n`;
}

/**
 * Canonical owner-binding message for `woco.ticket.claimed.v2` — LOCKED FORMAT.
 *
 * Signed EIP-191 by the PLATFORM feed signer at claim time when the buyer
 * already has a WoCo account: it attests "this edition was issued to this
 * attendee ed25519 identity". Verifiers recover the address and compare it to
 * the platform signer (the address that owns the platform Swarm feeds).
 * `eventId` is the WoCo event ULID (NOT the on-chain id — v1 feed events have
 * no on-chain id and must still be bindable). `claimedAt` is the ISO string
 * stored in the ClaimedTicket, verbatim.
 */
export const CLAIMED_OWNER_CANONICAL_VERSION = "woco-claimed-owner-v2" as const;

export function buildClaimedOwnerV2Message(params: {
  eventId: string;
  seriesId: string;
  /** 1-indexed edition number. */
  edition: number;
  /** Attendee ed25519 POD public key, hex, lowercase, no 0x prefix. */
  owner: string;
  /** ISO timestamp — must match ClaimedTicket.claimedAt byte-for-byte. */
  claimedAt: string;
}): string {
  if (!params.eventId || !params.seriesId) throw new Error("eventId and seriesId are required");
  if (!Number.isInteger(params.edition) || params.edition < 1) {
    throw new Error(`Invalid edition: ${params.edition}`);
  }
  const owner = params.owner.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(owner)) {
    throw new Error("owner must be a 32-byte hex ed25519 public key (no 0x prefix)");
  }
  if (!params.claimedAt) throw new Error("claimedAt is required");
  return `${CLAIMED_OWNER_CANONICAL_VERSION}\n${params.eventId}\n${params.seriesId}\n${params.edition}\n${owner}\n${params.claimedAt}\n`;
}
