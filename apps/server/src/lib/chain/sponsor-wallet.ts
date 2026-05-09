import { Wallet, Contract, Interface, JsonRpcProvider } from "ethers";
import { getActiveChainId, getWoCoEventAddress } from "./event-contract.js";
import { getRpcUrl } from "../payment/constants.js";
import type { PaymentChainId } from "@woco/shared";

const CLAIM_ABI = [
  "function claimFor(bytes32 eventId, address burner, bytes32 orderRef) returns (uint256 slot)",
  "event SlotClaimed(bytes32 indexed eventId, uint256 slot, address indexed buyer, bytes32 orderRef)",
];

let _wallet: Wallet | null = null;

function getSponsorWallet(): Wallet {
  if (_wallet) return _wallet;
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
  const chainId = getActiveChainId();
  const url = getRpcUrl(chainId as PaymentChainId);
  const provider = new JsonRpcProvider(url);
  _wallet = new Wallet(pk, provider);
  return _wallet;
}

/** Generate a fresh ephemeral burner address. Private key is discarded immediately. */
export function generateBurnerAddress(): string {
  return Wallet.createRandom().address;
}

/**
 * Call WoCoEvent.claimFor as the platform sponsor wallet.
 *
 * @param onChainEventId  0x-prefixed bytes32 event ID from registerEvent
 * @param burnerAddress   Buyer's ephemeral address (only the public key goes on-chain)
 * @param orderRefBytes32 "0x" + 64-char Swarm hex ref of the encrypted order blob
 * @returns 0-based slot index from the SlotClaimed event
 */
export async function claimForOnChain(
  onChainEventId: string,
  burnerAddress: string,
  orderRefBytes32: string,
): Promise<number> {
  const chainId = getActiveChainId();
  const address = getWoCoEventAddress(chainId);
  if (!address) throw new Error(`No WoCoEvent contract on chain ${chainId}`);

  const wallet = getSponsorWallet();
  const contract = new Contract(address, CLAIM_ABI, wallet);

  console.log(
    `[sponsor] claimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `burner=${burnerAddress} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await contract.claimFor(onChainEventId, burnerAddress, orderRefBytes32);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from claimFor tx");

  console.log(`[sponsor] claimFor confirmed txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);

  const iface = new Interface(CLAIM_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "SlotClaimed") {
        const slot = Number(parsed.args.slot);
        console.log(`[sponsor] SlotClaimed slot=${slot}`);
        return slot;
      }
    } catch {
      // skip unparseable logs from other contracts
    }
  }

  throw new Error("SlotClaimed event not found in claimFor receipt");
}
