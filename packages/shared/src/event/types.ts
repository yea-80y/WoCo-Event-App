import type { Hex64, Hex0x } from "../types.js";
import type { OrderField, SealedBox } from "../crypto/types.js";

/** How attendees can claim tickets for an event */
export type ClaimMode = "wallet" | "email" | "both";

// ---------------------------------------------------------------------------
// Payment types
// ---------------------------------------------------------------------------

/** Supported payment chains: Ethereum mainnet, Base, Optimism, + Sepolia (testnet) */
export type PaymentChainId = 1 | 8453 | 10 | 11155111;

/** Fiat currencies supported for ticket pricing */
export type FiatCurrency = "USD" | "GBP" | "EUR";

/** Payment configuration per ticket series */
export interface PaymentConfig {
  /** Price as a decimal string in fiat (e.g. "10.00") */
  price: string;
  /** Fiat currency the organiser set the price in */
  currency: FiatCurrency;
  /** Recipient address (organiser wallet or escrow contract) */
  recipientAddress: Hex0x;
  /** Accepted chains for crypto payments (empty = crypto disabled) */
  acceptedChains: PaymentChainId[];
  /** Whether crypto payment goes through escrow */
  escrow: boolean;
  /** Whether crypto payments are accepted */
  cryptoEnabled: boolean;
  /** Whether Stripe card payments are accepted */
  stripeEnabled: boolean;
  /** When true, processing fees are added on top of the ticket price (buyer pays).
   *  When false (default), fees come out of the organiser's revenue. */
  feePassedToCustomer?: boolean;
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
  /**
   * Server-issued, HMAC-signed payment quote. When present, the server verifies
   * its own signature over the quote and uses quote.amountWei as the exact wei
   * the on-chain tx.value must satisfy — no slippage tolerance, no oracle race.
   * The full quote travels with the proof so the server can verify statelessly
   * (only the consumed-quoteId set needs to persist).
   */
  quote?: PaymentQuote;
}

/**
 * Server-issued payment quote — the server commits cryptographically (HMAC) to an
 * exact wei amount + recipient + expiry. The client pays exactly amountWei; the
 * server verifies the on-chain tx.value matches exactly. One-shot consumption.
 */
export interface PaymentQuote {
  quoteId: string;
  seriesId: string;
  chainId: PaymentChainId;
  currency: "ETH" | "USDC";
  recipient: Hex0x;
  /** Exact amount in the chain's smallest unit (wei for ETH, 6-dec atomic for USDC) */
  amountWei: string;
  /** Display-only — what the user sees in the UI */
  fiatPrice: string;
  fiatCurrency: string;
  /** Unix milliseconds. Quote rejected after this. */
  expiresAt: number;
  /** Optional binding to a specific claimer address (lower-cased) */
  boundTo?: string;
  /** HMAC-SHA256 hex over the canonical quote string */
  sig: string;
}

/** Platform fee in basis points — must match WoCoEscrow.sol FEE_BASIS_POINTS */
export const PLATFORM_FEE_BP = 150; // 1.5%

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

/**
 * Minimum on-chain confirmations required before the server will issue a ticket.
 *
 * These protect against chain reorgs — if the server mints a Swarm-feed ticket
 * against an orphaned payment tx, there's no "undo" because feeds are
 * append-only. The numbers reflect realistic reorg depths per chain under PoS:
 *
 * - Mainnet (12): conservative; PoS reorgs beyond 2 blocks require validator
 *   misbehaviour, but 12 brings us close to a justified slot.
 * - Sepolia (3): testnet PoS; same model as mainnet but we accept a lower bar.
 * - Base/Optimism (3): L2 soft finality — we trust the sequencer has published.
 *   True L1 finality takes hours/days; nobody waits for it for ticketing.
 *
 * The client MUST wait for at least this many confirmations before posting the
 * claim — the server re-verifies against the same threshold. Client usually
 * waits for +1 to absorb RPC-node head-of-chain skew.
 *
 * DO NOT lower these without understanding the reorg threat model; see
 * docs/CRYPTO_AUDIT_2026-04-08.md.
 */
export const MIN_CONFIRMATIONS_BY_CHAIN: Record<PaymentChainId, number> = {
  1: 12,          // Ethereum mainnet
  8453: 3,        // Base
  10: 3,          // Optimism
  11155111: 3,    // Sepolia
};

/** Fallback if a chain is somehow not in the map (should never happen at runtime). */
export const DEFAULT_MIN_CONFIRMATIONS = 6;

/** Get the required confirmations for a chain. */
export function getMinConfirmations(chainId: number): number {
  return MIN_CONFIRMATIONS_BY_CHAIN[chainId as PaymentChainId] ?? DEFAULT_MIN_CONFIRMATIONS;
}

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
  /** HMAC-SHA256 hash of email.
   *  - Email-only claim: primary identifier.
   *  - Wallet + Stripe dual-identity: secondary identifier (email from Stripe,
   *    wallet from verified session). Both are valid claim handles. */
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

/**
 * A user's full ticket collection (stored as JSON feed, paginated).
 *
 * Each 4096-byte page holds roughly 20 entries before overflow. On overflow,
 * the server spills to `/pN` pages. Pages are discovered by probing
 * sequentially until a page is missing — no central page counter, so a
 * partial-write failure can't lock out future updates.
 */
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
  /**
   * Physical seats remaining (`totalSupply - claimed`). Active reservations
   * are NOT subtracted here — concurrency is enforced inside `/reserve`,
   * which validates against `available - heldFor()` at attempt time and
   * returns the precise remaining count if the request can't be satisfied.
   */
  available: number;
  /** Seats currently held by active reservations (informational). */
  held?: number;
  /** If the requesting user has an approved claim, their lowest edition number */
  userEdition?: number;
  /** All edition numbers owned by the requesting user (multi-purchase support) */
  userEditions?: number[];
  /** If the requesting user has a pending approval request, the pendingId */
  userPendingId?: string;
}

// ---------------------------------------------------------------------------
// Claimers feed (per-series tracking of who claimed what)
// ---------------------------------------------------------------------------

/** Single entry in the claimers JSON feed */
export interface ClaimerEntry {
  edition: number;
  /** Primary claim handle — lowercase wallet address, or "email:{hmacHash}" */
  claimerAddress: string;
  claimedRef: string;
  claimedAt: string;
  /** Swarm ref to ECIES-encrypted order data (only organizer can decrypt) */
  orderRef?: string;
  /** How this claim was paid for. Absent on legacy entries. */
  via?: ClaimVia;
  /** HMAC-SHA256 hash of a secondary email identifier. Set when a wallet user
   *  paid by Stripe — the Stripe customer email is recorded alongside the
   *  verified wallet so dedup works against both handles. */
  secondaryEmailHash?: string;
}

/** Payment method used to obtain a ticket. */
export type ClaimVia = "stripe" | "crypto" | "free";

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
  /** How this claim was paid for. Absent on legacy entries. */
  via?: ClaimVia;
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
