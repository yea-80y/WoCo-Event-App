import type { PaymentChainId } from "@woco/shared";
import { CHAIN_NAMES } from "@woco/shared";

/** Chain metadata for the payment UI */
export interface ChainInfo {
  chainId: PaymentChainId;
  name: string;
  /** Hex chain ID for wallet_switchEthereumChain */
  hexChainId: string;
  rpcUrl: string;
  blockExplorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const CHAIN_INFO: Record<PaymentChainId, ChainInfo> = {
  1: {
    chainId: 1,
    name: CHAIN_NAMES[1],
    hexChainId: "0x1",
    rpcUrl: "https://eth.llamarpc.com",
    blockExplorer: "https://etherscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  8453: {
    chainId: 8453,
    name: CHAIN_NAMES[8453],
    hexChainId: "0x2105",
    rpcUrl: "https://mainnet.base.org",
    blockExplorer: "https://basescan.org",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  10: {
    chainId: 10,
    name: CHAIN_NAMES[10],
    hexChainId: "0xa",
    rpcUrl: "https://mainnet.optimism.io",
    blockExplorer: "https://optimistic.etherscan.io",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  11155111: {
    chainId: 11155111,
    name: CHAIN_NAMES[11155111],
    hexChainId: "0xaa36a7",
    rpcUrl: "https://1rpc.io/sepolia",
    blockExplorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  },
};

/**
 * Request the user's wallet to switch to (or add) the specified chain.
 * Works with MetaMask / any EIP-3085 compliant wallet.
 */
export async function switchChain(chainId: PaymentChainId): Promise<void> {
  const provider = (window as any).ethereum;
  if (!provider) throw new Error("No wallet detected");

  const info = CHAIN_INFO[chainId];
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: info.hexChainId }],
    });
  } catch (err: any) {
    // 4902 = chain not added yet — try to add it
    if (err.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: info.hexChainId,
          chainName: info.name,
          rpcUrls: [info.rpcUrl],
          blockExplorerUrls: [info.blockExplorer],
          nativeCurrency: info.nativeCurrency,
        }],
      });
    } else {
      throw err;
    }
  }
}
