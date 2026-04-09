import type { Hex64, Hex0x } from "../types.js";
import type { OrderField, SealedBox } from "../crypto/types.js";

/** How attendees can claim tickets for an event */
export type ClaimMode = "wallet" | "email" | "both";

// ---------------------------------------------------------------------------
// Payment types
// ---------------------------------------------------------------------------

/** Supported payment chains: Ethereum mainnet, Base, Optimism, + Sepolia (testnet) */
export type PaymentChainId = 1 | 8453 | 10 | 11155111;

/** Payment configuration per ticket series */
export interface PaymentConfig {
  /** Price as a decimal string (e.g. "5.00" for USD/USDC, "0.005" for ETH) */
  price: string;
  /** Pricing currency: USD = priced in dollars paid in ETH, ETH = priced in ETH, USDC = priced in USDC */
  currency: "USD" | "ETH" | "USDC";
  /** Recipient address (organiser wallet or escrow contract) */
  recipientAddress: Hex0x;
  /** Accepted chains (default: [8453] = Base) */
  acceptedChains: PaymentChainId[];
  /** Whether payment goes through escrow (server sets based on organiser trust) */
  escrow: boolean;
}

/** Payment proof submitted alongside a claim request */
export interface PaymentProof {
  /** "x402" for USDC via x402 protocol, "tx" for direct on-chain tx */
  type: "x402" | "tx";
  /** Transaction hash (for type: "tx") */
  txHash?: string;
  /** Chain ID where payment was made */
  chainId: PaymentChainId;
  /**
   * Address that sent the transaction (for type: "tx").
   * Server MUST verify tx.from === this value AND bind it to the claimer
   * (parentAddress for wallet mode, signed claimerProof for email/passkey).
   * Prevents front-running attackers from reusing someone else's pending payment.
   */
  from?: Hex0x;
  /**
   * For non-wallet claims (email, passkey): EIP-191 signature by `from` over the
   * canonical message `woco-payment-v1:{txHash}:{claimContext}`. Proves the
   * person submitting the claim controls the paying wallet.
   * claimContext = `{eventId}:{seriesId}:{identifier}` where identifier is the
   * email or passkey-address the claim is being made against.
   */
  claimerProof?: string;
  /** x402 payment header value (for type: "x402") */
  x402Header?: string;
}

/** USDC contract addresses by chain (native Circle-issued USDC) */
export const USDC_ADDRESSES: Partial<Record<PaymentChainId, Hex0x>> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex0x,
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex0x,
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Hex0x,
  // No USDC on Sepolia testnet — ETH only for testing
};

/** Human-readable chain names */
export const CHAIN_NAMES: Record<PaymentChainId, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  11155111: "Sepolia",
};

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
  /** If true, attendees submit a request; organizer approves/rejects from dashboard */
  approvalRequired?: boolean;
  /** Sales phase label e.g. "Early Bird", "General Release" */
  wave?: string;
  /** ISO datetime when this series opens for claims (server-enforced) */
  saleStart?: string;
  /** ISO datetime when this series closes for claims (server-enforced) */
  saleEnd?: string;
  /** If set, claim button becomes "Register & Pay" and redirects here */
  paymentRedirectUrl?: string;
  /** Crypto payment config — absent means free event */
  payment?: PaymentConfig;
}

/** Entry in the global event directory feed */
export interface EventDirectoryEntry {
  eventId: string;
  title: string;
  imageHash: Hex64;
  startDate: string;
  endDate?: string;
  location: string;
  creatorAddress: Hex0x;
  seriesCount: number;
  totalTickets: number;
  createdAt: string;
  /** API base URL of the organiser's self-hosted backend (if deployed via site builder).
   *  When present, WoCo fetches event data and routes claims to this URL. */
  apiUrl?: string;
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
    approvalRequired?: boolean;
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    paymentRedirectUrl?: string;
    /** Crypto payment config — absent means free event */
    payment?: PaymentConfig;
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
  /** If true, skip adding to the public event directory on creation.
   *  Used by site builder — organiser lists explicitly with a siteUrl after deploying. */
  skipAutoList?: boolean;
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
  /** Approval status — present when the series has approvalRequired: true */
  approvalStatus?: "pending" | "approved" | "rejected";
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
  /** On-chain payment proof (for paid events) */
  paymentProof?: PaymentProof;
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
  /** True when the series requires organizer approval — ticket is pending, not yet issued */
  approvalPending?: boolean;
  /** ID of the pending claim entry (only present when approvalPending is true) */
  pendingId?: string;
  error?: string;
}

/** Claim status for a series (returned by GET .../claim-status) */
export interface SeriesClaimStatus {
  seriesId: string;
  totalSupply: number;
  claimed: number;
  available: number;
  /** If the requesting user has an approved claim, their edition number */
  userEdition?: number;
  /** If the requesting user has a pending approval request, the pendingId */
  userPendingId?: string;
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

// ---------------------------------------------------------------------------
// Organizer approval flow (pending claims)
// ---------------------------------------------------------------------------

/** A single pending claim entry in the pending-claims feed */
export interface PendingClaimEntry {
  /** Random UUID assigned at request time */
  pendingId: string;
  /** Wallet address (lowercase) or "email:{sha256hash}" — pseudonymous */
  claimerKey: string;
  requestedAt: string;
  /** Swarm ref to ECIES-encrypted order data (same format as claimers feed orderRef) */
  orderRef?: string;
  /** Swarm ref to the reserved ClaimedTicket (written with approvalStatus: "pending") */
  claimedRef: string;
  status: "pending" | "approved" | "rejected";
  decidedAt?: string;
  /** Organizer-written rejection reason — not attendee data */
  rejectionReason?: string;
}

/** Pending claims feed stored per series */
export interface PendingClaimsFeed {
  v: 1;
  seriesId: string;
  pending: PendingClaimEntry[];
  updatedAt: string;
}
