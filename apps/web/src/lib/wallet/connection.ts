import { getProvider, requireProvider } from "./provider.js";

/**
 * Request wallet connection (triggers MetaMask popup).
 * Returns the selected address or null if user rejected.
 */
export async function connectWallet(): Promise<string | null> {
  const provider = requireProvider();
  try {
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    return accounts[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if wallet is connected and unlocked without prompting.
 * Returns the connected address or null.
 */
export async function getConnectedAddress(): Promise<string | null> {
  const provider = getProvider();
  if (!provider) return null;

  try {
    const accounts = (await provider.request({
      method: "eth_accounts",
    })) as string[];
    if (!accounts?.length) return null;

    try {
      const permissions = (await provider.request({
        method: "wallet_getPermissions",
      })) as Array<{ parentCapability: string }>;
      const hasAccess = permissions.some(
        (p) => p.parentCapability === "eth_accounts",
      );
      return hasAccess ? accounts[0]!.toLowerCase() : null;
    } catch {
      // WalletConnect doesn't support wallet_getPermissions — trust eth_accounts
      return accounts[0]!.toLowerCase();
    }
  } catch {
    return null;
  }
}

/**
 * Listen for account changes. Returns a cleanup function.
 */
export function onAccountsChanged(
  handler: (accounts: string[]) => void,
): () => void {
  const provider = getProvider();
  if (!provider?.on) return () => {};

  const wrapped = (...args: unknown[]) =>
    handler(args[0] as string[]);

  provider.on("accountsChanged", wrapped);
  return () => provider.removeListener?.("accountsChanged", wrapped);
}
