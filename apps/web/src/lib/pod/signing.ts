import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { TicketData, SignedTicket } from "@woco/shared";

/**
 * Sign ticket data with an ed25519 private key.
 * The signature covers the JSON-serialized ticket data.
 */
export async function signTicket(
  data: TicketData,
  privateKey: Uint8Array,
  publicKeyHex: string,
): Promise<SignedTicket> {
  const message = new TextEncoder().encode(JSON.stringify(data));
  const signature = await ed.signAsync(message, privateKey);

  return {
    data,
    signature: bytesToHex(signature),
    publicKey: publicKeyHex,
  };
}

/** Verify a signed ticket's ed25519 signature. */
export async function verifyTicket(ticket: SignedTicket): Promise<boolean> {
  const message = new TextEncoder().encode(JSON.stringify(ticket.data));
  const sigBytes = hexToBytes(ticket.signature);
  const pubBytes = hexToBytes(
    ticket.publicKey.startsWith("0x") ? ticket.publicKey.slice(2) : ticket.publicKey,
  );
  return ed.verifyAsync(sigBytes, message, pubBytes);
}

/**
 * Create and sign all tickets for a series.
 * Returns an array of SignedTicket objects ready for upload.
 */
export async function createSeriesTickets(opts: {
  eventId: string;
  seriesId: string;
  seriesName: string;
  totalSupply: number;
  imageHash: string;
  creatorPrivateKey: Uint8Array;
  creatorPublicKeyHex: string;
}): Promise<SignedTicket[]> {
  const {
    eventId, seriesId, seriesName, totalSupply,
    imageHash, creatorPrivateKey, creatorPublicKeyHex,
  } = opts;

  const tickets: SignedTicket[] = [];
  const mintedAt = new Date().toISOString();

  for (let edition = 1; edition <= totalSupply; edition++) {
    const data: TicketData = {
      podType: "woco.ticket.v1",
      eventId,
      seriesId,
      seriesName,
      edition,
      totalSupply,
      imageHash,
      creator: creatorPublicKeyHex,
      mintedAt,
    };

    tickets.push(await signTicket(data, creatorPrivateKey, creatorPublicKeyHex));
  }

  return tickets;
}
