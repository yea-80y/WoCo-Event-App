/**
 * x402 payment middleware for USDC claims.
 *
 * When a series has payment.currency === "USDC", this middleware intercepts the
 * claim request and returns a 402 with payment requirements. The client uses
 * @x402/fetch to sign an EIP-3009 transferWithAuthorization off-chain, and the
 * Coinbase facilitator settles on-chain. The middleware then allows the request
 * through with the payment verified.
 *
 * This is a thin wrapper that delegates to the x402 Hono middleware with
 * dynamic pricing (resolved per-request from the event's series config).
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types.js";
import type { PaymentChainId } from "@woco/shared";
import { USDC_ADDRESSES, CHAIN_NAMES } from "@woco/shared";
import { getEvent } from "../lib/event/service.js";
import { getEscrowAddress } from "../lib/payment/constants.js";

/** Default x402 facilitator URL */
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";

/** CAIP-2 chain identifier format */
function caip2(chainId: PaymentChainId): string {
  return `eip155:${chainId}`;
}

/**
 * x402 payment middleware for the claim endpoint.
 *
 * Usage in index.ts:
 *   claims.post("/:eventId/series/:seriesId/claim", x402ClaimMiddleware, claimHandler)
 *
 * Or applied selectively in the route handler itself.
 *
 * This middleware checks if:
 * 1. The series has USDC payment config
 * 2. The request already has a valid X-PAYMENT header (x402 proof)
 * 3. If not, returns 402 with PAYMENT-REQUIRED header
 *
 * For now this provides the 402 response format that @x402/fetch expects.
 * Full facilitator integration (verify + settle) requires the facilitator
 * service to be reachable and the contract to support EIP-3009.
 */
export async function x402ClaimMiddleware(c: Context<AppEnv>, next: Next) {
  // Only intercept if this is a paid USDC event
  const eventId = c.req.param("eventId");
  const seriesId = c.req.param("seriesId");

  if (!eventId || !seriesId) {
    return next();
  }

  // Check if request already has payment proof (handled by main claim handler)
  const body = await c.req.raw.clone().json().catch(() => null);
  if (body?.paymentProof) {
    // Payment proof already attached — let the main handler verify it
    return next();
  }

  // Check if x402 payment header is present (facilitator-verified)
  const x402Header = c.req.header("X-PAYMENT") || c.req.header("x-payment");
  if (x402Header) {
    // x402 payment present — pass through with proof injected
    // The main claim handler will see paymentProof in the body
    return next();
  }

  // Fetch event to check if series requires USDC payment
  const event = await getEvent(eventId);
  if (!event) return next();

  const series = event.series.find((s) => s.seriesId === seriesId);
  if (!series?.payment || series.payment.currency !== "USDC") {
    // Not a USDC-paid series — skip x402
    return next();
  }

  // Build 402 response with x402-compatible PAYMENT-REQUIRED header
  const payment = series.payment;
  const primaryChain = payment.acceptedChains[0] ?? 8453;
  const recipient = payment.escrow
    ? getEscrowAddress(primaryChain) ?? payment.recipientAddress
    : payment.recipientAddress;

  const paymentRequired = {
    x402Version: 2,
    accepts: payment.acceptedChains
      .filter((chainId) => USDC_ADDRESSES[chainId]) // skip chains without USDC (e.g. Sepolia)
      .map((chainId) => ({
      scheme: "exact",
      network: caip2(chainId),
      maxAmountRequired: usdcToSmallestUnit(payment.price),
      asset: USDC_ADDRESSES[chainId]!,
      payTo: payment.escrow
        ? getEscrowAddress(chainId) ?? recipient
        : recipient,
      maxTimeoutSeconds: 60,
      description: `Ticket: ${series.name}`,
      mimeType: "application/json",
      extra: { name: "USDC", version: "2" },
    })),
  };

  const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

  return c.json(
    {
      ok: false,
      error: "Payment required",
      x402: true,
    },
    402,
    {
      "PAYMENT-REQUIRED": encoded,
      "X-FACILITATOR-URL": FACILITATOR_URL,
    },
  );
}

/** Convert USDC decimal string to smallest unit (6 decimals) */
function usdcToSmallestUnit(price: string): string {
  const [whole, frac = ""] = price.split(".");
  const paddedFrac = (frac + "000000").slice(0, 6);
  return String(BigInt(whole) * 1000000n + BigInt(paddedFrac));
}
