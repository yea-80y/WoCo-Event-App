/**
 * Coinbase Smart Wallet (ERC-4337) connect / restore / disconnect flow.
 *
 * CSW is a smart-account wallet — its signatures are ERC-1271 / ERC-6492
 * shaped, not raw EOA ecrecover-able. The server-side verifier
 * (apps/server/src/lib/auth/verify-delegation.ts) uses viem's verifyTypedData
 * which transparently handles all three signature shapes.
 *
 * The SDK + provider are kept inside this module behind lazy init so the
 * ~280KB bundle isn't pulled into chunks that never touch CSW.
 */

// Avoid pulling the SDK types into the rest of the bundle unless needed.
type CoinbaseProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
};

let _provider: CoinbaseProvider | null = null;

async function getOrInitProvider(): Promise<CoinbaseProvider> {
  if (_provider) return _provider;
  const { createCoinbaseWalletSDK } = await import("@coinbase/wallet-sdk");

  // appChainIds includes Arbitrum Sepolia + One because the buildathon's
  // on-chain registry lives there. CSW addresses are deterministic across
  // chains; this list only affects which chain the user lands on at connect.
  const sdk = createCoinbaseWalletSDK({
    appName: "WoCo",
    appChainIds: [421614, 42161],
    preference: {
      options: "smartWalletOnly",
    },
  });

  _provider = sdk.getProvider() as unknown as CoinbaseProvider;
  return _provider;
}

/**
 * Open the Coinbase Smart Wallet popup and ask the user to connect.
 * Resolves to the EVM address once the user approves.
 */
export async function connectCoinbase(): Promise<{ address: string }> {
  const provider = await getOrInitProvider();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("No Coinbase Smart Wallet account returned");
  return { address: address.toLowerCase() };
}

/**
 * Silent restore — checks for an existing CSW connection without prompting.
 * Returns null when there is no active connection.
 */
export async function restoreCoinbaseSession(): Promise<{ address: string } | null> {
  try {
    const provider = await getOrInitProvider();
    // eth_accounts does NOT prompt — it returns [] when not connected.
    // Cap at 3s in case the SDK's internal storage probe stalls.
    const accounts = (await Promise.race([
      provider.request({ method: "eth_accounts" }),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 3000)),
    ])) as string[];
    const address = accounts?.[0];
    if (!address) return null;
    return { address: address.toLowerCase() };
  } catch {
    return null;
  }
}

/** Disconnect — best effort. */
export async function logoutCoinbase(): Promise<void> {
  try {
    if (_provider?.disconnect) await _provider.disconnect();
  } catch {
    // ignore
  }
}

/** Returns the EIP-1193 provider so the signer can call signTypedData. */
export async function getCoinbaseProvider(): Promise<CoinbaseProvider> {
  return getOrInitProvider();
}
