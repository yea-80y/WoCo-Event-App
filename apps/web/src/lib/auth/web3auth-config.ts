/**
 * Shared Web3Auth (v10 PnP Modal) config + raw-key extraction, used by BOTH the
 * primary email login (`web3auth-account.ts`) and the email backup factor
 * (`wallet/backup-signer.ts`). Centralised because these bits are funds-critical
 * and MUST NOT drift between the two call sites — when they did, a fix to one left
 * the other broken.
 *
 * Why chainNamespace OTHER: in v10 an EIP155/SOLANA chain routes the provider
 * through ws-embed (a remote-signing embedded wallet) which never exposes the raw
 * key — `eth_private_key`/`private_key` 404 on its Torus controller. A chain with
 * namespace OTHER instead binds the provider to CommonPrivateKeyProvider, which
 * serves `private_key`. The derived secp256k1 key is the same app-scoped key
 * either way; only the exposure path changes.
 */

type Web3AuthModule = typeof import("@web3auth/modal");

/**
 * Constructor options for a Web3Auth instance that yields the raw recovery key.
 * 🔴 FUNDS-CRITICAL: the key is a deterministic function of (user login) ×
 * VITE_WEB3AUTH_CLIENT_ID × network. Changing clientId or network changes every
 * user's key and orphans every escrow envelope sealed to the old key. Pin both
 * for production; never repoint a live deployment.
 */
export function buildWeb3AuthOptions(mod: Web3AuthModule, clientId: string) {
  const { WEB3AUTH_NETWORK, CHAIN_NAMESPACES } = mod;
  const networkEnv = (import.meta.env.VITE_WEB3AUTH_NETWORK as string | undefined) ?? "sapphire_devnet";
  const web3AuthNetwork =
    networkEnv === "sapphire_mainnet" ? WEB3AUTH_NETWORK.SAPPHIRE_MAINNET : WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;

  // OTHER namespace = key-only, no chain calls. But modal init still validates the
  // provider config and rejects an empty rpcTarget ("Please provide rpcTarget inside
  // chain"), so we give it a real URL. It is never actually called — `private_key`
  // extraction does no RPC — it only has to be a valid endpoint string.
  const chain = {
    chainNamespace: CHAIN_NAMESPACES.OTHER,
    chainId: "0x1",
    rpcTarget: "https://rpc.ankr.com/eth",
    displayName: "WoCo recovery key",
    blockExplorerUrl: "https://etherscan.io",
    ticker: "ETH",
    tickerName: "Ethereum",
    logo: "https://web3auth.io/images/web3authlog.png",
  };

  return {
    clientId,
    web3AuthNetwork,
    // Only the email/social key — never browser extensions (an injected provider
    // hooking the wallet-services embed crashes the popup handshake).
    multiInjectedProviderDiscovery: false,
    chains: [chain],
    defaultChainId: chain.chainId,
  };
}

type MinimalProvider = { request: (args: { method: string }) => Promise<unknown> };

/** Read the raw secp256k1 key (no 0x guaranteed) from a CommonPrivateKeyProvider. */
export async function extractRawPrivateKey(provider: MinimalProvider): Promise<string> {
  const raw = (await provider.request({ method: "private_key" })) as string | undefined;
  if (!raw) throw new Error("Couldn't read the Web3Auth wallet key — try again.");
  return raw;
}
