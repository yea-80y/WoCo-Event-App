import type { Hex64, Hex0x } from "../types.js";
import type { OrderField, SealedBox } from "../crypto/types.js";
import type { PodGate, PodGateGroup } from "../pod/types.js";
import type { SignedManifestV2, EditionV1Body } from "../edition/types.js";
import type { IssuerBindingV1 } from "../crypto/issuing.js";

/** How attendees can claim tickets for an event */
export type ClaimMode = "wallet" | "email" | "both";

// ---------------------------------------------------------------------------
// Discovery facet tags
// ---------------------------------------------------------------------------

/**
 * Facet a discovery tag belongs to. `genre` is the controlled-vocabulary facet
 * surfaced at launch (see event/tags.ts for the vocab + build-time normaliser).
 * `location` is now free-text/legacy only — structured location moved to the
 * `EventGeo` object (event/geo.ts); the `location` facet is no longer controlled
 * and is retained for backward-compat with pre-#37 signed feeds. `artist` +
 * `brand` are reserved for a later UI addition on the SAME mechanism (no schema
 * migration — e.g. a music `subgenre` facet). `other` is the free-text escape
 * hatch — an uncontrolled value the normaliser keeps rather than dropping.
 */
export type EventTagType = "location" | "genre" | "artist" | "brand" | "other";

/**
 * A single discovery tag. Lives in the CREATOR-SIGNED event content (EventFeed) —
 * the truth layer — and is copied + normalised into each directory snapshot card
 * at build time. Never invented at snapshot-build time (that would be
 * platform-editable and unrebuildable, breaking the cache-not-truth rule).
 */
export interface EventTag {
  type: EventTagType;
  /** Human-readable facet value, e.g. "Techno". Normalised at build. */
  value: string;
}

// ---------------------------------------------------------------------------
// Structured event geography (location model, #37)
// ---------------------------------------------------------------------------

/**
 * Where an event happens — structured, coordinate-anchored geography. Replaces
 * the old flat `location` discovery tag (a curated place-name vocab can't scale
 * internationally). See event/geo.ts for the country vocab + `normaliseGeo`.
 *
 * Lives in the CREATOR-SIGNED event content (truth); copied + normalised into
 * each snapshot card at build time. Populated at CREATE time by a client-side
 * OPEN places geocoder (OSM/Nominatim/Photon/Mapbox — never Google Places, whose
 * ToS forbids storing coordinates). Reads/discovery never touch a geocoder —
 * cards filter client-side by country/coords. The free-text `EventFeed.location`
 * string stays independent as the venue/address DISPLAY line.
 */
export interface EventGeo {
  /** ISO 3166-1 alpha-2 (uppercase) — the coarse, controlled, bundled filter. */
  country?: string;
  /** Geocoder-canonicalised city/town label (display + secondary filter). */
  city?: string;
  /** Named place ("like Google") — display. */
  venue?: string;
  /** Formatted address line — display. */
  address?: string;
  /** Latitude — the universal filter primitive (enables "near me" / map). */
  lat?: number;
  /** Longitude. */
  lng?: number;
  /** RESERVED: future link to a WoCo venue profile. Empty at launch; reserving
   *  it now means the venue-profile graph needs no schema migration. */
  venueRef?: string;
}

// ---------------------------------------------------------------------------
// Payment types
// ---------------------------------------------------------------------------

/** Supported payment chains: Ethereum mainnet, Base, Optimism, Arbitrum One,
 *  + Sepolia / Arbitrum Sepolia (testnets) */
export type PaymentChainId = 1 | 8453 | 10 | 42161 | 11155111 | 421614;

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
  /**
   * Organiser-set buyer-pays fee percentage. Only meaningful when
   * `feePassedToCustomer` is true. Must be ≥ BUYER_FEE_FLOOR_PCT (4.5%).
   * Default BUYER_FEE_DEFAULT_PCT (10%). The buyer is charged
   * price × (1 + buyerFeePercent/100); the organiser keeps the gap
   * between the markup and the actual Stripe + platform deductions.
   */
  buyerFeePercent?: number;
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
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Hex0x,
  // Circle native test USDC on Arbitrum Sepolia (faucet.circle.com) — same 6-dec
  // ERC-20 surface as mainnet, so going live is a one-line swap to 42161 above.
  // No native USDC on Ethereum Sepolia (11155111) — ETH only there for testing.
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Hex0x,
};

/** Human-readable chain names */
export const CHAIN_NAMES: Record<PaymentChainId, string> = {
  1: "Ethereum",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  11155111: "Sepolia",
  421614: "Arbitrum Sepolia",
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
  42161: 3,       // Arbitrum One — sequencer soft finality, same model as Base/OP
  11155111: 3,    // Sepolia
  421614: 3,      // Arbitrum Sepolia — testnet, same bar as L2 mainnets
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
  /** Optional short sub-heading shown below the title (one-line tagline). */
  tagline?: string;
  description: string;
  imageHash: Hex64;
  startDate: string;
  endDate: string;
  location: string;
  creatorAddress: Hex0x;
  creatorPodKey: string;
  /** The creator's v2 ISSUING address (0x + 40 lowercase hex) — the identity
   *  every series manifest is signed under. Stamped server-side at create from
   *  the VERIFIED issuer binding (PoP-checked), so this copy is a discovery
   *  mirror of a checked fact — but verification never trusts it: doors and
   *  gates re-resolve the issuer from the manifest digest every time. Absent
   *  on pre-5a events. */
  issuer?: string;
  series: SeriesSummary[];
  createdAt: string;
  /** Discovery facet tags (genre/…). Creator-signed content is the truth home;
   *  the directory snapshot copies + normalises these into each card. Editable
   *  post-publish via update-meta (re-signs the SOC — gas-free; not on-chain). */
  tags?: EventTag[];
  /** Structured, coordinate-anchored location (country/city/venue/lat-lng). The
   *  discovery-filter home for location (the free-text `location` above stays as
   *  the display line). Copied + normalised into each snapshot card. */
  geo?: EventGeo;
  /** Organizer's X25519 public key for order encryption (hex, no 0x prefix) */
  encryptionKey?: string;
  /** Order form fields — present when organizer collects customer info */
  orderFields?: OrderField[];
  /** How attendees can claim tickets (default: "wallet") */
  claimMode?: "wallet" | "email" | "both";
  /** Sub-ENS label pointed at this event's page (display hint — ownership and
   *  contenthash are authoritative on-chain; stamped via /api/sub-ens/stamp-event). */
  subEnsLabel?: string;
  /** Phase B (client-owned feeds): the organiser's content-feed-signer address
   *  (lowercased, 0x) that OWNS this event's detail-feed SOC. Self-describing copy;
   *  the authoritative discovery carrier is the directory entry's same field. Absent
   *  for legacy platform-signed events. */
  creatorFeedSigner?: Hex0x;
  /** The event's storage gateway (self-describing). Etherna ⇒ the event's content
   *  AND its client-owned detail-feed SOC live on the organiser's Etherna batch;
   *  absent/WoCo ⇒ the WoCo bee. Stamped at create time from the builder's choice so
   *  the edit/delete rail can restamp the SOC + re-upload images on the SAME batch
   *  without re-deriving it. The global directory always stays on WoCo regardless. */
  gatewayUrl?: string;
  /** Tombstone (delete-if-no-orders). Feeds can't be erased from Swarm, so a
   *  deleted event's feed is overwritten with this flag set; every read path
   *  treats it as not-found. Only settable when zero tickets exist. */
  deleted?: boolean;
  deletedAt?: string;
}

/** Ticket series summary (stored within event feed) */
export interface SeriesSummary {
  seriesId: string;
  name: string;
  description: string;
  totalSupply: number;
  price: number;
  /** Sales phase label e.g. "Early Bird", "General Release" */
  wave?: string;
  /** ISO datetime when this series opens for claims (server-enforced) */
  saleStart?: string;
  /** ISO datetime when this series closes for claims (server-enforced) */
  saleEnd?: string;
  /** Crypto payment config — absent means free event */
  payment?: PaymentConfig;
  // v2 on-chain fields (added after registerEvent tx is confirmed)
  /** On-chain eventId (0x-prefixed bytes32) from WoCoEvent.registerEvent */
  onChainEventId?: string;
  /** keccak256(dagCbor(manifestBody)) stored on-chain as manifestRef */
  manifestRef?: string;
  /** Swarm ref to SeriesManifestBlob (SignedManifestV2 + podRefs array) */
  swarmManifestRef?: Hex64;
  /** POD-holdings gate — when set, the claim route requires the claimer's wallet
   *  to hold the gating POD on-chain. May be a single PodGate (legacy) or a
   *  PodGateGroup (multi-POD any/all). Use normalizeGate() to upcast. */
  gate?: PodGate | PodGateGroup;
}

/**
 * Swarm blob stored at SeriesSummary.swarmManifestRef.
 * One fetch gives the door scanner (or server) everything needed for
 * offline verification: the signed manifest + the edition-body Swarm refs.
 *
 * `v: 2` versions the BLOB shape, which is unchanged; the manifest inside
 * self-describes via its `format` and is `woco.manifest.v2` since PR 5a.
 * Readers must treat `signedManifest` as untrusted bytes: closed-schema
 * validation (`validateSignedManifestV2` / `resolveCertIssuer`) is what turns
 * it into a type, and a legacy `woco.manifest.v1` object fails that dispatch —
 * the v1 cutoff, enforced structurally.
 */
export interface SeriesManifestBlob {
  v: 2;
  signedManifest: SignedManifestV2;
  /** Swarm refs to individual edition body JSON blobs, indexed by edition-1 (0-based). */
  podRefs: Hex64[];
  /** keccak256(dagCbor(manifestBody)), 0x-prefixed bytes32 — matches on-chain manifestRef. */
  manifestDigestHex: string;
}

/**
 * Request body for POST /api/events (v3 — issuer-curve migration PR 4).
 *
 * What changed from the retired v2 request shape, and only this:
 *  - each series carries a `woco.manifest.v2` signed by the derived secp256k1
 *    ISSUING key, and `editionBodies` (`woco.edition.v1`) replace `podBodies`;
 *  - `issuerBinding` — the issuing key's proof of possession over the parent
 *    (see {@link IssuerBindingV1}). The server pins `parent → issuer` on the
 *    event record at create, atomically with first issuance (PR 5a), and must
 *    verify: recovered PoP signer == `issuerBinding.issuer` == every series
 *    manifest's `body.issuer`.
 *
 * Since PR 5a this is the shape BOTH sides speak — the v2 request type is
 * deleted and the server verifies v2 and refuses v1. The deploy freeze that
 * covered the PR 4→5a seam lifts when 5a merges (server + frontend deploy
 * together; see HANDOVER-pod-curve-migration.md).
 */
export interface CreateEventV3Request {
  event: {
    title: string;
    /** Optional short sub-heading shown below the title (one-line tagline). */
    tagline?: string;
    description: string;
    startDate: string;
    endDate: string;
    location: string;
    /** Discovery facet tags (genre/…) — stamped into the signed EventFeed. */
    tags?: EventTag[];
    /** Structured location (country/city/venue/lat-lng) — stamped into the signed
     *  EventFeed. Populate via a client-side open geocoder at create time. */
    geo?: EventGeo;
  };
  series: Array<{
    seriesId: string;
    name: string;
    description: string;
    totalSupply: number;
    /** Client-built, personal-signed by the creator's derived issuing key. */
    signedManifest: SignedManifestV2;
    /** The edition bodies committed by the manifest's Merkle root, edition order. */
    editionBodies: EditionV1Body[];
    wave?: string;
    saleStart?: string;
    saleEnd?: string;
    payment?: PaymentConfig;
    /** POD-holdings gate for this series (server-enforced at claim). */
    gate?: PodGate | PodGateGroup;
  }>;
  image: string;
  creatorAddress: Hex0x;
  creatorPodKey: string;
  /** Proof of possession binding the issuing key to the (server-verified)
   *  parent — see {@link IssuerBindingV1} for what the server must check. */
  issuerBinding: IssuerBindingV1;
  encryptionKey?: string;
  orderFields?: OrderField[];
  claimMode?: ClaimMode;
  skipAutoList?: boolean;
  creatorFeedSigner?: Hex0x;
  gatewayUrl?: string;
}

/** Entry in the global event directory feed */
export interface EventDirectoryEntry {
  eventId: string;
  title: string;
  /** Optional short sub-heading shown below the title (one-line tagline). */
  tagline?: string;
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
  /** Phase B discovery carrier: the organiser's content-feed-signer address
   *  (lowercased 0x) that OWNS the event's detail-feed SOC. A reader who sees this
   *  entry can resolve the event SOC with no global registry. Absent for legacy
   *  platform-signed events. */
  creatorFeedSigner?: Hex0x;
}

/** Body of POST /api/events/:id/update-meta — edits event-LEVEL metadata only.
 *  Series data (supply, names, prices) is committed by the signed manifest whose
 *  digest is anchored on-chain, and is deliberately NOT editable here. */
export interface UpdateEventMetaRequest {
  title?: string;
  /** Empty string clears the tagline. */
  tagline?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  /** Replacement image as base64 / data-URL; the server uploads + whitelists it. */
  image?: string;
  /** Replacement discovery tags. Present (even empty) ⇒ overwrite the event's tags;
   *  absent ⇒ leave unchanged. Re-signs the SOC (gas-free) + triggers a snapshot rebuild. */
  tags?: EventTag[];
  /** Replacement structured location. Present ⇒ overwrite (empty object clears);
   *  absent ⇒ leave unchanged. Re-signs the SOC + triggers a snapshot rebuild. */
  geo?: EventGeo;
  /** The event's storage gateway — routes the replacement-image stamp to the same
   *  batch the event content lives on (Etherna user batch vs WoCo). */
  gatewayUrl?: string;
  /** Phase B carrier hint so UNLISTED client-owned events resolve. UNTRUSTED:
   *  the server uses it for a non-caching read only — never to authorise. */
  signer?: string;
}

/** Response from POST /api/events */
export interface CreateEventResponse {
  ok: boolean;
  eventId?: string;
  error?: string;
  /** Phase B: the client-owned event feed. Free publish: already signed as the
   *  version-0 SOC. Paid publish (deferFeedSign): UNSIGNED — the publish flow
   *  merges onChainEventId after registration and signs version 0 once. */
  eventFeed?: EventFeed;
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** A claimed ticket (original ticket data + claim metadata).
 *  v2 = issued-to-identity: `owner` is set at claim time. v1 = bearer; `owner`
 *  may be stamped retroactively via the attendee gate (the gate binding store
 *  is the record). Ownership that is ENFORCED lives on chain (`slotOwner`) —
 *  this object is the display record. */
export interface ClaimedTicket {
  podType: "woco.ticket.claimed.v1" | "woco.ticket.claimed.v2";
  eventId: string;
  seriesId: string;
  seriesName: string;
  edition: number;
  totalSupply: number;
  imageHash: string;
  creator: string;
  mintedAt: string;
  /** Attendee ed25519 POD public key — the owner-of-record. Set at claim time
   *  (v2) or stamped retroactively by the attendee gate (v1). */
  owner?: string;
  /** LEGACY (pre-2026-08-01) — raw wallet address. Ticket blobs are publicly
   *  reachable via the claims feed, so new tickets carry ownerAddressHash
   *  instead. Readers must accept both. */
  ownerAddress?: Hex0x;
  /** HMAC-SHA256 hash of the claiming wallet address (wallet-based claims).
   *  Replaces ownerAddress so the public ticket blob does not link a wallet
   *  to event attendance. */
  ownerAddressHash?: string;
  /** HMAC-SHA256 hash of email.
   *  - Email-only claim: primary identifier.
   *  - Wallet + Stripe dual-identity: secondary identifier (email from Stripe,
   *    wallet from verified session). Both are valid claim handles. */
  ownerEmailHash?: string;
  claimedAt: string;
  originalPodHash: string;
  originalSignature: string;
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
}

/** Payment method used to obtain a ticket. */
export type ClaimVia = "stripe" | "crypto" | "free";

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
