/**
 * Shop crypto (USDC) payment — client API.
 *
 * Mirrors `api/payment.ts` (events). Two-step flow:
 *   1. fetchShopPaymentQuote — server commits (HMAC) to the EXACT USDC amount.
 *   2. pay that amount on-chain, then submitShopCryptoPayment with the proof.
 *
 * Payer binding (anti front-running): a logged-in wallet buyer is bound by their
 * session delegation, so they sign nothing beyond the USDC transfer itself (one
 * prompt). An anonymous/email buyer signs the EIP-712 `ShopPayment` envelope —
 * legible, domain-separated, pre-signable — to prove control of the paying
 * wallet (a second prompt, but never blind).
 */

import type {
  Hex0x,
  Order,
  PaymentChainId,
  ShopPaymentQuote,
  ShopPaymentProof,
} from "@woco/shared";
import { SHOP_PAYMENT_DOMAIN, SHOP_PAYMENT_TYPES } from "@woco/shared";
import { formatUnits, type TypedDataField } from "ethers";
import { apiBase, authPost } from "./client.js";

/** Request a server-signed USDC quote for an order. One-shot, ~3-min TTL. */
export async function fetchShopPaymentQuote(opts: {
  shopId: string;
  orderId: string;
  chainId: PaymentChainId;
  /** Paying wallet, when known — binds the quote to it for defense-in-depth. */
  buyerAddress?: Hex0x;
}): Promise<ShopPaymentQuote> {
  const resp = await fetch(
    `${apiBase}/api/shops/${opts.shopId}/orders/${opts.orderId}/quote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: opts.chainId,
        ...(opts.buyerAddress ? { buyerAddress: opts.buyerAddress } : {}),
      }),
    },
  );

  let data: { ok: boolean; data?: ShopPaymentQuote; error?: string };
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Quote request failed: HTTP ${resp.status}`);
  }
  if (!data.ok || !data.data) {
    throw new Error(data.error || `Quote request failed: HTTP ${resp.status}`);
  }
  return data.data;
}

/**
 * Build the EIP-712 typed-data payload an anonymous buyer signs to bind their
 * wallet to the order. Reconstructable from the quote alone — the amount/order/
 * quoteId all come from the server-signed quote, so the wallet renders exactly
 * what the server will verify. Omit the txHash deliberately so it can be signed
 * before the transfer is broadcast (no sign → wait → sign-again stall).
 */
export function buildShopPaymentTypedData(quote: ShopPaymentQuote, payer: Hex0x) {
  return {
    domain: SHOP_PAYMENT_DOMAIN,
    types: SHOP_PAYMENT_TYPES as unknown as Record<string, TypedDataField[]>,
    primaryType: "ShopPayment" as const,
    message: {
      shopId: quote.shopId,
      orderId: quote.orderId,
      quoteId: quote.quoteId,
      payer: payer.toLowerCase(),
      amount: formatUnits(BigInt(quote.amountAtomic), 6),
      chainId: quote.chainId,
    },
  };
}

/**
 * Settle a crypto order after the on-chain USDC transfer confirms.
 *
 * Pass `binding` for anonymous buyers (EIP-712 payer proof) — the request goes
 * unauthenticated. Omit it for logged-in wallet buyers — the request is
 * session-authenticated and the verified parentAddress is the binding.
 */
export async function submitShopCryptoPayment(opts: {
  shopId: string;
  orderId: string;
  txHash: string;
  chainId: PaymentChainId;
  quote: ShopPaymentQuote;
  binding?: { payer: Hex0x; signature: string };
}): Promise<Order> {
  const path = `/api/shops/${opts.shopId}/orders/${opts.orderId}/pay-crypto`;
  const proof: ShopPaymentProof = {
    txHash: opts.txHash,
    chainId: opts.chainId,
    quote: opts.quote,
    ...(opts.binding ? { binding: opts.binding } : {}),
  };

  if (opts.binding) {
    // Anonymous path — plain POST; the EIP-712 binding carries the payer proof.
    const resp = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    });
    let data: { ok: boolean; data?: Order; error?: string };
    try {
      data = await resp.json();
    } catch {
      throw new Error(`Payment failed: HTTP ${resp.status}`);
    }
    if (!data.ok || !data.data) {
      throw new Error(data.error || `Payment failed: HTTP ${resp.status}`);
    }
    return data.data;
  }

  // Logged-in path — session-authenticated; parentAddress is the payer binding.
  const res = await authPost<Order>(path, proof as unknown as Record<string, unknown>);
  if (!res.ok || !res.data) throw new Error(res.error || "Payment failed");
  return res.data;
}
