/**
 * Shop USDC payment quote — the cryptographic commitment that eliminates the
 * client/server price race on the online crypto rail.
 *
 * Mirrors the events `lib/payment/quote.ts`: the server computes the EXACT
 * 6-dec USDC amount the buyer must pay (fiat→USD at quote time), HMAC-signs it,
 * and returns a short-TTL one-shot quote. The client pays exactly that amount;
 * the server later verifies the on-chain transfer equals the committed amount.
 *
 * Distinct HMAC domain (`woco-shop-quote-v1`) and a distinct consumed-set file
 * so a quote minted for the shop surface can never be replayed against the
 * events surface (and vice-versa), even though both reuse `PAYMENT_QUOTE_SECRET`.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hex0x, PaymentChainId, FiatCurrency, ShopPaymentQuote } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const REGISTRY_FILE = join(DATA_DIR, "consumed-shop-quotes.json");

/** Quote validity window — long enough to connect, sign + pay, short enough to
 *  bound fiat→USD drift inside the window. */
export const SHOP_QUOTE_TTL_MS = 180_000; // 3 minutes

const consumed = new Set<string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REGISTRY_FILE, "utf-8");
    const arr = JSON.parse(raw) as string[];
    for (const q of arr) consumed.add(q);
    console.log(`[shop-quote] Loaded ${consumed.size} consumed quotes from disk`);
  } catch {
    // No file yet — fresh state
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify([...consumed]), "utf-8");
  } catch (err) {
    console.error("[shop-quote] Failed to persist to disk:", err);
  }
}

function getSecret(): string {
  const secret = process.env.PAYMENT_QUOTE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "PAYMENT_QUOTE_SECRET is missing or too short — shop quotes cannot be signed.",
    );
  }
  return secret;
}

/** Canonical string the HMAC covers. Order is part of the contract — never reorder. */
function canonical(q: Omit<ShopPaymentQuote, "sig">): string {
  return [
    "woco-shop-quote-v1",
    q.quoteId,
    q.shopId,
    q.orderId,
    String(q.chainId),
    q.currency,
    q.recipient.toLowerCase(),
    q.amountAtomic,
    q.fiatTotal,
    q.fiatCurrency,
    String(q.feeBp),
    String(q.expiresAt),
    q.boundTo?.toLowerCase() ?? "",
  ].join("\n");
}

function sign(canonicalStr: string): string {
  return createHmac("sha256", getSecret()).update(canonicalStr).digest("hex");
}

/** Build and sign a shop USDC quote. Caller supplies the freshly-computed amount. */
export function signShopQuote(input: {
  shopId: string;
  orderId: string;
  chainId: PaymentChainId;
  recipient: Hex0x;
  amountAtomic: string;
  fiatTotal: string;
  fiatCurrency: FiatCurrency;
  feeBp: number;
  boundTo?: string;
  ttlMs?: number;
}): ShopPaymentQuote {
  const expiresAt = Date.now() + (input.ttlMs ?? SHOP_QUOTE_TTL_MS);
  const base: Omit<ShopPaymentQuote, "sig"> = {
    quoteId: randomUUID(),
    shopId: input.shopId,
    orderId: input.orderId,
    chainId: input.chainId,
    currency: "USDC",
    recipient: input.recipient,
    amountAtomic: input.amountAtomic,
    fiatTotal: input.fiatTotal,
    fiatCurrency: input.fiatCurrency,
    feeBp: input.feeBp,
    expiresAt,
    ...(input.boundTo ? { boundTo: input.boundTo.toLowerCase() } : {}),
  };
  return { ...base, sig: sign(canonical(base)) };
}

export type ShopQuoteVerifyResult =
  | { ok: true; quote: ShopPaymentQuote }
  | { ok: false; error: string };

/**
 * Verify a quote's signature, expiry, and one-shot status. Does NOT consume —
 * call `consumeShopQuote()` once the on-chain payment has been verified.
 */
export function verifyShopQuote(quote: ShopPaymentQuote): ShopQuoteVerifyResult {
  ensureLoaded();

  if (!quote || typeof quote !== "object") {
    return { ok: false, error: "Quote missing" };
  }
  if (!quote.sig || typeof quote.sig !== "string") {
    return { ok: false, error: "Quote signature missing" };
  }

  const { sig, ...rest } = quote;
  let expectedSig: string;
  try {
    expectedSig = sign(canonical(rest));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Constant-time compare.
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "Quote signature invalid" };
  }

  if (Date.now() > quote.expiresAt) {
    return { ok: false, error: "Quote expired — request a fresh quote and pay again" };
  }

  if (consumed.has(quote.quoteId)) {
    return { ok: false, error: "Quote already used" };
  }

  return { ok: true, quote };
}

/**
 * Mark a quote as consumed. Call only after the on-chain payment for this quote
 * has been verified and the order is about to flip to paid. Persisted to disk so
 * restarts can't permit replay of a single signed quote.
 */
export function consumeShopQuote(quoteId: string): void {
  ensureLoaded();
  consumed.add(quoteId);
  persistToDisk();
}
