import { BrowserProvider, Contract, Interface } from "ethers";
import { getProvider } from "../wallet/provider.js";

const ABI = [
  "event Registered(bytes32 indexed eventId, address indexed organiser, uint256 supply, bytes32 manifestRef)",
  "function registerEvent(uint256 supply, bytes32 manifestRef) external returns (bytes32 eventId)",
];
const IFACE = new Interface(ABI);

/** Deployed WoCoEvent addresses by chainId. */
const ADDRESSES: Record<number, string> = {
  84532: "0x4bf8aa0FDaF5045EFEd675e019F81316063c94b4",  // Base Sepolia (redeployed 2026-05-09)
  421614: "0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A", // Arbitrum Sepolia (Arbitrum buildathon, deployed 2026-05-26)
};

export function getWoCoEventAddress(chainId: number): string | undefined {
  return ADDRESSES[chainId];
}

/**
 * Call `registerEvent` on the WoCoEvent contract from the connected wallet.
 * Returns the tx hash and the on-chain eventId emitted in the Registered event.
 */
export async function callRegisterEvent(
  chainId: number,
  supply: number,
  manifestRef: string, // 0x-prefixed bytes32
): Promise<{ txHash: string; onChainEventId: string }> {
  const rawProvider = getProvider();
  if (!rawProvider) throw new Error("No wallet connected");

  const contractAddress = getWoCoEventAddress(chainId);
  if (!contractAddress) throw new Error(`WoCoEvent not deployed on chain ${chainId}`);

  const provider = new BrowserProvider(rawProvider);

  // Ensure the wallet is on the right chain
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) {
    const chainIdHex = `0x${chainId.toString(16)}`;
    try {
      await rawProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex }],
      });
    } catch (switchErr: unknown) {
      // 4902 = chain not added to wallet yet
      if ((switchErr as { code?: number }).code === 4902) {
        const CHAIN_PARAMS: Record<number, object> = {
          84532: {
            chainId: chainIdHex,
            chainName: "Base Sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: ["https://sepolia-explorer.base.org"],
          },
          8453: {
            chainId: chainIdHex,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
          421614: {
            chainId: chainIdHex,
            chainName: "Arbitrum Sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
            blockExplorerUrls: ["https://sepolia.arbiscan.io"],
          },
          42161: {
            chainId: chainIdHex,
            chainName: "Arbitrum One",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://arb1.arbitrum.io/rpc"],
            blockExplorerUrls: ["https://arbiscan.io"],
          },
        };
        const params = CHAIN_PARAMS[chainId];
        if (!params) throw new Error(`Chain ${chainId} not supported`);
        await rawProvider.request({
          method: "wallet_addEthereumChain",
          params: [params],
        });
      } else {
        throw switchErr;
      }
    }
  }

  const signer = await provider.getSigner();
  const contract = new Contract(contractAddress, ABI, signer);
  const tx = await (contract.registerEvent as (supply: number, manifestRef: string) => Promise<{ wait: () => Promise<{ hash: string; logs: unknown[] }> }>)(supply, manifestRef);
  const receipt = await tx.wait();

  // Parse Registered event from logs
  for (const log of receipt.logs as Array<{ topics: string[]; data: string }>) {
    try {
      const parsed = IFACE.parseLog(log as Parameters<typeof IFACE.parseLog>[0]);
      if (parsed?.name === "Registered") {
        return { txHash: receipt.hash, onChainEventId: parsed.args.eventId as string };
      }
    } catch {
      // not our log
    }
  }

  throw new Error("registerEvent tx confirmed but Registered event not found in logs");
}
