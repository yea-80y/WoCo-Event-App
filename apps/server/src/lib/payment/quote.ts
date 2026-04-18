/**
 * Signed payment quote — the cryptographic commitment that eliminates the
 * client/server price race.
 *
 * The server computes the EXACT wei amount the user must pay (Chainlink ETH/USD
 * + live forex), HMAC-signs it, and returns a quote with a short TTL. The
 * client pays exactly that amount; the server later verifies the on-chain
 * tx.value equals the same wei. No slippage band, no two-source drift.
 *
 * One-shot consumption: a quote can only be redeemed once, persisted to disk
 * so restarts don't permit double-spend of a single signed quote.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hex0x, PaymentChainId, PaymentQuote } from "@woco/shared";

const DATA_DIR = join(process.cwd(), ".data");
const REGISTRY_FILE = join(DATA_DIR, "consumed-quotes.json");

/** Quote validity window. Long enough to review + sign + a couple of confirmations,
 *  short enough that price drift inside the window is bounded. */
export const QUOTE_TTL_MS = 180_000; // 3 minutes

const consumed = new Set<string>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(REGISTRY_FILE, "utf-8");
    const arr = JSON.parse(raw) as string[];
    for (const q of arr) consumed.add(q);
    console.log(`[quote] Loaded ${consumed.size} consumed quotes from disk`);
  } catch {
    // No file yet — fresh state
  }
}

function persistToDisk(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify([...consumed]), "utf-8");
  } catch (err) {
    console.error("[quote] Failed to persist to disk:", err);
  }
}

function getSecret(): string {
  const secret = process.env.PAYMENT_QUOTE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "PAYMENT_QUOTE_SECRET is missing or too short — quotes cannot be signed.",
    );
  }
  return secret;
}

/** Canonical string the HMAC covers. Order is part of the contract — never reorder. */
function canonical(q: Omit<PaymentQuote, "sig">): string {
  return [
    "woco-quote-v1",
    q.quoteId,
    q.seriesId,
    String(q.chainId),
    q.currency,
    q.recipient.toLowerCase(),
    q.amountWei,
    q.fiatPrice,
    q.fiatCurrency,
    String(q.expiresAt),
    q.boundTo?.toLowerCase() ?? "",
  ].join("\n");
}

function sign(canonicalStr: string): string {
  return createHmac("sha256", getSecret()).update(canonicalStr).digest("hex");
}

/**
 * Build and sign a payment quote. The caller (quote endpoint) supplies the
 * already-computed amountWei from the freshest oracle read.
 */
export function signQuote(input: {
  seriesId: string;
  chainId: PaymentChainId;
  currency: "ETH" | "USDC";
  recipient: Hex0x;
  amountWei: string;
  fiatPrice: string;
  fiatCurrency: string;
  boundTo?: string;
  ttlMs?: number;
}): PaymentQuote {
  const expiresAt = Date.now() + (input.ttlMs ?? QUOTE_TTL_MS);
  const base: Omit<PaymentQuote, "sig"> = {
    quoteId: randomUUID(),
    seriesId: input.seriesId,
    chainId: input.chainId,
    currency: input.currency,
    recipient: input.recipient,
    amountWei: input.amountWei,
    fiatPrice: input.fiatPrice,
    fiatCurrency: input.fiatCurrency,
    expiresAt,
    ...(input.boundTo ? { boundTo: input.boundTo.toLowerCase() } : {}),
  };
  return { ...base, sig: sign(canonical(base)) };
}

export type QuoteVerifyResult =
  | { ok: true; quote: PaymentQuote }
  | { ok: false; error: string };

/**
 * Verify a quote's signature, expiry, and one-shot status. Does NOT consume —
 * call consumeQuote() once the on-chain payment has been verified.
 */
export function verifyQuote(quote: PaymentQuote): QuoteVerifyResult {
  ensureLoaded();

  if (!quote || typeof quote !== "object") {
    return { ok: false, error: "Quote missing" };
  }
  if (!quote.sig || typeof quote.sig !== "string") {
    return { ok: false, error: "Quote signature missing" };
  }

  // Recompute and compare in constant time
  const { sig, ...rest } = quote;
  let expectedSig: string;
  try {
    expectedSig = sign(canonical(rest));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

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
 * Mark a quote as consumed. Call only after the on-chain payment for this
 * quote has been verified and the ticket has been (or is about to be) issued.
 * Persisted to disk so restarts can't permit replay.
 */
export function consumeQuote(quoteId: string): void {
  ensureLoaded();
  consumed.add(quoteId);
  persistToDisk();
}
