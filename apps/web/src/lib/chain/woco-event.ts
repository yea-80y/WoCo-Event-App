import { BrowserProvider, Contract, Interface } from "ethers";
import { getProvider } from "../wallet/provider.js";

const ABI = [
  "event Registered(bytes32 indexed eventId, address indexed organiser, uint256 supply, bytes32 manifestRef)",
  "function registerEvent(uint256 supply, bytes32 manifestRef) external returns (bytes32 eventId)",
];
const IFACE = new Interface(ABI);

/** Deployed WoCoEvent addresses by chainId. */
const ADDRESSES: Record<number, string> = {
  84532: "0xC56f73d100c40be5780b81B211c6e216F805D598", // Base Sepolia
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
    // Request chain switch
    await rawProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
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
