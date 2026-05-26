import { createPublicClient, http, type Chain } from "viem";
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism } from "viem/chains";

/**
 * viem public client for verifying ERC-1271 / ERC-6492 signatures from
 * smart-account wallets (Coinbase Smart Wallet, Safe, etc.).
 *
 * CRITICAL: verifier chain must match the chain CSW's smart-account contract
 * lives on, NOT the dApp's `appChainIds`. CSW's `replaySafeHash` wraps the
 * EIP-712 digest with `block.chainid` from the wallet contract's POV — that
 * contract is deployed on Base / Base Sepolia regardless of what app chain
 * the SDK's `appChainIds` advertises. Empirically (2026-05-26): with
 * `appChainIds=[421614, 42161]` the resulting 6492 sig only verifies on
 * Base Sepolia (84532). Testnet → base-sepolia, mainnet → base.
 *
 * Override via `SMART_WALLET_VERIFY_CHAIN` env.
 *
 * EOA signatures never hit this client — viem's verifyTypedData short-circuits
 * to local ecrecover for plain-EOA sigs and only opens an RPC connection when
 * the signature requires 1271/6492 contract simulation.
 */

const CHAINS_BY_NAME: Record<string, Chain> = {
  "arbitrum-sepolia": arbitrumSepolia,
  arbitrum: arbitrum,
  base: base,
  "base-sepolia": baseSepolia,
  mainnet: mainnet,
  optimism: optimism,
};

function resolveChain(): Chain {
  const name = (process.env.SMART_WALLET_VERIFY_CHAIN ?? "base-sepolia").toLowerCase();
  const chain = CHAINS_BY_NAME[name];
  if (!chain) {
    console.warn(`[smart-wallet-client] Unknown SMART_WALLET_VERIFY_CHAIN=${name}, falling back to base-sepolia`);
    return baseSepolia;
  }
  return chain;
}

function buildClient() {
  const chain = resolveChain();
  const rpcUrl = process.env.SMART_WALLET_VERIFY_RPC;
  console.error(`[smart-wallet-client] using chain=${chain.name} (id=${chain.id}) rpc=${rpcUrl ?? "default"}`);
  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
}

let _client: ReturnType<typeof buildClient> | null = null;

export function getSmartWalletClient(): ReturnType<typeof buildClient> {
  if (!_client) _client = buildClient();
  return _client;
}
