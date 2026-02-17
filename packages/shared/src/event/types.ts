import type { Hex64, Hex0x } from "../types.js";
import type { OrderField, SealedBox } from "../crypto/types.js";

/** How attendees can claim tickets for an event */
export type ClaimMode = "wallet" | "email" | "both";

/** Full event metadata stored in Swarm feed */
export interface EventFeed {
  v: 1;
  eventId: string;
  title: string;
  description: string;
  imageHash: Hex64;
  startDate: string;
  endDate: string;
  location: string;
  creatorAddress: Hex0x;
  creatorPodKey: string;
  series: SeriesSummary[];
  createdAt: string;
  /** Organizer's X25519 public key for order encryption (hex, no 0x prefix) */
  encryptionKey?: string;
  /** Order form fields — present when organizer collects customer info */
  orderFields?: OrderField[];
  /** How attendees can claim tickets (default: "wallet") */
  claimMode?: "wallet" | "email" | "both";
}

/** Ticket series summary (stored within event feed) */
export interface SeriesSummary {
  seriesId: string;
  name: string;
  description: string;
  totalSupply: number;
  price: number;
}

/** Entry in the global event directory feed */
export interface EventDirectoryEntry {
  eventId: string;
  title: string;
  imageHash: Hex64;
  startDate: string;
  location: string;
  creatorAddress: Hex0x;
  seriesCount: number;
  totalTickets: number;
  createdAt: string;
}

/** Ticket data fields (before signing) */
export interface TicketData {
  podType: "woco.ticket.v1";
  eventId: string;
  seriesId: string;
  seriesName: string;
  edition: number;
  totalSupply: number;
  imageHash: string;
  creator: string;
  mintedAt: string;
}

/** Signed ticket (ticket data + ed25519 signature) */
export interface SignedTicket {
  data: TicketData;
  signature: string;
  publicKey: string;
}

/** Request body for POST /api/events */
export interface CreateEventRequest {
  event: {
    title: string;
    description: string;
    startDate: string;
    endDate: string;
    location: string;
  };
  series: Array<{
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
  }>;
  /** Signed tickets grouped by seriesId */
  signedTickets: Record<string, SignedTicket[]>;
  /** Base64-encoded event image */
  image: string;
  /** Creator's eth address */
  creatorAddress: Hex0x;
  /** Creator's ed25519 public key (hex) */
  creatorPodKey: string;
  /** Organizer's X25519 encryption public key (hex, derived from POD seed) */
  encryptionKey?: string;
  /** Order form fields (if organizer wants to collect attendee info) */
  orderFields?: OrderField[];
  /** How attendees can claim tickets (default: "wallet") */
  claimMode?: "wallet" | "email" | "both";
}

/** Response from POST /api/events */
export interface CreateEventResponse {
  ok: boolean;
  eventId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** A claimed ticket (original ticket data + claim metadata) */
export interface ClaimedTicket {
  podType: "woco.ticket.claimed.v1";
  eventId: string;
  seriesId: string;
  seriesName: string;
  edition: number;
  totalSupply: number;
  imageHash: string;
  creator: string;
  mintedAt: string;
  /** ed25519 public key (optional — only present when POD identity was derived) */
  owner?: string;
  /** Wallet address (for wallet-based claims) */
  ownerAddress?: Hex0x;
  /** SHA-256 hash of email (for email-based claims) */
  ownerEmailHash?: string;
  claimedAt: string;
  originalPodHash: string;
  originalSignature: string;
}

/** Request body for POST /api/events/:eventId/series/:seriesId/claim */
export interface ClaimTicketRequest {
  mode: "wallet" | "email" | "api";
  /** Wallet address (mode: wallet) */
  walletAddress?: string;
  /** Email address (mode: email) */
  email?: string;
  /** API key for organizer claims (mode: api) */
  apiKey?: string;
  /** ECIES-encrypted order data — only the event organizer can decrypt */
  encryptedOrder?: SealedBox;
}

// ---------------------------------------------------------------------------
// User Collection (Passport)
// ---------------------------------------------------------------------------

/** A single entry in a user's ticket collection */
export interface CollectionEntry {
  seriesId: string;
  eventId: string;
  edition: number;
  claimedRef: string;
  claimedAt: string;
}

/** A user's full ticket collection (stored as JSON feed) */
export interface UserCollection {
  v: 1;
  entries: CollectionEntry[];
  updatedAt: string;
}

/** Response from claim endpoint */
export interface ClaimTicketResponse {
  ok: boolean;
  ticket?: ClaimedTicket;
  edition?: number;
  error?: string;
}

/** Claim status for a series (returned by GET .../claim-status) */
export interface SeriesClaimStatus {
  seriesId: string;
  totalSupply: number;
  claimed: number;
  available: number;
  /** If the requesting user has claimed, their edition number */
  userEdition?: number;
}

// ---------------------------------------------------------------------------
// Claimers feed (per-series tracking of who claimed what)
// ---------------------------------------------------------------------------

/** Single entry in the claimers JSON feed */
export interface ClaimerEntry {
  edition: number;
  claimerAddress: string;
  claimedRef: string;
  claimedAt: string;
  /** Swarm ref to ECIES-encrypted order data (only organizer can decrypt) */
  orderRef?: string;
}

/** Claimers JSON feed stored per series */
export interface ClaimersFeed {
  v: 1;
  seriesId: string;
  claimers: ClaimerEntry[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Organizer order data (dashboard)
// ---------------------------------------------------------------------------

/** A single order entry returned to the organizer dashboard */
export interface OrderEntry {
  seriesId: string;
  seriesName: string;
  edition: number;
  claimerAddress: string;
  claimedAt: string;
  encryptedOrder?: SealedBox;
}
