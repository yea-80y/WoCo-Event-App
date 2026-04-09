import type { PaymentChainId, Hex0x } from "@woco/shared";

/** Default public RPC endpoints (overridable via env) */
export const DEFAULT_RPC_URLS: Record<PaymentChainId, string> = {
  1: "https://eth.llamarpc.com",
  8453: "https://mainnet.base.org",
  10: "https://mainnet.optimism.io",
  11155111: "https://1rpc.io/sepolia",
};

/** Get RPC URL for a chain, preferring env override */
export function getRpcUrl(chainId: PaymentChainId): string {
  const envKey = `RPC_URL_${chainId}`;
  return process.env[envKey] || DEFAULT_RPC_URLS[chainId];
}

/** Get escrow contract address for a chain (from env) */
export function getEscrowAddress(chainId: PaymentChainId): Hex0x | undefined {
  const envKey = `ESCROW_ADDRESS_${chainId}`;
  const addr = process.env[envKey];
  return addr ? (addr.toLowerCase() as Hex0x) : undefined;
}

/** ERC-20 Transfer event signature */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Minimum confirmations required per chain.
 * - Mainnet: 12 (reorgs happen regularly at depth 1-2)
 * - L2s (Base, Optimism): 3 (different finality model, lower reorg risk)
 * - Sepolia testnet: 3
 */
export const MIN_CONFIRMATIONS_BY_CHAIN: Record<number, number> = {
  1: 12,          // Ethereum mainnet
  8453: 3,        // Base
  10: 3,          // Optimism
  11155111: 3,    // Sepolia
};

/** Fallback if chain not in the map */
export const DEFAULT_MIN_CONFIRMATIONS = 6;

/** Get minimum confirmations for a chain */
export function getMinConfirmations(chainId: number): number {
  return MIN_CONFIRMATIONS_BY_CHAIN[chainId] ?? DEFAULT_MIN_CONFIRMATIONS;
}
