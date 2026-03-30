/**
 * ETH/USD price feed for the frontend.
 * Proxied through our server to avoid CoinGecko CORS + rate-limit issues.
 */

import { apiBase } from "../api/client.js";

let cachedPrice: number | null = null;
let cachedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

/** Fetch current ETH price in USD via server proxy. */
export async function getETHPriceUSD(): Promise<number> {
  if (cachedPrice && Date.now() - cachedAt < CACHE_TTL) {
    return cachedPrice;
  }

  const resp = await fetch(`${apiBase}/api/eth-price`);
  if (!resp.ok) {
    if (cachedPrice) return cachedPrice;
    throw new Error("Failed to fetch ETH price");
  }

  const data = (await resp.json()) as { ok: boolean; price?: number; error?: string };
  if (!data.ok || !data.price || data.price <= 0) {
    if (cachedPrice) return cachedPrice;
    throw new Error(data.error || "Invalid ETH price");
  }

  cachedPrice = data.price;
  cachedAt = Date.now();
  return data.price;
}

/** Convert USD amount string to ETH decimal string. */
export async function usdToETH(usdAmount: string): Promise<string> {
  const ethPrice = await getETHPriceUSD();
  const usd = parseFloat(usdAmount);
  if (isNaN(usd) || usd <= 0) return "0";
  const eth = usd / ethPrice;
  // Show 6 significant decimals for readability
  if (eth < 0.001) return eth.toFixed(8);
  if (eth < 1) return eth.toFixed(6);
  return eth.toFixed(4);
}
