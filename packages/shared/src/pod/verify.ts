/**
 * ed25519 ticket signature verification.
 * Shared between frontend and server so both can verify ticket integrity.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import type { SignedTicket } from "../event/types.js";

/**
 * Verify a signed ticket's ed25519 signature.
 * Returns true if the signature is valid for the given data and public key.
 */
export function verifyTicketSignature(ticket: SignedTicket): boolean {
  try {
    const message = new TextEncoder().encode(JSON.stringify(ticket.data));
    const sigBytes = hexToBytes(
      ticket.signature.startsWith("0x") ? ticket.signature.slice(2) : ticket.signature,
    );
    const pubBytes = hexToBytes(
      ticket.publicKey.startsWith("0x") ? ticket.publicKey.slice(2) : ticket.publicKey,
    );
    return ed25519.verify(sigBytes, message, pubBytes);
  } catch {
    return false;
  }
}
