import type { EthereumProvider } from "./types.js";

export function getProvider(): EthereumProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return window.ethereum;
}

export function requireProvider(): EthereumProvider {
  const provider = getProvider();
  if (!provider) throw new Error("No wallet provider found");
  return provider;
}

export function isWalletAvailable(): boolean {
  return !!getProvider();
}
