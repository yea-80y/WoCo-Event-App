/**
 * Deployed ContentHashRegistry contract addresses.
 * Updated after each deployment.
 */
export const REGISTRY_ADDRESSES: Record<number, string> = {
  // Ethereum Mainnet
  // 1: "0x...",

  // Sepolia Testnet
  // 11155111: "0x...",
};

/**
 * Get the registry address for the current environment.
 * Prefers VITE_REGISTRY_ADDRESS env var, then falls back to chain-specific address.
 */
export function getRegistryAddress(chainId: number): string | null {
  const envAddr = import.meta.env.VITE_REGISTRY_ADDRESS;
  if (envAddr) return envAddr;
  return REGISTRY_ADDRESSES[chainId] ?? null;
}

/** Default chain ID — mainnet (1) or override via env */
export function getDefaultChainId(): number {
  const envChain = import.meta.env.VITE_CHAIN_ID;
  return envChain ? parseInt(envChain, 10) : 1;
}

/** Default RPC URL for read-only access (users without wallets) */
export function getDefaultRpcUrl(): string {
  return import.meta.env.VITE_RPC_URL || "https://eth.llamarpc.com";
}
