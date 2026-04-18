import type { PaymentChainId, PaymentQuote } from "@woco/shared";
import { apiBase } from "./client.js";

/**
 * Request a server-signed payment quote. The server commits to an exact wei
 * amount (Chainlink + live forex, computed once on the server). The client
 * pays exactly that amount; the server later verifies an exact-match against
 * the on-chain tx.value. Eliminates the client/server price race.
 *
 * Quotes are short-TTL (3 minutes) and one-shot. If the user takes too long,
 * fetch a fresh one.
 */
export async function fetchPaymentQuote(opts: {
  eventId: string;
  seriesId: string;
  chainId: PaymentChainId;
  currency: "ETH" | "USDC";
  claimerAddress?: string;
}): Promise<PaymentQuote> {
  const resp = await fetch(`${apiBase}/api/payment/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });

  let data: { ok: boolean; quote?: PaymentQuote; error?: string };
  try {
    data = await resp.json();
  } catch {
    throw new Error(`Quote request failed: HTTP ${resp.status}`);
  }

  if (!data.ok || !data.quote) {
    throw new Error(data.error || `Quote request failed: HTTP ${resp.status}`);
  }
  return data.quote;
}
