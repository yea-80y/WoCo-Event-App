import type { BrowserProvider } from "ethers";
import type { EthereumProvider } from "./types.js";

let _wcProvider: EthereumProvider | null = null;
let _ethersProvider: BrowserProvider | null = null;

export function setWalletConnectProvider(p: EthereumProvider | null) {
  _wcProvider = p;
  _ethersProvider = null; // reset when underlying provider changes
}

export function getProvider(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window.ethereum as EthereumProvider | undefined) ?? _wcProvider ?? undefined;
}

export function requireProvider(): EthereumProvider {
  const provider = getProvider();
  if (!provider) throw new Error("No wallet provider found");
  return provider;
}

/**
 * Returns a cached BrowserProvider wrapping the current wallet provider.
 * Async so ethers stays out of the eager boot graph (this module is reachable
 * from the login modal at first paint).
 */
export async function getEthersProvider(): Promise<BrowserProvider> {
  if (!_ethersProvider) {
    const { BrowserProvider } = await import("ethers");
    _ethersProvider = new BrowserProvider(requireProvider());
  }
  return _ethersProvider;
}

export function isWalletAvailable(): boolean {
  return !!getProvider();
}
