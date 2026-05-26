import { JsonRpcProvider, Contract, Interface, Wallet } from "ethers";
import { getChainRpcUrl } from "./event-contract.js";
import type { OnChainEvent, SlotData } from "./event-contract.js";

/**
 * WoCoEventV2 (USDC-escrow) ABI. Reader views, sponsor-write surface, and
 * the V2 `SlotClaimed` event shape (3 indexed fields — V1 had 2, so the
 * topic hash differs and receipts need a separate `Interface`).
 *
 * V2 `registerEvent` takes extra args (price/payout/dropGate/eventEndTs).
 * Not wired here — event-creation path stays on V1 until the routes layer
 * is taught to pass those fields.
 */
const V2_READ_ABI = [
  "function organiserNonce(address) view returns (uint256)",
  "function getEvent(bytes32) view returns (uint64 totalSupply, uint64 nextSlot, uint128 priceBaseUnits, address organiser, address payoutRecipient, uint16 platformFeeBps, address dropGate, bytes32 manifestRef)",
  "function getSlotData(bytes32 eventId, uint256 slot) view returns (address owner, address claimer, bytes32 orderRef, bool escrowed, bool refunded)",
];

const V2_CLAIM_ABI = [
  "function claimFor(bytes32 eventId, address owner, bytes32 orderRef) returns (uint256 slot)",
  "function batchClaimFor(bytes32 eventId, address[] owners, bytes32 orderRef) returns (uint256 firstSlot)",
  "event SlotClaimed(bytes32 indexed eventId, uint256 indexed slot, address indexed owner, address claimer, bytes32 orderRef)",
];

export const V2_ABI = [...V2_READ_ABI, ...V2_CLAIM_ABI] as const;

const _providers = new Map<number, JsonRpcProvider>();

function getProvider(chainId: number): JsonRpcProvider {
  let p = _providers.get(chainId);
  if (!p) {
    p = new JsonRpcProvider(getChainRpcUrl(chainId));
    _providers.set(chainId, p);
  }
  return p;
}

function readContract(address: string, chainId: number): Contract {
  return new Contract(address, V2_READ_ABI, getProvider(chainId));
}

export async function getOrganiserNonceV2(
  address: string,
  contractAddress: string,
  chainId: number,
): Promise<bigint> {
  return readContract(contractAddress, chainId).organiserNonce(address) as Promise<bigint>;
}

export async function getOnChainEventV2(
  onChainEventId: string,
  contractAddress: string,
  chainId: number,
): Promise<OnChainEvent | null> {
  try {
    // ethers v6 reserves `Contract.getEvent` for event-fragment lookup, so
    // we go through `getFunction` to call the V2 view of the same name.
    const fn = readContract(contractAddress, chainId).getFunction("getEvent");
    const r = await fn.staticCall(onChainEventId);
    return {
      totalSupply: BigInt(r[0]),                   // totalSupply
      nextSlot:    BigInt(r[1]),                   // nextSlot
      organiser:   (r[3] as string).toLowerCase(), // organiser
      manifestRef: r[7] as string,                 // manifestRef
    };
  } catch {
    // V2 reverts `EventNotFound` when event doesn't exist. Caller treats null
    // as "no on-chain record yet" — same shape as the V1 path.
    return null;
  }
}

export async function getSlotDataV2(
  onChainEventId: string,
  slot: number,
  contractAddress: string,
  chainId: number,
): Promise<SlotData> {
  const r = await readContract(contractAddress, chainId).getSlotData(onChainEventId, slot);
  return {
    owner:    (r.owner as string).toLowerCase(),
    orderRef: r.orderRef as string,
  };
}

/**
 * Sponsor-path claim on V2. Same call signature as V1 (`claimFor(bytes32,
 * address, bytes32)`) — V2 reverts if `block.timestamp >= eventEndTs`, so
 * sponsor mints made after the event-end deadline will fail with
 * `SalesClosed`. That's enforced on-chain; the webhook surfaces the error.
 */
export async function claimForV2(
  onChainEventId: string,
  burnerAddress: string,
  orderRefBytes32: string,
  contractAddress: string,
  sponsorPk: string,
  chainId: number,
): Promise<number> {
  const wallet   = new Wallet(sponsorPk, getProvider(chainId));
  const contract = new Contract(contractAddress, V2_CLAIM_ABI, wallet);

  console.log(
    `[sponsor v2] claimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `burner=${burnerAddress} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await contract.claimFor(onChainEventId, burnerAddress, orderRefBytes32);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from V2 claimFor tx");

  console.log(`[sponsor v2] claimFor confirmed txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);

  return parseSlotClaimedSlots(receipt.logs, 1)[0];
}

export async function batchClaimForV2(
  onChainEventId: string,
  burners: string[],
  orderRefBytes32: string,
  contractAddress: string,
  sponsorPk: string,
  chainId: number,
): Promise<number[]> {
  if (burners.length === 0) throw new Error("batchClaimForV2: empty burners");

  const wallet   = new Wallet(sponsorPk, getProvider(chainId));
  const contract = new Contract(contractAddress, V2_CLAIM_ABI, wallet);

  console.log(
    `[sponsor v2] batchClaimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `n=${burners.length} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await contract.batchClaimFor(onChainEventId, burners, orderRefBytes32);
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from V2 batchClaimFor tx");

  console.log(
    `[sponsor v2] batchClaimFor confirmed txHash=${receipt.hash} ` +
    `gasUsed=${receipt.gasUsed} gasPerSlot=${(Number(receipt.gasUsed) / burners.length).toFixed(0)}`,
  );

  const slots = parseSlotClaimedSlots(receipt.logs, burners.length);
  if (slots.length !== burners.length) {
    throw new Error(
      `V2 batchClaimFor: expected ${burners.length} SlotClaimed events, got ${slots.length}`,
    );
  }
  return slots;
}

/**
 * V2 `SlotClaimed` topology: `(bytes32 eventId indexed, uint256 slot indexed,
 * address owner indexed, address claimer, bytes32 orderRef)`. The indexed
 * `slot` lives in topics[2] instead of `args.slot` from a non-indexed slot —
 * ethers' parseLog still surfaces it via `args.slot`, so we read uniformly.
 */
function parseSlotClaimedSlots(
  logs: ReadonlyArray<{ topics: readonly string[]; data: string }>,
  expectedCount: number,
): number[] {
  const iface = new Interface(V2_CLAIM_ABI);
  const out: number[] = [];
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "SlotClaimed") {
        out.push(Number(parsed.args.slot));
        if (out.length === expectedCount) break;
      }
    } catch {
      // skip logs from other contracts
    }
  }
  return out;
}
