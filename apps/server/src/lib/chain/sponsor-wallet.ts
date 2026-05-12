import { Wallet, HDNodeWallet, Contract, Interface, JsonRpcProvider } from "ethers";
import { getActiveChainId, getWoCoEventAddress, getChainRpcUrl } from "./event-contract.js";

const CLAIM_ABI = [
  "function claimFor(bytes32 eventId, address burner, bytes32 orderRef) returns (uint256 slot)",
  "function batchClaimFor(bytes32 eventId, address[] burners, bytes32 orderRef) returns (uint256 firstSlot)",
  "event SlotClaimed(bytes32 indexed eventId, uint256 slot, address indexed buyer, bytes32 orderRef)",
];

/** Per-call cap on the contract — keep in sync with WoCoEvent.batchClaimFor. */
export const ON_CHAIN_BATCH_MAX = 100;

const REGISTER_ABI = [
  "function registerEvent(uint256 supply, bytes32 manifestRef) returns (bytes32 eventId)",
  "event Registered(bytes32 indexed eventId, address indexed organiser, uint256 supply, bytes32 manifestRef)",
];

let _wallet: Wallet | null = null;

function getSponsorWallet(): Wallet {
  if (_wallet) return _wallet;
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
  const chainId = getActiveChainId();
  const url = getChainRpcUrl(chainId);
  const provider = new JsonRpcProvider(url);
  _wallet = new Wallet(pk, provider);
  return _wallet;
}

/** Generate a fresh ephemeral burner address. Private key is discarded immediately. */
export function generateBurnerAddress(): string {
  return Wallet.createRandom().address;
}

/**
 * Generate a fresh burner Wallet (with private key) so we can sign exactly one
 * per-ticket message before discarding it. Caller MUST drop the reference as
 * soon as the signature is produced — the key has no other purpose and never
 * touches disk or any persistent store. The address goes on-chain as
 * `slotOwner[eventId][slot]` and is the verifier's trust root.
 */
export function generateBurner(): HDNodeWallet {
  return Wallet.createRandom();
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

/**
 * Call WoCoEvent.batchClaimFor as the platform sponsor wallet.
 *
 * One tx allocates N contiguous slots, all sharing the same orderRef. Cuts
 * multi-ticket webhook latency from N sequential confirmations to one. Caller
 * is responsible for chunking orders larger than ON_CHAIN_BATCH_MAX into
 * multiple sequential calls (e.g. 200 tickets → 2 calls of 100).
 *
 * @param onChainEventId  0x-prefixed bytes32 event ID from registerEvent
 * @param burners         Per-ticket burner addresses (length 1..100)
 * @param orderRefBytes32 Shared "0x"+64-char Swarm hex ref of the encrypted order blob
 * @returns Array of 0-based slot indices in the same order as `burners`.
 */
export async function batchClaimForOnChain(
  onChainEventId: string,
  burners: string[],
  orderRefBytes32: string,
): Promise<number[]> {
  if (burners.length === 0) throw new Error("batchClaimForOnChain: empty burners");
  if (burners.length > ON_CHAIN_BATCH_MAX) {
    throw new Error(`batchClaimForOnChain: ${burners.length} exceeds cap ${ON_CHAIN_BATCH_MAX}`);
  }

  const chainId = getActiveChainId();
  const address = getWoCoEventAddress(chainId);
  if (!address) throw new Error(`No WoCoEvent contract on chain ${chainId}`);

  const wallet = getSponsorWallet();
  const contract = new Contract(address, CLAIM_ABI, wallet);

  console.log(
    `[sponsor] batchClaimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `n=${burners.length} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await contract.batchClaimFor(onChainEventId, burners, orderRefBytes32);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from batchClaimFor tx");

  console.log(
    `[sponsor] batchClaimFor confirmed txHash=${receipt.hash} ` +
    `gasUsed=${receipt.gasUsed} gasPerSlot=${(Number(receipt.gasUsed) / burners.length).toFixed(0)}`,
  );

  // Parse SlotClaimed events in receipt order. The contract emits them in
  // burner-index order, so `slots[i]` corresponds to `burners[i]`.
  const iface = new Interface(CLAIM_ABI);
  const slots: number[] = [];
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "SlotClaimed") {
        slots.push(Number(parsed.args.slot));
      }
    } catch {
      // skip unparseable logs from other contracts
    }
  }

  if (slots.length !== burners.length) {
    throw new Error(
      `batchClaimFor: expected ${burners.length} SlotClaimed events, got ${slots.length}`,
    );
  }
  return slots;
}

/**
 * Call WoCoEvent.registerEvent as the platform sponsor wallet.
 * Used so passkey/Para/email organisers don't need an EOA for event creation.
 *
 * @param supply         Total ticket supply for the series
 * @param manifestRef    "0x" + 64-char manifest digest hex
 * @returns on-chain eventId emitted in the Registered event
 */
export async function registerEventOnChain(
  supply: number,
  manifestRef: string,
): Promise<{ onChainEventId: string; txHash: string }> {
  const chainId = getActiveChainId();
  const address = getWoCoEventAddress(chainId);
  if (!address) throw new Error(`No WoCoEvent contract on chain ${chainId}`);

  const wallet = getSponsorWallet();
  const contract = new Contract(address, REGISTER_ABI, wallet);

  console.log(
    `[sponsor] registerEvent supply=${supply} manifestRef=${manifestRef.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await contract.registerEvent(supply, manifestRef);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from registerEvent tx");

  console.log(`[sponsor] registerEvent confirmed txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);

  const iface = new Interface(REGISTER_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "Registered") {
        const onChainEventId = parsed.args.eventId as string;
        console.log(`[sponsor] Registered onChainEventId=${onChainEventId}`);
        return { onChainEventId, txHash: receipt.hash };
      }
    } catch {
      // skip unparseable logs
    }
  }

  throw new Error("Registered event not found in registerEvent receipt");
}
