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

/** Sign a claim message via MetaMask personal_sign (EIP-191). Returns hex signature or null. */
export async function signClaimMessage(address: string, message: string): Promise<string | null> {
  if (!window.ethereum) return null;
  try {
    const msgHex = "0x" + Array.from(new TextEncoder().encode(message))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    return (await window.ethereum.request({
      method: "personal_sign",
      params: [msgHex, address],
    })) as string;
  } catch {
    return null;
  }
}

export function isWalletAvailable(): boolean {
  return !!window.ethereum;
}
