declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

/** Connect wallet via window.ethereum. Returns address or null. */
export async function connectWallet(): Promise<string | null> {
  if (!window.ethereum) return null;
  try {
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign an EIP-712 typed-data claim via `eth_signTypedData_v4`.
 * Wallets render the structured fields (event/series/claimer/timestamp)
 * so the user can see exactly what they're authorising.
 */
export async function signClaimTypedData(
  address: string,
  typedData: unknown,
): Promise<string | null> {
  if (!window.ethereum) return null;
  try {
    return (await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(typedData)],
    })) as string;
  } catch {
    return null;
  }
}

export function isWalletAvailable(): boolean {
  return !!window.ethereum;
}
