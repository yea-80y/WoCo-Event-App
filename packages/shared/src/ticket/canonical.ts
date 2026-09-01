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

// The `woco-claimed-owner-v2` owner-binding message and its platform signer
// were DELETED with #448: the attestation was produced by nothing and verified
// by nothing (the PR 1 audit found zero callers end to end), and an unverified
// signature field in a public blob invites someone to trust it later without
// noticing nothing ever checked it. Ownership that is enforced lives on chain
// (`slotOwner`) and in the attendee-gate binding store. If issued-to-identity
// attestation is ever wanted for real, mint it fresh under a new domain with a
// verifier in the same PR.
