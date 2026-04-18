import type { PaymentChainId, Hex0x } from "@woco/shared";
export { getMinConfirmations, MIN_CONFIRMATIONS_BY_CHAIN, DEFAULT_MIN_CONFIRMATIONS } from "@woco/shared";

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

// MIN_CONFIRMATIONS_BY_CHAIN, DEFAULT_MIN_CONFIRMATIONS, getMinConfirmations
// are re-exported from @woco/shared above — single source of truth across
// client and server so both sides agree on the reorg-safety threshold.
