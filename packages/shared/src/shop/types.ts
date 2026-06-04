/**
 * WoCo Shop — catalog, order, and loyalty schema.
 *
 * One catalog, two front-ends (customer web shop + staff POS). Mirrors the
 * event/series model: `PaymentConfig` rails are reused, money is decimal
 * strings (never floats — fiat/USDC amounts must round-trip exactly),
 * addresses are lowercase for deterministic feed topics, ids are ULIDs.
 *
 * Spend money is USDC surfaced as fiat; there is no separate points token.
 * Loyalty is POD badges issued at milestones, with progress derived from
 * on-chain spend — see `docs/WOCO_SHOP_PLAN.md`.
 */

import type { Hex64, Hex0x } from "../types.js";
import type { PaymentConfig, FiatCurrency, PaymentChainId } from "../event/types.js";
import type { PodGate } from "../pod/types.js";

// ---------------------------------------------------------------------------
// Shop + catalog
// ---------------------------------------------------------------------------

/**
 * Who bears the platform fee on a shop's sales.
 * - "absorb" (default): the merchant absorbs the WoCo fee out of their revenue.
 * - "pass": the fee is surfaced to the customer as a transparent WoCo *service*
 *   fee (a later UI toggle). NOTE: passing raw *card-processing* costs to
 *   consumers is banned in the UK/EU — "pass" may only ever show a WoCo service
 *   fee, never a Stripe-cost surcharge.
 */
export type FeeMode = "absorb" | "pass";

/**
 * Shop-wide payment rails. Price lives per-product, so the shared
 * `PaymentConfig` is reused minus its per-item price/currency — the merchant
 * has one recipient and one set of accepted rails for the whole catalog.
 */
export type ShopPaymentConfig = Omit<PaymentConfig, "price" | "currency"> & {
  /** Fee bearer. Defaults to "absorb" when omitted. */
  feeMode?: FeeMode;
};

/**
 * Platform crypto (USDC) fee configuration. A struct rather than a bare number
 * so the model can ratchet toward a flat micro-fee as volume grows without a
 * schema change. Card uses the fixed `PLATFORM_FEE_BP` (1.5%); crypto is
 * operationally lighter and starts at 0.25%.
 *
 * NOT collected on the launch online direct-transfer rail: a single ERC-20
 * transfer can't split merchant/platform non-custodially, so the buyer pays the
 * FULL amount to the merchant and the split waits for the escrow/splitter/
 * aggregator path (which can divide funds in one tx without WoCo ever holding
 * them). The rate is recorded on the quote/order so that future path knows the
 * agreed terms. Server reads env overrides via `getCryptoFeeConfig()`.
 */
export interface CryptoFeeConfig {
  /** Basis points taken as the WoCo platform fee on crypto spend (25 = 0.25%). */
  bp: number;
  /** Optional flat micro-fee in fiat minor units added on top (future ratchet); 0 = none. */
  flatMinor: number;
}

/** Default crypto platform fee — 0.25%, no flat component. Env-overridable on the server. */
export const DEFAULT_CRYPTO_FEE_BP = 25;
export const DEFAULT_CRYPTO_FEE: CryptoFeeConfig = { bp: DEFAULT_CRYPTO_FEE_BP, flatMinor: 0 };

/**
 * Sales channel a product is offered on. Omit on a product = all channels.
 * Lets a merchant tie the same catalog to the customer web shop and/or the
 * staff POS (e.g. a kitchen-only item hidden from the web menu).
 */
export type SalesChannel = "web" | "pos";

/** A grouping in the menu (e.g. "Drinks", "Vinyl", "Merch"). */
export interface ProductCategory {
  /** Stable slug/ULID — survives renames, used as the product's categoryId. */
  id: string;
  label: string;
  /** Display order; lower first. */
  sortIndex: number;
}

/**
 * Flat variant of a product (size, format). Phase 1 is flat only — modifiers
 * that change preparation are the deferred fast-food path.
 */
export interface ProductVariant {
  variantId: string;
  /** "Large", "Pint", "Red / XL". */
  label: string;
  /** Decimal string added to the base price; "0.00" or negative permitted. */
  priceDelta: string;
  /** Finite stock for this variant; omit to inherit the product's stock semantics. */
  stock?: number;
  /** Stock-keeping unit for reconciliation / POS lookup. */
  sku?: string;
}

/**
 * A sellable item. Finite-stock items (limited vinyl, capped merch) reuse the
 * event reservation→claim flow; omitting `stock` means unlimited (a pint).
 */
export interface Product {
  productId: string;
  shopId: string;
  name: string;
  description?: string;
  /** Primary image. */
  imageRef?: Hex64;
  /** Additional gallery images shown after the primary. */
  imageRefs?: Hex64[];
  /** Decimal string in the shop's fiat currency (e.g. "4.50"). */
  price: string;
  /** Original price for sale display (struck through). Decimal string; omit = not on sale. */
  compareAtPrice?: string;
  /** Stock-keeping unit for reconciliation / POS lookup. */
  sku?: string;
  categoryId?: string;
  variants?: ProductVariant[];
  /** Finite stock count. Omit = unlimited. Finite reuses reservation→claim. */
  stock?: number;
  /** Channels this product is sold on. Omit = all channels (web + pos). */
  channels?: SalesChannel[];
  /** Loyalty badges awarded when this specific item is bought. */
  podRewards?: PodRewardRule[];
  /** POD-holdings gate — when set, the buyer's wallet must hold the gating POD
   *  on-chain. Enforced at every payment rail that binds a wallet (crypto +
   *  spend-permission); the card rail cannot satisfy a wallet gate, so gated
   *  products are wallet-purchase-only. The stored gate is chain-validated at
   *  write time (manifestRef↔eventId), so enforcement trusts it. */
  gate?: PodGate;
  active: boolean;
  /** Display order within its category. */
  sortIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** Top-level shop config stored at `woco/shop/config/{shopId}`. */
export interface Shop {
  v: 1;
  shopId: string;
  /** Lowercase — authoritative merchant identity, stamped server-side from the
   *  verified parentAddress (same trust model as events/sites). */
  ownerAddress: Hex0x;
  name: string;
  description?: string;
  logoRef?: Hex64;
  /** Display currency. USDC is what actually settles on the crypto rail. */
  currency: FiatCurrency;
  categories: ProductCategory[];
  payment: ShopPaymentConfig;
  loyalty?: LoyaltyConfig;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus =
  | "pending"     // created, awaiting payment
  | "paid"        // payment verified, not yet handed over
  | "fulfilled"   // handed to customer
  | "cancelled"   // voided before payment / settlement
  | "refunded";   // paid then refunded

/**
 * How an order was paid. "crypto" = human wallet (per-order tx or POS
 * spend-permission draw); "x402" = agentic/machine purchase via the HTTP 402
 * handshake (also USDC on-chain, so it accrues loyalty like any crypto spend).
 */
export type PaymentRail = "card" | "crypto" | "x402";

/** A line in an order — catalog values are snapshotted so later edits don't mutate history. */
export interface OrderLine {
  productId: string;
  variantId?: string;
  /** Name snapshot at order time. */
  name: string;
  qty: number;
  /** Decimal string — base + variant delta, snapshotted at order time. */
  unitPrice: string;
}

/**
 * Payment attached to an order.
 *
 * Card → Stripe session. Online crypto → the existing signed-quote tx flow
 * (txHash + chainId). Festival POS tap-and-go → a draw against a
 * `SpendPermission`; `spendPermissionId` references the authorisation and
 * `settlementTxHash` is the on-chain pull once settled. The full
 * spend-permission surface is finalised in build step 2.
 */
export interface OrderPayment {
  rail: PaymentRail;
  /** Card. */
  stripeSessionId?: string;
  /** Online crypto (per-order). */
  txHash?: string;
  chainId?: PaymentChainId;
  /** POS spend-permission draw. */
  spendPermissionId?: string;
  /** On-chain tx of the pull, once settled (may lag the order in offline capture). */
  settlementTxHash?: string;
  /** Agentic x402 payment header value (rail "x402"). Settles USDC on-chain. */
  x402Header?: string;
  /** Crypto platform fee bps agreed at quote time. Recorded for the future
   *  non-custodial split; NOT deducted at launch (buyer paid full to merchant). */
  cryptoFeeBp?: number;
}

/** An order stored in `woco/shop/{shopId}/orders`. */
export interface Order {
  v: 1;
  orderId: string;
  shopId: string;
  /** Short human-readable pickup code (e.g. "K4P-92"). Unique within shop per day. */
  code: string;
  lines: OrderLine[];
  /** Decimal string sum in the shop currency. */
  total: string;
  currency: FiatCurrency;
  rail: PaymentRail;
  status: OrderStatus;
  payment?: OrderPayment;
  /** Buyer wallet (lowercase) or hashed email — mirrors claim-privacy handling. */
  buyerRef?: string;
  /** POS operator who entered the order (staff wallet), when staff-assembled. */
  operatorRef?: Hex0x;
  createdAt: string;
  fulfilledAt?: string;
}

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------

/** A POD badge awarded when a specific product is purchased. */
export interface PodRewardRule {
  /** ULID of the badge template to issue. */
  badgeId: string;
  trigger: "purchase";
}

/** A POD badge awarded at a cumulative-spend milestone for the shop. */
export interface SpendThresholdReward {
  /** Cumulative spend (decimal string, shop currency) at which the badge issues. */
  threshold: string;
  badgeId: string;
}

/**
 * Loyalty configuration. Progress toward milestones is NOT stored here — it is
 * derived from on-chain USDC spend (and server-attested card spend) via the
 * Stylus aggregator. This config only declares the badge rules.
 */
export interface LoyaltyConfig {
  enabled: boolean;
  spendThresholds?: SpendThresholdReward[];
}

// ---------------------------------------------------------------------------
// Directory (merchant's own shops — mirrors SiteDirectoryEntry)
// ---------------------------------------------------------------------------

/** Compact entry in a merchant's shop directory. */
export interface ShopDirectoryEntry {
  shopId: string;
  name: string;
  logoRef?: Hex64;
  ownerAddress: Hex0x;
  productCount: number;
  currency: FiatCurrency;
  createdAt: string;
  updatedAt: string;
  /** Live URL once the hosting site is deployed. */
  deployedUrl?: string;
}

/** Paged on-feed directory of a merchant's shops at `woco/shop/creator/{ethAddress}`. */
export interface ShopDirectory {
  v: 1;
  owner: Hex0x;
  shops: ShopDirectoryEntry[];
  updatedAt: string;
  /** Number of overflow pages (1..N) beyond page 0. Page 0 only. */
  pages?: number;
}

/** Paged catalog envelope at `woco/shop/{shopId}/products[/pN]`. */
export interface ProductsIndex {
  v: 1;
  shopId: string;
  products: Product[];
  updatedAt: string;
  /** Number of overflow pages (1..N) beyond page 0. Page 0 only. */
  pages?: number;
}

/** Paged order log at `woco/shop/{shopId}/orders[/pN]` — newest first. */
export interface OrdersLog {
  v: 1;
  shopId: string;
  orders: Order[];
  updatedAt: string;
  /** Number of overflow pages (1..N) beyond page 0. Page 0 only. */
  pages?: number;
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

/** POST /api/shops — owner stamped server-side from verified parentAddress. */
export interface CreateShopRequest {
  name: string;
  description?: string;
  logoRef?: Hex64;
  currency: FiatCurrency;
  categories?: ProductCategory[];
  payment: ShopPaymentConfig;
  loyalty?: LoyaltyConfig;
}

/** PATCH /api/shops/:shopId — partial update of shop config. */
export type UpdateShopRequest = Partial<Omit<CreateShopRequest, "currency">>;

/** POST/PUT /api/shops/:shopId/products — create or replace a product. */
export interface UpsertProductRequest {
  productId?: string;
  name: string;
  description?: string;
  imageRef?: Hex64;
  imageRefs?: Hex64[];
  price: string;
  compareAtPrice?: string;
  sku?: string;
  categoryId?: string;
  variants?: ProductVariant[];
  stock?: number;
  channels?: SalesChannel[];
  podRewards?: PodRewardRule[];
  /** POD-holdings gate (wallet-purchase-only when set). Chain-validated server-side. */
  gate?: PodGate;
  active?: boolean;
  sortIndex?: number;
}

/** A requested line before pricing/snapshotting (client → server). */
export interface OrderLineRequest {
  productId: string;
  variantId?: string;
  qty: number;
}

/**
 * POST /api/shops/:shopId/orders. The server prices the lines from the live
 * catalog (never trusts client-supplied prices), reserves finite stock, and
 * returns the priced Order with its pickup code. Payment is verified per rail
 * before the order moves to "paid".
 */
export interface CreateOrderRequest {
  lines: OrderLineRequest[];
  rail: PaymentRail;
  /** Optional buyer identity for non-wallet (email) orders; hashed server-side. */
  buyerEmail?: string;
}

// ---------------------------------------------------------------------------
// Crypto (USDC) online payment — signed quote + proof
// ---------------------------------------------------------------------------

/**
 * Server-issued, HMAC-signed commitment to the EXACT USDC amount an order must
 * be paid in. Mirrors the events `PaymentQuote` but is shop/order-scoped and
 * USDC-only. The client pays exactly `amountAtomic` to `recipient`; the server
 * verifies the on-chain transfer matches and that the quote signature, expiry,
 * and one-shot status all hold. Eliminates the client/server oracle race.
 *
 * `recipient` is the MERCHANT address (full amount, no split at launch — see
 * `CryptoFeeConfig`). The HMAC domain (`woco-shop-quote-v1`) is distinct from
 * the events quote so a quote issued for one surface can never be replayed on
 * the other, even though both use `PAYMENT_QUOTE_SECRET`.
 */
export interface ShopPaymentQuote {
  quoteId: string;
  shopId: string;
  orderId: string;
  chainId: PaymentChainId;
  /** Crypto rail is USDC-only for shops. */
  currency: "USDC";
  /** Merchant address (lowercased). Full amount lands here — no platform split at launch. */
  recipient: Hex0x;
  /** Exact amount in USDC's smallest unit (6-dec atomic). The on-chain transfer must match. */
  amountAtomic: string;
  /** Display total in the shop's fiat currency (what the buyer sees). */
  fiatTotal: string;
  fiatCurrency: FiatCurrency;
  /** Crypto platform fee bps in effect at quote time — recorded for the future
   *  non-custodial split; NOT deducted from `amountAtomic` at launch. */
  feeBp: number;
  /** Unix milliseconds. Quote rejected after this. */
  expiresAt: number;
  /** Optional payer binding (lowercased) — defense-in-depth alongside the EIP-712 binding. */
  boundTo?: string;
  /** HMAC-SHA256 hex over the canonical quote string. */
  sig: string;
}

/**
 * The buyer's EIP-712 `ShopPayment` binding (anonymous buyers only). Proves the
 * controller of `payer` authorised this exact order/quote — the anti-front-
 * running guard. Logged-in wallet buyers omit this; their session delegation is
 * the binding and the server uses the verified parentAddress as the payer.
 */
export interface ShopPaymentBinding {
  /** The paying wallet (lowercased). Server requires `tx.from === payer`. */
  payer: Hex0x;
  /** EIP-712 signature over SHOP_PAYMENT_DOMAIN / SHOP_PAYMENT_TYPES. */
  signature: string;
}

/**
 * Proof submitted to settle a crypto order. The full signed quote travels with
 * the proof so the server verifies statelessly (only the consumed-quoteId set
 * needs to persist).
 */
export interface ShopPaymentProof {
  /** On-chain tx hash of the USDC transfer. */
  txHash: string;
  /** Chain the payment was made on — must equal `quote.chainId`. */
  chainId: PaymentChainId;
  /** The server-signed quote being settled. */
  quote: ShopPaymentQuote;
  /** EIP-712 payer binding — required for anonymous buyers, omitted when session-authenticated. */
  binding?: ShopPaymentBinding;
}

/** POST /api/shops/:id/orders/:orderId/quote — request a signed USDC quote. */
export interface ShopQuoteRequest {
  chainId: PaymentChainId;
  /** Buyer's paying wallet (optional). When supplied, the quote is bound to it. */
  buyerAddress?: Hex0x;
}

// ---------------------------------------------------------------------------
// Crypto (USDC) spend-permission rail — POS tap-and-go (ZeroDev Kernel)
//
// The headline festival rail. At entry the attendee's Kernel smart account
// grants a capped, time-boxed permission to the venue's spender (a ZeroDev
// session key, ERC-7710-style delegation): "you may make MY Kernel `transfer`
// USDC, but ONLY to this merchant, ≤ a per-draw ceiling, only before validUntil,
// at most maxDraws times". Funds stay in the attendee's Kernel until drawn — the
// venue can never redirect them (call-policy `to` is pinned) and can never spend
// after the window. Each bar order = the venue's spender pulls the amount via a
// gasless userOp, no per-round wallet prompt.
//
// The clean cumulative "£X" cap is enforced SERVER-SIDE (the server is the sole
// spender and tracks `spentAtomic`). The on-chain policies are the trustless
// backstop even if the spender key leaks: merchant-only target, per-draw ceiling,
// window, bounded count. A future on-chain cumulative spending-limit hook is a
// drop-in upgrade with the same `transfer` call shape — see docs/WOCO_SHOP_PLAN.md.
// ---------------------------------------------------------------------------

/**
 * Server-dictated scope for a spend permission. The client MUST build its
 * ZeroDev approval embedding EXACTLY these on-chain constraints so the policy
 * the server later draws against matches what it issued. The attendee chooses
 * only their cumulative cap (`capAtomic`, server-tracked) on top of this.
 *
 * Returned by POST /api/shops/:id/spend-permission/grant-params.
 */
export interface SpendPermissionGrantParams {
  chainId: PaymentChainId;
  /** USDC token on `chainId` (6-dec). The call policy pins `target` to this. */
  usdcAddress: Hex0x;
  /** Merchant recipient (lowercased) — the ONLY address a draw may pay. */
  recipient: Hex0x;
  /** The venue spender the attendee authorizes. Today: the server's per-shop
   *  key; swappable to a POS-device / per-attendee delegate without a schema
   *  change (the approval just names a different address). */
  spenderAddress: Hex0x;
  /** Unix seconds — permission expiry (timestamp policy `validUntil`). */
  validUntil: number;
  /** Max single-draw amount, 6-dec atomic (call-policy `value` ceiling). */
  perDrawCeilingAtomic: string;
  /** Max number of draws in the window (rate-limit policy `count`). */
  maxDraws: number;
}

/**
 * POST /api/shops/:id/spend-permission — register a granted approval.
 * Auth-gated: the caller's verified parentAddress MUST equal `kernelAddress`
 * (you can only grant a permission on a Kernel you control — and the approval
 * blob is itself sudo-signed by that Kernel, validated on-chain at first draw).
 */
export interface RegisterSpendPermissionRequest {
  chainId: PaymentChainId;
  /** Attendee Kernel that granted (must equal the authenticated parentAddress). */
  kernelAddress: Hex0x;
  /** Cumulative cap, 6-dec atomic — the server-enforced drain ceiling. */
  capAtomic: string;
  validUntil: number;
  spenderAddress: Hex0x;
  perDrawCeilingAtomic: string;
  maxDraws: number;
  /**
   * Serialized ZeroDev permission approval (enable data only, NO private key).
   * The server stores this and combines it with its own spender key to draw.
   */
  approval: string;
}

/**
 * Public view of a registered spend permission. NEVER carries the `approval`
 * blob or any key material — only the budget state the attendee/merchant needs.
 */
export interface ShopSpendPermission {
  permissionId: string;
  shopId: string;
  kernelAddress: Hex0x;
  chainId: PaymentChainId;
  recipient: Hex0x;
  /** Cumulative cap (6-dec atomic). */
  capAtomic: string;
  /** Cumulative drawn so far (6-dec atomic). Remaining = cap − spent. */
  spentAtomic: string;
  validUntil: number;
  revoked: boolean;
  createdAt: string;
}

/**
 * POST /api/shops/:id/orders/:orderId/pay-spend-permission — settle an order
 * by drawing against a registered permission. Auth-gated to the shop owner (the
 * POS operator); the cap/window/target on-chain policies are the real guards.
 */
export interface PaySpendPermissionRequest {
  permissionId: string;
}

// ---------------------------------------------------------------------------
// Delegation scopes — agentic catalog management (RESERVED, not enforced yet)
//
// The write-side twin of x402 purchasing: an agent that adds stock / edits the
// catalog. Rather than handing an agent the owner's full session (which can
// create events, deploy sites, move funds…), the future flow issues a SCOPED
// capability — a ZeroDev-style session key authorised ONLY for `shop:manage` on
// a SINGLE shopId. This reserves the scope name + shape so the server's
// catalog-write seam and a later scoped-token verifier agree. Enforcement needs
// an authenticated `scope` field in the AuthorizeSession EIP-712 payload, which
// is a versioned SESSION_DOMAIN bump — deferred so live sessions don't break.
// See docs/WOCO_SHOP_PLAN.md §4b.
// ---------------------------------------------------------------------------

/** Reserved capability: manage one shop's catalog + config (NOT orders/funds). */
export const SHOP_MANAGE_SCOPE = "shop:manage" as const;
export type ShopDelegationScope = typeof SHOP_MANAGE_SCOPE;

/** A scoped grant binds a capability to exactly one shop. */
export interface ScopedShopCapability {
  scope: ShopDelegationScope;
  /** The single shop this capability may manage. */
  shopId: string;
}
