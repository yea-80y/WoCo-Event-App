import { JsonRpcProvider, Contract } from "ethers";
import type { PaymentChainId } from "@woco/shared";
import { getRpcUrl } from "../payment/constants.js";

const ABI = [
  "function organiserNonce(address) view returns (uint256)",
  "function events(bytes32) view returns (uint256 totalSupply, uint256 nextSlot, address organiser, bytes32 manifestRef)",
  "function getSlotData(bytes32 eventId, uint256 slot) view returns (address owner, bytes32 orderRef)",
];

/** Deployed WoCoEvent addresses by chainId. Override via WOCO_EVENT_ADDRESS_{chainId} env. */
const DEPLOYED: Record<number, string> = {
  84532: "0x4bf8aa0FDaF5045EFEd675e019F81316063c94b4", // Base Sepolia (redeployed 2026-05-09 — adds slotOrderRef storage + getSlotData)
};

/** Chain the server currently uses for event registration. Override via WOCO_EVENT_CHAIN_ID. */
export function getActiveChainId(): number {
  return parseInt(process.env.WOCO_EVENT_CHAIN_ID ?? "84532");
}

export function getWoCoEventAddress(chainId: number): string | undefined {
  return process.env[`WOCO_EVENT_ADDRESS_${chainId}`] ?? DEPLOYED[chainId];
}

const _providers = new Map<number, JsonRpcProvider>();

function getProvider(chainId: number): JsonRpcProvider {
  let p = _providers.get(chainId);
  if (!p) {
    const url = getRpcUrl(chainId as PaymentChainId);
    p = new JsonRpcProvider(url);
    _providers.set(chainId, p);
  }
  return p;
}

function getContract(chainId: number): Contract {
  const address = getWoCoEventAddress(chainId);
  if (!address) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  return new Contract(address, ABI, getProvider(chainId));
}

export async function getOrganiserNonce(address: string, chainId: number): Promise<bigint> {
  return getContract(chainId).organiserNonce(address) as Promise<bigint>;
}

export interface OnChainEvent {
  totalSupply: bigint;
  nextSlot: bigint;
  organiser: string; // lowercased
  manifestRef: string; // 0x-prefixed bytes32
}

export interface SlotData {
  owner: string;    // address (lowercased)
  orderRef: string; // 0x-prefixed bytes32
}

export async function getSlotData(
  onChainEventId: string,
  slot: number,
  chainId: number,
): Promise<SlotData> {
  const result = await getContract(chainId).getSlotData(onChainEventId, slot);
  return {
    owner: (result.owner as string).toLowerCase(),
    orderRef: result.orderRef as string,
  };
}

export async function getOnChainEvent(
  onChainEventId: string,
  chainId: number,
): Promise<OnChainEvent | null> {
  const result = await getContract(chainId).events(onChainEventId);
  if (result.totalSupply === 0n) return null;
  return {
    totalSupply: result.totalSupply,
    nextSlot: result.nextSlot,
    organiser: (result.organiser as string).toLowerCase(),
    manifestRef: result.manifestRef as string,
  };
}
