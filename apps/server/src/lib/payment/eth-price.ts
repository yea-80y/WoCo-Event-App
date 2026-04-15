/**
 * ETH/USD price feed — reads from Chainlink on-chain oracle.
 * Decentralised, no API key, no rate limits.
 * Falls back across multiple chains if one RPC is down.
 */

import { JsonRpcProvider, Contract } from "ethers";
import { getRpcUrl } from "./constants.js";

/** Chainlink ETH/USD price feed addresses */
const CHAINLINK_ETH_USD: Record<number, string> = {
  1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",       // Ethereum mainnet
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",     // Base
  10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",       // Optimism
  11155111: "0x694AA1769357215DE4FAC081bf1f309aDC325306",  // Sepolia
};

/** Minimal ABI — only latestRoundData() */
const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
];

let cachedPrice: number | null = null;
let cachedAt = 0;
const CACHE_TTL = 60_000; // 1 minute

/** Slippage tolerance: accept payments within 3% of expected amount */
export const PRICE_SLIPPAGE = 0.03;

/** Try chains in order until one succeeds */
const CHAIN_ORDER = [1, 8453, 10, 11155111] as const;

/**
 * Fetch current ETH price in USD from Chainlink oracle.
 * Tries multiple chains for resilience.
 */
export async function getETHPriceUSD(): Promise<number> {
  if (cachedPrice && Date.now() - cachedAt < CACHE_TTL) {
    return cachedPrice;
  }

  let lastError: Error | null = null;

  for (const chainId of CHAIN_ORDER) {
    try {
      const rpcUrl = getRpcUrl(chainId as any);
      const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
      const feed = new Contract(CHAINLINK_ETH_USD[chainId], AGGREGATOR_ABI, provider);

      const [, answer] = await feed.latestRoundData();
      // Chainlink ETH/USD feeds use 8 decimals
      const price = Number(answer) / 1e8;

      if (price <= 0) continue;

      cachedPrice = price;
      cachedAt = Date.now();
      console.log(`[eth-price] Chainlink (chain ${chainId}): $${price.toFixed(2)}`);
      return price;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Try next chain
    }
  }

  // All chains failed — use stale cache if available
  if (cachedPrice) {
    console.warn("[eth-price] All Chainlink feeds failed, using stale cache");
    return cachedPrice;
  }

  throw lastError || new Error("Failed to fetch ETH price from any Chainlink feed");
}

// ---------------------------------------------------------------------------
// Fiat → USD conversion (for GBP/EUR priced tickets)
// ---------------------------------------------------------------------------

/** Approximate forex rates to USD — updated periodically from ECB.
 *  These are fallback values; a live feed can be added later. */
const FOREX_TO_USD: Record<string, number> = {
  USD: 1,
  GBP: 1.27,  // ~Q2 2026 approximate
  EUR: 1.09,  // ~Q2 2026 approximate
};

let forexCache: Record<string, number> | null = null;
let forexCachedAt = 0;
const FOREX_CACHE_TTL = 3600_000; // 1 hour

/**
 * Try to fetch live forex rates from a free API, fall back to hardcoded.
 */
async function getForexRates(): Promise<Record<string, number>> {
  if (forexCache && Date.now() - forexCachedAt < FOREX_CACHE_TTL) {
    return forexCache;
  }
  try {
    const resp = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    if (resp.ok) {
      const data = await resp.json() as { rates: Record<string, number> };
      // We need X → USD, so invert: 1 GBP = 1/rates.GBP USD
      const rates: Record<string, number> = { USD: 1 };
      if (data.rates.GBP) rates.GBP = 1 / data.rates.GBP;
      if (data.rates.EUR) rates.EUR = 1 / data.rates.EUR;
      forexCache = rates;
      forexCachedAt = Date.now();
      console.log("[eth-price] Forex rates updated:", rates);
      return rates;
    }
  } catch {
    // Fall through to hardcoded
  }
  return FOREX_TO_USD;
}

/**
 * Convert a fiat amount (USD/GBP/EUR) to USD.
 */
export async function fiatToUSD(amount: string, currency: string): Promise<number> {
  const val = parseFloat(amount);
  if (isNaN(val) || val <= 0) throw new Error(`Invalid amount: ${amount}`);
  if (currency === "USD") return val;
  const rates = await getForexRates();
  const rate = rates[currency];
  if (!rate) throw new Error(`Unsupported currency: ${currency}`);
  return val * rate;
}

/**
 * Convert a fiat amount to ETH, returning a decimal string.
 */
export async function fiatToETH(amount: string, currency: string): Promise<string> {
  const usd = await fiatToUSD(amount, currency);
  const ethPrice = await getETHPriceUSD();
  const ethAmount = usd / ethPrice;
  return ethAmount.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Convert a USD amount to ETH, returning a decimal string.
 */
export async function usdToETH(usdAmount: string): Promise<string> {
  return fiatToETH(usdAmount, "USD");
}

/**
 * Get the minimum acceptable ETH amount for a fiat price (with slippage).
 */
export async function fiatToETHWithSlippage(amount: string, currency: string): Promise<string> {
  const usd = await fiatToUSD(amount, currency);
  const ethPrice = await getETHPriceUSD();
  const ethAmount = usd / ethPrice;
  const withSlippage = ethAmount * (1 - PRICE_SLIPPAGE);
  return withSlippage.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Get the minimum acceptable ETH amount for a USD price (with slippage).
 */
export async function usdToETHWithSlippage(usdAmount: string): Promise<string> {
  return fiatToETHWithSlippage(usdAmount, "USD");
}
