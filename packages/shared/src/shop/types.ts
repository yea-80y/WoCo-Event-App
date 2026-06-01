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

// ---------------------------------------------------------------------------
// Shop + catalog
// ---------------------------------------------------------------------------

/**
 * Shop-wide payment rails. Price lives per-product, so the shared
 * `PaymentConfig` is reused minus its per-item price/currency — the merchant
 * has one recipient and one set of accepted rails for the whole catalog.
 */
export type ShopPaymentConfig = Omit<PaymentConfig, "price" | "currency">;

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
  imageRef?: Hex64;
  /** Decimal string in the shop's fiat currency (e.g. "4.50"). */
  price: string;
  categoryId?: string;
  variants?: ProductVariant[];
  /** Finite stock count. Omit = unlimited. Finite reuses reservation→claim. */
  stock?: number;
  /** Loyalty badges awarded when this specific item is bought. */
  podRewards?: PodRewardRule[];
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
  price: string;
  categoryId?: string;
  variants?: ProductVariant[];
  stock?: number;
  podRewards?: PodRewardRule[];
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
