import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { parseUnits, formatUnits, verifyTypedData, type TypedDataField } from "ethers";
import type { AppEnv } from "../types.js";
import { requireAuth, tryVerifyAuth } from "../middleware/auth.js";
import {
  getShop,
  getShopStrict,
  writeShop,
  getProducts,
  upsertProduct,
  deleteProduct,
  getOrders,
  getOrder,
  appendOrder,
  updateOrder,
  genOrderCode,
  getCreatorShops,
  upsertCreatorShop,
} from "../lib/shop/service.js";
import { signShopQuote, verifyShopQuote, consumeShopQuote } from "../lib/shop/quote.js";
import { validatePodGate, checkProductGates, firstGatedProduct } from "../lib/pod/gate-check.js";
import { getCryptoFeeConfig } from "../lib/shop/fees.js";
import {
  grantParams,
  registerSpendPermission,
  drawSpendPermission,
  revokeSpendPermission,
  getSpendPermission,
  listSpendPermissionsByKernel,
} from "../lib/shop/spend-permission.js";
import { verifyPayment } from "../lib/payment/verify.js";
import { checkAndConsumeTxHash } from "../lib/payment/tx-registry.js";
import { fiatToUSD } from "../lib/payment/eth-price.js";
import { getStripe } from "../lib/stripe/client.js";
import { getStripeAccount } from "../lib/stripe/accounts.js";
import { validateReturnUrl, getFrontendUrl, canonicalSuccessUrl } from "../lib/stripe/return-url.js";
import {
  priceOrder,
  moneyToMinor,
  PLATFORM_FEE_BP,
  USDC_ADDRESSES,
  SHOP_PAYMENT_DOMAIN,
  SHOP_PAYMENT_TYPES,
} from "@woco/shared";
import type {
  Shop,
  Product,
  Order,
  CreateShopRequest,
  UpdateShopRequest,
  UpsertProductRequest,
  CreateOrderRequest,
  ShopDirectoryEntry,
  OrderStatus,
  PaymentChainId,
  Hex0x,
  ShopQuoteRequest,
  ShopPaymentProof,
  RegisterSpendPermissionRequest,
  PaySpendPermissionRequest,
} from "@woco/shared";

const shopsRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Rate limiter — public order creation writes to Swarm (postage cost); bound
// floods per IP. Mirrors the contact-form / email-claim limiters.
// ---------------------------------------------------------------------------

const orderRateMap = new Map<string, number[]>();
const ORDER_RATE_LIMIT = 20;
const ORDER_RATE_WINDOW = 60_000;

// Quote + crypto-settle limiter — these hit the fiat oracle / chain RPC rather
// than Swarm, but are still public; bound floods independently of order writes.
const payRateMap = new Map<string, number[]>();
const PAY_RATE_LIMIT = 30;
const PAY_RATE_WINDOW = 60_000;

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Sliding-window rate check. Returns true when the caller is over the limit. */
function rateLimited(map: Map<string, number[]>, ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (map.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    map.set(ip, hits);
    return true;
  }
  hits.push(now);
  map.set(ip, hits);
  return false;
}

// Status transitions an owner may apply from the dashboard / POS.
const OWNER_SETTABLE_STATUS: ReadonlySet<OrderStatus> = new Set([
  "fulfilled",
  "cancelled",
]);

/**
 * Catalog-write authorization seam — the `shop:manage` scope hook (2e, RESERVED;
 * not enforced yet). Today every catalog/config write requires the verified shop
 * OWNER (parentAddress === ownerAddress). The future agentic-inventory path (the
 * write-side twin of x402) issues a SCOPED capability — a ZeroDev-style session
 * key authorised ONLY for `shop:manage` on a single shopId — so an agent never
 * wields the owner's full session. When that lands, the scope check slots in HERE
 * (one site): `return owner(...) || hasShopManageScope(c, shopId)`. Enforcing it
 * needs an authenticated `scope` in the AuthorizeSession EIP-712 payload, a
 * versioned SESSION_DOMAIN bump deferred so live sessions don't break. The scope
 * name/shape are reserved in @woco/shared (SHOP_MANAGE_SCOPE / ScopedShopCapability).
 * NOTE: this seam covers catalog + shop config only — order fulfilment / funds
 * stay owner-only (a separate, narrower capability if ever delegated).
 */
function canManageShop(ownerAddress: string, parentAddress: string, _shopId: string): boolean {
  return ownerAddress.toLowerCase() === parentAddress.toLowerCase();
}

// In-flight settlement lock per order — a spend-permission draw moves real funds,
// so two concurrent settlements of the SAME order must never both draw. The
// per-permission mutex serialises the draws themselves; this guards the
// read-status → draw → flip sequence at the order level.
const settlingOrders = new Set<string>();

// ---------------------------------------------------------------------------
// POST /api/shops — create or update a shop (owner stamped server-side)
// ---------------------------------------------------------------------------

shopsRouter.post("/", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const body = (await c.req.json()) as CreateShopRequest & { shopId?: string };
    if (!body?.name || !body?.currency || !body?.payment) {
      return c.json({ ok: false, error: "name, currency and payment are required" }, 400);
    }

    const now = new Date().toISOString();
    let createdAt = now;
    const shopId = body.shopId ?? randomUUID();

    // On update, only the owner may overwrite. Strict read: a transient Swarm
    // failure must not be read as "new shop" and skip the ownership check.
    if (body.shopId) {
      const res = await getShopStrict(body.shopId);
      if (res.status === "error") {
        return c.json({ ok: false, error: "Read failed — refusing to write" }, 503);
      }
      if (res.status === "present") {
        if (!canManageShop(res.shop.ownerAddress, parentAddress, shopId)) {
          return c.json({ ok: false, error: "Not the shop owner" }, 403);
        }
        createdAt = res.shop.createdAt;
      }
    }

    const shop: Shop = {
      v: 1,
      shopId,
      ownerAddress: parentAddress as Shop["ownerAddress"],
      name: body.name,
      description: body.description,
      logoRef: body.logoRef,
      currency: body.currency,
      categories: body.categories ?? [],
      payment: body.payment,
      loyalty: body.loyalty,
      createdAt,
      updatedAt: now,
    };
    await writeShop(shop);

    // Directory upsert is fire-and-forget (non-fatal — the shop itself is written).
    const products = await getProducts(shopId).catch(() => []);
    upsertCreatorShop(parentAddress, {
      shopId,
      name: shop.name,
      logoRef: shop.logoRef,
      ownerAddress: shop.ownerAddress,
      productCount: products.length,
      currency: shop.currency,
      createdAt,
      updatedAt: now,
    } satisfies ShopDirectoryEntry).catch((e) =>
      console.warn("[shops] creator directory upsert failed:", e),
    );

    return c.json({ ok: true, data: { shopId } });
  } catch (err) {
    console.error("[shops/create]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Create failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/mine — merchant's own shops. MUST precede /:id.
// ---------------------------------------------------------------------------

shopsRouter.get("/mine", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    const shops = await getCreatorShops(parentAddress);
    return c.json({ ok: true, data: shops });
  } catch {
    return c.json({ ok: false, error: "Failed to read shop directory" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/spend-permissions/mine — the attendee's own spend permissions
// (their "spending wallet"). MUST precede /:id. Filtered by the authed Kernel.
// ---------------------------------------------------------------------------

shopsRouter.get("/spend-permissions/mine", requireAuth, (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  try {
    return c.json({ ok: true, data: listSpendPermissionsByKernel(parentAddress) });
  } catch {
    return c.json({ ok: false, error: "Failed to read spend permissions" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/:id — public shop config
// ---------------------------------------------------------------------------

shopsRouter.get("/:id", async (c) => {
  try {
    const shop = await getShop(c.req.param("id"));
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    return c.json({ ok: true, data: shop });
  } catch {
    return c.json({ ok: false, error: "Failed to read shop" }, 500);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/shops/:id — partial update of shop config (owner)
// ---------------------------------------------------------------------------

shopsRouter.patch("/:id", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const existing = await getShop(shopId);
    if (!existing) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (!canManageShop(existing.ownerAddress, parentAddress, shopId)) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const patch = (await c.req.json()) as UpdateShopRequest;
    const updated: Shop = {
      ...existing,
      ...patch,
      // Identity fields are not client-mutable.
      shopId,
      ownerAddress: existing.ownerAddress,
      currency: existing.currency,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writeShop(updated);
    return c.json({ ok: true, data: updated });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Update failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/:id/products — public catalog
// ---------------------------------------------------------------------------

shopsRouter.get("/:id/products", async (c) => {
  try {
    const products = await getProducts(c.req.param("id"));
    return c.json({ ok: true, data: products });
  } catch {
    return c.json({ ok: false, error: "Failed to read catalog" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/products — create or replace a product (owner)
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/products", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (!canManageShop(shop.ownerAddress, parentAddress, shopId)) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const body = (await c.req.json()) as UpsertProductRequest;
    if (!body?.name || typeof body.price !== "string") {
      return c.json({ ok: false, error: "name and price are required" }, 400);
    }

    // Chain-validate the gate at the write boundary (manifestRef↔eventId), so
    // enforcement at payment can trust the stored gate. Reject an invalid gate
    // rather than silently persisting an unenforceable / wrong-POD one.
    if (body.gate) {
      const v = await validatePodGate(body.gate);
      if (!v.ok) return c.json({ ok: false, error: `Invalid POD gate: ${v.error}` }, 400);
    }

    const now = new Date().toISOString();
    const productId = body.productId ?? randomUUID();
    const prior = body.productId
      ? (await getProducts(shopId)).find((p) => p.productId === body.productId)
      : undefined;

    const product: Product = {
      productId,
      shopId,
      name: body.name,
      description: body.description,
      imageRef: body.imageRef,
      imageRefs: body.imageRefs,
      price: body.price,
      compareAtPrice: body.compareAtPrice,
      sku: body.sku,
      categoryId: body.categoryId,
      variants: body.variants,
      stock: body.stock,
      channels: body.channels,
      podRewards: body.podRewards,
      ...(body.gate ? { gate: body.gate } : {}),
      active: body.active ?? true,
      sortIndex: body.sortIndex ?? prior?.sortIndex ?? 0,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    const products = await upsertProduct(shopId, product);
    return c.json({ ok: true, data: { product, products } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Save failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/shops/:id/products/:productId (owner)
// ---------------------------------------------------------------------------

shopsRouter.delete("/:id/products/:productId", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (!canManageShop(shop.ownerAddress, parentAddress, shopId)) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const products = await deleteProduct(shopId, c.req.param("productId"));
    return c.json({ ok: true, data: { products } });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Delete failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/shops/:id/orders — order log (owner only — sensitive)
// ---------------------------------------------------------------------------

shopsRouter.get("/:id/orders", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (shop.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const orders = await getOrders(shopId);
    return c.json({ ok: true, data: orders });
  } catch {
    return c.json({ ok: false, error: "Failed to read orders" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/orders — place an order. Public + rate-limited.
// Server prices every line from the live catalog (never trusts client prices)
// and returns the order with its pickup code. Payment verification is wired in
// build step 2 — orders are created "pending" until then.
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/orders", async (c) => {
  const ip = clientIp(c);
  const now = Date.now();
  const hits = (orderRateMap.get(ip) ?? []).filter((t) => now - t < ORDER_RATE_WINDOW);
  if (hits.length >= ORDER_RATE_LIMIT) {
    return c.json({ ok: false, error: "Too many requests. Please wait before trying again." }, 429);
  }
  hits.push(now);
  orderRateMap.set(ip, hits);

  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);

    const body = (await c.req.json()) as CreateOrderRequest;
    const products = await getProducts(shopId);
    const { lines, total } = priceOrder(products, body.lines);

    const order: Order = {
      v: 1,
      orderId: randomUUID(),
      shopId,
      code: genOrderCode(),
      lines,
      total,
      currency: shop.currency,
      rail: body.rail,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await appendOrder(shopId, order);
    return c.json({ ok: true, data: order });
  } catch (err) {
    // Pricing/validation errors are client faults (bad product, qty, variant).
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Order failed" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/orders/:orderId/checkout — Stripe card checkout.
// Public (buyers may be email-only). Direct charge on the merchant's connected
// account; the platform collects PLATFORM_FEE_BP as application_fee. The webhook
// (POST /api/stripe/webhook) flips the order pending→paid on confirmation.
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/orders/:orderId/checkout", async (c) => {
  const shopId = c.req.param("id");
  const orderId = c.req.param("orderId");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);

    const order = await getOrder(shopId, orderId);
    if (!order) return c.json({ ok: false, error: "Order not found" }, 404);
    if (order.status !== "pending") {
      return c.json({ ok: false, error: "Order is not awaiting payment" }, 409);
    }
    if (!shop.payment.stripeEnabled) {
      return c.json({ ok: false, error: "Card payments are not enabled for this shop" }, 400);
    }

    // POD gate is a WALLET-holdings check — a card buyer has no wallet, so a
    // gated product is unsatisfiable by card. Reject BEFORE creating the Stripe
    // session (no charge), steering the buyer to the crypto/USDC rail.
    const gateProducts = await getProducts(shopId);
    const gatedName = firstGatedProduct(gateProducts, order.lines);
    if (gatedName) {
      return c.json(
        { ok: false, gated: true, error: `"${gatedName}" requires holding a POD in your wallet — pay with crypto/USDC instead of card.` },
        403,
      );
    }

    const merchant = getStripeAccount(shop.ownerAddress.toLowerCase());
    if (!merchant?.onboardingComplete) {
      return c.json({ ok: false, error: "Shop owner has not completed Stripe onboarding" }, 400);
    }

    const amountMinor = moneyToMinor(order.total);
    if (amountMinor <= 0) return c.json({ ok: false, error: "Order total must be positive" }, 400);
    const currency = order.currency.toLowerCase();
    // Platform fee taken from the merchant's cut (standard retail). Buyer pays
    // exactly the priced total; merchant absorbs Stripe + platform fee.
    const applicationFee = Math.round((amountMinor * PLATFORM_FEE_BP) / 10_000);

    const body = (await c.req.json().catch(() => ({}))) as { returnUrl?: string; cancelUrl?: string };
    const frontendUrl = canonicalSuccessUrl(validateReturnUrl(body.returnUrl) ?? getFrontendUrl(c));
    const successUrl = `${frontendUrl}/#/shop/${shopId}/order/${order.code}?stripe=success&session_id={CHECKOUT_SESSION_ID}`;
    // Validate cancelUrl against ALLOWED_HOSTS (same guard as returnUrl) rather
    // than accepting any https host — avoids an open redirect on Stripe's cancel
    // bounce. Falls back to the canonical app when not allowlisted. (A deployed
    // shop's own ENS host can be allowlisted explicitly in step 3 if needed.)
    const validatedCancel = validateReturnUrl(body.cancelUrl);
    const cancelUrl = validatedCancel
      ? `${validatedCancel}${validatedCancel.includes("?") ? "&" : "?"}stripe=cancelled`
      : `${frontendUrl}/#/shop/${shopId}?stripe=cancelled`;

    const s = getStripe();
    const session = await s.checkout.sessions.create(
      {
        mode: "payment",
        line_items: order.lines.map((l) => ({
          price_data: {
            currency,
            product_data: { name: l.name },
            unit_amount: moneyToMinor(l.unitPrice),
          },
          quantity: l.qty,
        })),
        payment_intent_data: {
          application_fee_amount: applicationFee,
          // No transfer_data — direct charge settles on the connected account.
        },
        metadata: {
          shopId,
          orderId,
          orderCode: order.code,
          // Stored so a refund can be issued through the connected account later.
          connectedAccountId: merchant.stripeAccountId,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { stripeAccount: merchant.stripeAccountId },
    );

    return c.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[shops] Failed to create checkout session:", err);
    return c.json({ ok: false, error: "Failed to create checkout session" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/orders/:orderId/quote — signed USDC payment quote.
// Public + rate-limited. Server commits (HMAC) to the EXACT 6-dec USDC amount
// for this order on the chosen chain (fiat→USD at quote time). The buyer pays
// exactly that to the MERCHANT; /pay-crypto verifies the on-chain match. Full
// amount lands with the merchant — the crypto platform fee is recorded on the
// quote but NOT split at launch (a single ERC-20 transfer can't split
// non-custodially; the split moves to the escrow/splitter path).
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/orders/:orderId/quote", async (c) => {
  if (rateLimited(payRateMap, clientIp(c), PAY_RATE_LIMIT, PAY_RATE_WINDOW)) {
    return c.json({ ok: false, error: "Too many requests. Please wait before trying again." }, 429);
  }
  const shopId = c.req.param("id");
  const orderId = c.req.param("orderId");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (!shop.payment.cryptoEnabled) {
      return c.json({ ok: false, error: "Crypto payments are not enabled for this shop" }, 400);
    }

    const order = await getOrder(shopId, orderId);
    if (!order) return c.json({ ok: false, error: "Order not found" }, 404);
    if (order.status !== "pending") {
      return c.json({ ok: false, error: "Order is not awaiting payment" }, 409);
    }

    // Read the raw body ONCE — tryVerifyAuth must hash the exact bytes the client
    // signed in the canonical session challenge.
    const rawBody = await c.req.text().catch(() => "");
    let body: ShopQuoteRequest;
    try {
      body = rawBody ? (JSON.parse(rawBody) as ShopQuoteRequest) : ({} as ShopQuoteRequest);
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }

    // POD gate (online USDC rail): refuse to sign a PAYABLE quote for a gated
    // order unless a verified wallet passes the gate. This stops payment BEFORE
    // funds move (no valid quote → can't pay the committed amount), so the buyer
    // can never "pay then get rejected" on this rail. Gated products are
    // wallet-session-only (anonymous EIP-712 binding can't be gate-checked here).
    const products = await getProducts(shopId);
    const gatedName = firstGatedProduct(products, order.lines);
    if (gatedName) {
      const auth = await tryVerifyAuth(c, rawBody);
      if (!auth) {
        return c.json(
          { ok: false, gated: true, error: `"${gatedName}" is gated — sign in with the wallet that holds the required POD to pay by crypto.` },
          401,
        );
      }
      if (!auth.ok) return c.json({ ok: false, error: auth.error }, 403);
      const decision = await checkProductGates(products, order.lines, auth.parentAddress);
      if (!decision.ok) return c.json({ ok: false, gated: true, error: decision.reason }, 403);
    }

    const chainId = body?.chainId as PaymentChainId | undefined;
    if (!chainId) return c.json({ ok: false, error: "chainId is required" }, 400);
    if (!shop.payment.acceptedChains.includes(chainId)) {
      return c.json({ ok: false, error: `Chain ${chainId} not accepted for this shop` }, 400);
    }
    if (!USDC_ADDRESSES[chainId]) {
      return c.json({ ok: false, error: `USDC is not available on chain ${chainId}` }, 400);
    }

    // Full amount to the merchant. The shared config carries an `escrow` flag,
    // but the shop escrow/splitter is not built — the online rail pays direct
    // (the locked non-custodial-launch decision; docs/WOCO_SHOP_PLAN.md §2).
    const recipient = shop.payment.recipientAddress;
    if (!recipient) {
      return c.json({ ok: false, error: "Shop has no crypto recipient configured" }, 400);
    }

    // USDC is dollar-pegged 1:1 — convert fiat→USD, then to 6-dec atomic units.
    const usd = await fiatToUSD(order.total, order.currency);
    const amountAtomic = parseUnits(usd.toFixed(6), 6).toString();
    if (BigInt(amountAtomic) <= 0n) {
      return c.json({ ok: false, error: "Order total must be positive" }, 400);
    }

    const quote = signShopQuote({
      shopId,
      orderId,
      chainId,
      recipient,
      amountAtomic,
      fiatTotal: order.total,
      fiatCurrency: order.currency,
      feeBp: getCryptoFeeConfig().bp,
      ...(body?.buyerAddress ? { boundTo: body.buyerAddress } : {}),
    });

    return c.json({ ok: true, data: quote });
  } catch (err) {
    console.error("[shops/quote]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Quote failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/shops/:id/orders/:orderId/pay-crypto — settle a crypto (USDC) order.
//
// Soft-auth: a logged-in wallet buyer authenticates via session delegation and
// the verified parentAddress IS the payer binding — a single wallet prompt (just
// the transfer). An anonymous/email buyer instead supplies an EIP-712
// ShopPayment binding proving control of the paying wallet (the anti-front-
// running guard). Either way the server requires tx.from === the bound payer and
// NEVER trusts an address taken from the body.
//
// Invariants (mirror events claims): signed quote pins exact amount + recipient
// + order; on-chain verify is exact-match amount + recipient + confirmations +
// tx.from; txHash and quote are both one-shot (file-backed) — no replay.
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/orders/:orderId/pay-crypto", async (c) => {
  if (rateLimited(payRateMap, clientIp(c), PAY_RATE_LIMIT, PAY_RATE_WINDOW)) {
    return c.json({ ok: false, error: "Too many requests. Please wait before trying again." }, 429);
  }
  const shopId = c.req.param("id");
  const orderId = c.req.param("orderId");

  // Read the raw body exactly once — tryVerifyAuth must hash the same bytes the
  // client signed in the canonical session challenge.
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ ok: false, error: "Invalid body" }, 400);
  }
  let proof: ShopPaymentProof;
  try {
    proof = JSON.parse(rawBody) as ShopPaymentProof;
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  if (!proof?.txHash || !proof?.quote || !proof?.chainId) {
    return c.json({ ok: false, error: "txHash, chainId and quote are required" }, 400);
  }

  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);

    const order = await getOrder(shopId, orderId);
    if (!order) return c.json({ ok: false, error: "Order not found" }, 404);

    // Idempotent retry: this exact tx already settled this order → return ok.
    if (
      order.status === "paid" &&
      order.payment?.rail === "crypto" &&
      order.payment.txHash?.toLowerCase() === proof.txHash.toLowerCase()
    ) {
      return c.json({ ok: true, data: order });
    }
    if (order.status !== "pending") {
      return c.json({ ok: false, error: "Order is not awaiting payment" }, 409);
    }

    // 1. Verify the quote (signature, expiry, one-shot) and bind it to THIS order.
    const quoteCheck = verifyShopQuote(proof.quote);
    if (!quoteCheck.ok) {
      return c.json({ ok: false, error: `Payment quote rejected: ${quoteCheck.error}` }, 402);
    }
    const quote = quoteCheck.quote;
    if (quote.shopId !== shopId || quote.orderId !== orderId) {
      return c.json({ ok: false, error: "Quote is for a different order" }, 400);
    }
    if (quote.chainId !== proof.chainId) {
      return c.json({ ok: false, error: "Quote chain does not match payment chain" }, 400);
    }
    const recipient = shop.payment.recipientAddress;
    if (!recipient || quote.recipient.toLowerCase() !== recipient.toLowerCase()) {
      return c.json({ ok: false, error: "Quote recipient does not match shop recipient" }, 400);
    }

    // 2. Establish the payer (expectedFrom) WITHOUT trusting any body address.
    //    Logged-in wallet → verified parentAddress (1 prompt). Anonymous → EIP-712 binding.
    let expectedFrom: Hex0x;
    const auth = await tryVerifyAuth(c, rawBody);
    if (auth && !auth.ok) {
      // Auth headers present but invalid — never silently downgrade to anonymous.
      return c.json({ ok: false, error: auth.error }, 403);
    }
    if (auth) {
      expectedFrom = auth.parentAddress.toLowerCase() as Hex0x;
    } else {
      const binding = proof.binding;
      if (!binding?.payer || !binding?.signature) {
        return c.json({ ok: false, error: "Payment binding required for anonymous checkout" }, 400);
      }
      // Reconstruct the typed message from the AUTHORITATIVE quote (not the body)
      // so a tampered binding can't bind to a different amount/order.
      const message = {
        shopId: quote.shopId,
        orderId: quote.orderId,
        quoteId: quote.quoteId,
        payer: binding.payer.toLowerCase(),
        amount: formatUnits(BigInt(quote.amountAtomic), 6),
        chainId: quote.chainId,
      };
      let recovered: string;
      try {
        recovered = verifyTypedData(
          SHOP_PAYMENT_DOMAIN,
          SHOP_PAYMENT_TYPES as unknown as Record<string, TypedDataField[]>,
          message,
          binding.signature,
        );
      } catch {
        return c.json({ ok: false, error: "Invalid payment binding signature" }, 403);
      }
      if (recovered.toLowerCase() !== binding.payer.toLowerCase()) {
        return c.json({ ok: false, error: "Binding signature does not match payer" }, 403);
      }
      expectedFrom = recovered.toLowerCase() as Hex0x;
    }

    // If the quote was bound to a payer at quote time, enforce it.
    if (quote.boundTo && quote.boundTo.toLowerCase() !== expectedFrom.toLowerCase()) {
      return c.json({ ok: false, error: "Quote is bound to a different payer" }, 403);
    }

    // POD gate — defense-in-depth against the verified payer (the /quote step
    // already blocks gated orders pre-payment; this backstops a forged/forced
    // payment that skipped quoting). Fails closed.
    const gateProducts = await getProducts(shopId);
    const gateDecision = await checkProductGates(gateProducts, order.lines, expectedFrom);
    if (!gateDecision.ok) {
      return c.json({ ok: false, gated: true, error: gateDecision.reason }, 403);
    }

    // 3. Verify the on-chain USDC transfer — exact amount, recipient, confirmations, tx.from.
    const amount = formatUnits(BigInt(quote.amountAtomic), 6);
    const verification = await verifyPayment(
      { type: "tx", txHash: proof.txHash, chainId: proof.chainId, from: expectedFrom },
      { amount, currency: "USDC", recipient, expectedFrom },
    );
    if (!verification.valid) {
      return c.json({ ok: false, error: `Payment verification failed: ${verification.error}` }, 402);
    }

    // 4. Replay prevention — txHash one-shot (global, file-backed). A tx already
    //    consumed for any order/claim cannot fund a second.
    if (!checkAndConsumeTxHash(proof.txHash)) {
      return c.json({ ok: false, error: "This transaction has already been used" }, 409);
    }
    // Quote one-shot — consume only AFTER the tx-replay gate passes.
    consumeShopQuote(quote.quoteId);

    // 5. Flip pending → paid with the verified payment record.
    const updated = await updateOrder(shopId, orderId, {
      status: "paid",
      rail: "crypto",
      buyerRef: expectedFrom,
      payment: {
        rail: "crypto",
        txHash: proof.txHash,
        chainId: proof.chainId,
        cryptoFeeBp: quote.feeBp,
      },
    });
    if (!updated) {
      // tx + quote already consumed above; we read the order moments ago, so this
      // is not expected — surface loudly for ops if a Swarm write race ever hits it.
      console.error(
        `[shops/pay-crypto] order ${shopId}/${orderId} vanished after verify — tx ${proof.txHash} consumed`,
      );
      return c.json({ ok: false, error: "Order not found" }, 404);
    }
    return c.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[shops/pay-crypto]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Payment failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Spend-permission rail (POS tap-and-go) — ZeroDev Kernel session-key draws.
//
// grant-params (public): server-dictated scope the client builds its approval to
//   match (spender, merchant, USDC, window, per-draw ceiling, max draws).
// register (auth): store a granted approval; caller's parentAddress MUST be the
//   granting Kernel; the approval is cryptographically re-checked to that Kernel.
// pay-spend-permission (auth): draw an order's amount against a permission. Owner
//   (POS) or the granting attendee (self-serve) may trigger; cap/window/target
//   on-chain policies are the real guards. Amount is computed server-side
//   (fiat→USD) exactly as the online quote does. Funds go Kernel→merchant direct.
// revoke (auth): the granting attendee stops further server-side draws.
//
// AGENTIC / x402 HOOK: this rail is the third USDC authorisation mode alongside
// the online signed-quote rail. An agent buyer settles the same way — either by
// being granted a spend permission like any attendee, or via the HTTP 402
// handshake (402 → pay USDC → retry with X-PAYMENT). Both converge on the SAME
// terminal: a verified on-chain USDC transfer to the merchant flips the order to
// paid and accrues loyalty. The order schema already carries the seam
// (OrderPayment.x402Header + PaymentRail "x402"); a future POST .../pay-x402
// reuses verifyDrawOnChain + the settledOrders one-shot + the order flip below.
// ---------------------------------------------------------------------------

shopsRouter.post("/:id/spend-permission/grant-params", async (c) => {
  if (rateLimited(payRateMap, clientIp(c), PAY_RATE_LIMIT, PAY_RATE_WINDOW)) {
    return c.json({ ok: false, error: "Too many requests. Please wait before trying again." }, 429);
  }
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (!shop.payment.cryptoEnabled) {
      return c.json({ ok: false, error: "Crypto payments are not enabled for this shop" }, 400);
    }
    const recipient = shop.payment.recipientAddress;
    if (!recipient) {
      return c.json({ ok: false, error: "Shop has no crypto recipient configured" }, 400);
    }
    const usdc = USDC_ADDRESSES[421614 as PaymentChainId];
    if (!usdc) return c.json({ ok: false, error: "USDC not configured for the spend chain" }, 500);

    const params = await grantParams(shopId, recipient, usdc);
    return c.json({ ok: true, data: params });
  } catch (err) {
    console.error("[shops/grant-params]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed" }, 500);
  }
});

shopsRouter.post("/:id/spend-permission", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (!shop.payment.cryptoEnabled) {
      return c.json({ ok: false, error: "Crypto payments are not enabled for this shop" }, 400);
    }
    const recipient = shop.payment.recipientAddress;
    if (!recipient) {
      return c.json({ ok: false, error: "Shop has no crypto recipient configured" }, 400);
    }

    const req = (await c.req.json()) as RegisterSpendPermissionRequest;
    const result = await registerSpendPermission(shopId, parentAddress, recipient, req);
    if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
    return c.json({ ok: true, data: result.permission });
  } catch (err) {
    console.error("[shops/spend-permission/register]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Register failed" }, 500);
  }
});

shopsRouter.post("/:id/spend-permission/:permId/revoke", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const result = revokeSpendPermission(c.req.param("permId"), parentAddress);
  if (!result.ok) return c.json({ ok: false, error: result.error }, result.code ?? 400);
  return c.json({ ok: true });
});

shopsRouter.post("/:id/orders/:orderId/pay-spend-permission", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  const orderId = c.req.param("orderId");
  const lockKey = `${shopId}:${orderId}`;

  if (settlingOrders.has(lockKey)) {
    return c.json({ ok: false, error: "Order settlement already in progress" }, 409);
  }
  settlingOrders.add(lockKey);
  try {
    const { permissionId } = (await c.req.json()) as PaySpendPermissionRequest;
    if (!permissionId) return c.json({ ok: false, error: "permissionId is required" }, 400);

    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    const recipient = shop.payment.recipientAddress;
    if (!recipient) return c.json({ ok: false, error: "Shop has no crypto recipient configured" }, 400);

    const permission = getSpendPermission(permissionId);
    if (!permission || permission.shopId !== shopId) {
      return c.json({ ok: false, error: "Spend permission not found" }, 404);
    }
    // Trigger auth: the POS operator (shop owner) OR the granting attendee.
    const isOwner = shop.ownerAddress.toLowerCase() === parentAddress;
    const isGrantor = permission.kernelAddress.toLowerCase() === parentAddress;
    if (!isOwner && !isGrantor) {
      return c.json({ ok: false, error: "Not authorised to settle this order" }, 403);
    }

    const order = await getOrder(shopId, orderId);
    if (!order) return c.json({ ok: false, error: "Order not found" }, 404);

    // Idempotent retry: this permission already settled this order → return ok.
    if (
      order.status === "paid" &&
      order.payment?.rail === "crypto" &&
      order.payment.spendPermissionId === permissionId
    ) {
      return c.json({ ok: true, data: order });
    }
    if (order.status !== "pending") {
      return c.json({ ok: false, error: "Order is not awaiting payment" }, 409);
    }

    // POD gate — checked BEFORE the draw (funds haven't moved), so a gated-out
    // buyer is never charged. Holder = the granting Kernel wallet (the attendee
    // whose balance the spender pulls from), NOT the POS operator. Fails closed.
    const gateProducts = await getProducts(shopId);
    const gateDecision = await checkProductGates(gateProducts, order.lines, permission.kernelAddress);
    if (!gateDecision.ok) {
      return c.json({ ok: false, gated: true, error: gateDecision.reason }, 403);
    }

    // Amount: fiat→USD→6-dec atomic, identical to the online quote endpoint.
    const usd = await fiatToUSD(order.total, order.currency);
    const amountAtomic = parseUnits(usd.toFixed(6), 6).toString();
    if (BigInt(amountAtomic) <= 0n) {
      return c.json({ ok: false, error: "Order total must be positive" }, 400);
    }

    const draw = await drawSpendPermission(permissionId, lockKey, amountAtomic, recipient);
    if (!draw.ok) {
      return c.json({ ok: false, error: `Spend draw failed: ${draw.error}` }, draw.code ?? 402);
    }

    // Replay guard — settlement tx is one-shot globally (mirrors the online rail).
    if (!checkAndConsumeTxHash(draw.settlementTxHash)) {
      // Funds moved + spent already incremented; the order flip is the real
      // one-shot (status check above). Surface but don't double-charge.
      console.error(
        `[shops/pay-spend-permission] settlement tx ${draw.settlementTxHash} already consumed`,
      );
    }

    const updated = await updateOrder(shopId, orderId, {
      status: "paid",
      rail: "crypto",
      buyerRef: permission.kernelAddress,
      payment: {
        rail: "crypto",
        chainId: permission.chainId,
        spendPermissionId: permissionId,
        settlementTxHash: draw.settlementTxHash,
        cryptoFeeBp: getCryptoFeeConfig().bp,
      },
    });
    if (!updated) {
      console.error(
        `[shops/pay-spend-permission] order ${shopId}/${orderId} vanished after draw — tx ${draw.settlementTxHash}`,
      );
      return c.json({ ok: false, error: "Order not found" }, 404);
    }
    return c.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[shops/pay-spend-permission]", err);
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Payment failed" }, 500);
  } finally {
    settlingOrders.delete(lockKey);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/shops/:id/orders/:orderId — owner status transition (fulfil/cancel)
// ---------------------------------------------------------------------------

shopsRouter.patch("/:id/orders/:orderId", requireAuth, async (c) => {
  const parentAddress = (c.get("parentAddress") as string).toLowerCase();
  const shopId = c.req.param("id");
  try {
    const shop = await getShop(shopId);
    if (!shop) return c.json({ ok: false, error: "Shop not found" }, 404);
    if (shop.ownerAddress.toLowerCase() !== parentAddress) {
      return c.json({ ok: false, error: "Not the shop owner" }, 403);
    }
    const { status } = (await c.req.json()) as { status?: OrderStatus };
    if (!status || !OWNER_SETTABLE_STATUS.has(status)) {
      return c.json({ ok: false, error: "Invalid status transition" }, 400);
    }
    const patch =
      status === "fulfilled" ? { status, fulfilledAt: new Date().toISOString() } : { status };
    const updated = await updateOrder(shopId, c.req.param("orderId"), patch);
    if (!updated) return c.json({ ok: false, error: "Order not found" }, 404);
    return c.json({ ok: true, data: updated });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Update failed" }, 500);
  }
});

export { shopsRouter };
