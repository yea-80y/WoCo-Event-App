import type { EthereumProvider } from "./types.js";

let _wcProvider: EthereumProvider | null = null;

export function setWalletConnectProvider(p: EthereumProvider | null) {
  _wcProvider = p;
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

export function isWalletAvailable(): boolean {
  return !!getProvider();
}
