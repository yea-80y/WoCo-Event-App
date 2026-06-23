import { createPublicClient, http, type Chain } from "viem";
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism } from "viem/chains";

/**
 * viem public client(s) for verifying ERC-1271 / ERC-6492 signatures from
 * smart-account wallets.
 *
 * CRITICAL: the verifier chain must match the chain the smart-account contract
 * lives on, NOT the dApp's `appChainIds`. Different wallet kinds live on
 * different chains, and a 1271/6492 signature only validates on its account's
 * home chain:
 *   - Coinbase Smart Wallet → Base / Base Sepolia. CSW's `replaySafeHash` wraps
 *     the digest with the wallet contract's `block.chainid`; empirically
 *     (2026-05-26) with `appChainIds=[421614,42161]` the 6492 sig still only
 *     verifies on Base Sepolia (84532).
 *   - ZeroDev Kernel (passkey) → Arbitrum Sepolia (421614). Its 6492 wrapper
 *     embeds the Arbitrum factory + deploy data, so it ONLY validates on Arb.
 *
 * Because both are in use, we verify against EVERY candidate chain and accept if
 * ANY validates (see verifySmartWalletTypedData). Defaults cover both testnet
 * homes; extra chains can be added via SMART_WALLET_VERIFY_CHAINS (comma list)
 * or the legacy singular SMART_WALLET_VERIFY_CHAIN — both are merged into the
 * defaults rather than replacing them.
 *
 * EOA signatures never need any chain: viem's verifyTypedData short-circuits to
 * local ecrecover for plain-EOA sigs, so the very first client returns true
 * without an RPC call and we never touch the remaining candidates.
 */

const CHAINS_BY_NAME: Record<string, Chain> = {
  "arbitrum-sepolia": arbitrumSepolia,
  arbitrum: arbitrum,
  base: base,
  "base-sepolia": baseSepolia,
  mainnet: mainnet,
  optimism: optimism,
};

/** Optional per-chain RPC overrides; fall back to viem's default public RPC. */
const RPC_BY_NAME: Record<string, string | undefined> = {
  base: process.env.BASE_RPC_URL,
  "base-sepolia": process.env.BASE_SEPOLIA_RPC_URL,
  arbitrum: process.env.ARBITRUM_RPC_URL,
  "arbitrum-sepolia": process.env.ARBITRUM_SEPOLIA_RPC_URL,
};

function resolveChainNames(): string[] {
  const names = new Set<string>(["base-sepolia", "arbitrum-sepolia"]);
  const raw = `${process.env.SMART_WALLET_VERIFY_CHAINS ?? ""},${process.env.SMART_WALLET_VERIFY_CHAIN ?? ""}`;
  for (const n of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (n && CHAINS_BY_NAME[n]) names.add(n);
  }
  return [...names];
}

function buildClients() {
  return resolveChainNames().map((name) => {
    const chain = CHAINS_BY_NAME[name];
    const rpcUrl = RPC_BY_NAME[name];
    console.error(`[smart-wallet-client] verify candidate chain=${chain.name} id=${chain.id} rpc=${rpcUrl ?? "default"}`);
    return createPublicClient({ chain, transport: http(rpcUrl) });
  });
}

type SmartWalletClient = ReturnType<typeof createPublicClient>;
type VerifyTypedDataParams = Parameters<SmartWalletClient["verifyTypedData"]>[0];

let _clients: SmartWalletClient[] | null = null;

function getSmartWalletClients(): SmartWalletClient[] {
  if (!_clients) _clients = buildClients();
  return _clients;
}

/**
 * Backward-compatible single-client accessor (first candidate). Prefer
 * verifySmartWalletTypedData for signature checks.
 */
export function getSmartWalletClient(): SmartWalletClient {
  return getSmartWalletClients()[0];
}

/**
 * Verify a typed-data signature across all candidate smart-account home chains.
 * Returns true on the first chain that validates. EOA sigs validate on the first
 * client via local ecrecover (no RPC). Per-chain RPC errors are swallowed so one
 * unreachable RPC can't veto a sig that another chain would accept.
 */
export async function verifySmartWalletTypedData(
  params: VerifyTypedDataParams,
): Promise<boolean> {
  let lastErr: unknown = null;
  const sig = params.signature as string;
  console.error("[smart-wallet-client] verify address=%s sigLen=%d", params.address, sig?.length ?? 0);
  for (const client of getSmartWalletClients()) {
    try {
      // Check whether the account is deployed before verifying — distinguishes
      // "counterfactual Kernel (no code)" from "deployed but wrong sig".
      const code = await client.getCode({ address: params.address as `0x${string}` });
      const deployed = code && code !== "0x" && code.length > 2;
      console.error("[smart-wallet-client] chain=%s deployed=%s", client.chain?.name, deployed);
      const ok = await client.verifyTypedData(params);
      console.error("[smart-wallet-client] chain=%s result=%s", client.chain?.name, ok);
      if (ok) return true;
    } catch (e) {
      console.error("[smart-wallet-client] chain=%s error: %s", client.chain?.name, (e as Error)?.message ?? e);
      lastErr = e;
    }
  }
  if (lastErr) {
    console.error("[smart-wallet-client] all candidate chains failed/errored:", (lastErr as Error)?.message ?? lastErr);
  }
  return false;
}
