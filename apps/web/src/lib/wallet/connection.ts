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

/**
 * Revoke wallet permissions (EIP-2255). Disconnects the dapp from the wallet
 * so the user must re-approve next time. Not all wallets implement this —
 * returns false if unsupported, in which case the caller should clear local
 * state but inform the user they may also need to disconnect from MetaMask.
 */
export async function disconnectWallet(): Promise<boolean> {
  const provider = getProvider();
  if (!provider) return false;
  try {
    await provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
    return true;
  } catch {
    // Wallet doesn't support EIP-2255 (older MetaMask, WalletConnect, Para, etc.)
    return false;
  }
}

/**
 * Force the wallet to show the account picker so the user can switch accounts.
 * Uses EIP-2255 wallet_requestPermissions which always re-prompts. Falls back
 * to eth_requestAccounts (which silently returns the current account on MetaMask
 * if already connected).
 *
 * Returns the newly selected address, or null if the user cancelled.
 */
export async function switchWalletAccount(): Promise<string | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    const permissions = (await provider.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    })) as Array<{ caveats?: Array<{ type: string; value: string[] }> }>;
    // Extract the selected address from the granted permission
    const accountsCaveat = permissions[0]?.caveats?.find(
      (c) => c.type === "restrictReturnedAccounts" || c.type === "filterResponse",
    );
    if (accountsCaveat?.value?.[0]) {
      return accountsCaveat.value[0].toLowerCase();
    }
    // Fall back to eth_accounts read after the prompt
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return accounts[0]?.toLowerCase() ?? null;
  } catch {
    // User cancelled, or wallet doesn't support wallet_requestPermissions —
    // try eth_requestAccounts (won't reprompt on most wallets, but better than nothing)
    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      return accounts[0]?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  }
}
