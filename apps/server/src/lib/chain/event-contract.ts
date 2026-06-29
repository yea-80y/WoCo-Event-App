import { JsonRpcProvider, Contract } from "ethers";
import type { PaymentChainId } from "@woco/shared";
import { getRpcUrl } from "../payment/constants.js";

/** RPC URLs for chains used by WoCoEvent but outside PaymentChainId (e.g. L2 testnets). */
const EXTRA_RPC_URLS: Record<number, string> = {
  84532: "https://sepolia.base.org", // Base Sepolia
};
// NOTE: Arbitrum One (42161) + Arbitrum Sepolia (421614) live in shared PaymentChainId
// and resolve through getRpcUrl() — no extra entry needed here.

export function getChainRpcUrl(chainId: number): string {
  return (
    process.env[`RPC_URL_${chainId}`] ??
    EXTRA_RPC_URLS[chainId] ??
    getRpcUrl(chainId as PaymentChainId)
  );
}

// ── Contract version dispatch ─────────────────────────────────────────────────
// V1 (WoCoEvent) and V2 (WoCoEventV2 — USDC-escrow) coexist on Arbitrum Sepolia.
// Default is V1 everywhere — V2 is opt-in via `WOCO_EVENT_VERSION_{chainId}=v2`
// so the production runtime stays unchanged until explicitly flipped.

export type EventContractVersion = "v1" | "v2";

const ABI_V1 = [
  "function organiserNonce(address) view returns (uint256)",
  "function events(bytes32) view returns (uint256 totalSupply, uint256 nextSlot, address organiser, bytes32 manifestRef)",
  "function getSlotData(bytes32 eventId, uint256 slot) view returns (address owner, bytes32 orderRef)",
];

/** Deployed WoCoEvent V1 addresses by chainId. Override via WOCO_EVENT_ADDRESS_{chainId} env. */
const DEPLOYED_V1: Record<number, string> = {
  84532: "0x00824e220571D09d1C3D9B68A8F4c5423D166780",  // Base Sepolia (redeployed 2026-05-12 — adds batchClaimFor + per-batch orderRef storage)
  421614: "0x172031E6a8428617B05F2002e0e278bb8fb3Ed8A", // Arbitrum Sepolia (Arbitrum buildathon, deployed 2026-05-26)
};

/** Deployed WoCoEventV2 (USDC-escrow) addresses. Override via WOCO_EVENT_ADDRESS_V2_{chainId}. */
const DEPLOYED_V2: Record<number, string> = {
  421614: "0x351070Aff6dECa449506a6eA6dC6cB84D13cAedf", // Arbitrum Sepolia (deployed 2026-05-26)
};

/** Chain the server currently uses for event registration. Override via WOCO_EVENT_CHAIN_ID. */
export function getActiveChainId(): number {
  return parseInt(process.env.WOCO_EVENT_CHAIN_ID ?? "84532");
}

/**
 * Active contract version for a chain. Defaults to "v1" everywhere — flipping
 * to V2 is opt-in via the env so the V2 contract sits dormant until the
 * operator is ready (event creation path also needs V2 register wiring first).
 */
export function getEventContractVersion(chainId: number): EventContractVersion {
  const v = process.env[`WOCO_EVENT_VERSION_${chainId}`];
  if (v === "v2" || v === "v1") return v;
  return "v1";
}

export function getWoCoEventAddress(chainId: number): string | undefined {
  const version = getEventContractVersion(chainId);
  if (version === "v2") {
    return process.env[`WOCO_EVENT_ADDRESS_V2_${chainId}`] ?? DEPLOYED_V2[chainId];
  }
  return process.env[`WOCO_EVENT_ADDRESS_${chainId}`] ?? DEPLOYED_V1[chainId];
}

export interface DeployedContract {
  address: string;
  version: EventContractVersion;
}

/** Convenience: address + version in one lookup. Undefined if no contract on chain. */
export function getDeployedContract(chainId: number): DeployedContract | undefined {
  const version = getEventContractVersion(chainId);
  const address = getWoCoEventAddress(chainId);
  if (!address) return undefined;
  return { address, version };
}

const _providers = new Map<number, JsonRpcProvider>();

function getProvider(chainId: number): JsonRpcProvider {
  let p = _providers.get(chainId);
  if (!p) {
    const url = getChainRpcUrl(chainId);
    p = new JsonRpcProvider(url);
    // ethers v6 defaults pollingInterval to 4000ms, so tx.wait(1) can't resolve
    // faster than ~4s even on an L2 that mines sub-second. Poll tighter — the
    // dominant cost in the on-chain register/claim step was this, not the chain.
    p.pollingInterval = 500;
    _providers.set(chainId, p);
  }
  return p;
}

function getV1Contract(chainId: number, address: string): Contract {
  return new Contract(address, ABI_V1, getProvider(chainId));
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

export async function getOrganiserNonce(address: string, chainId: number): Promise<bigint> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  if (c.version === "v2") {
    const { getOrganiserNonceV2 } = await import("./event-contract-v2.js");
    return getOrganiserNonceV2(address, c.address, chainId);
  }
  return getV1Contract(chainId, c.address).organiserNonce(address) as Promise<bigint>;
}

export async function getSlotData(
  onChainEventId: string,
  slot: number,
  chainId: number,
): Promise<SlotData> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  if (c.version === "v2") {
    const { getSlotDataV2 } = await import("./event-contract-v2.js");
    return getSlotDataV2(onChainEventId, slot, c.address, chainId);
  }
  const result = await getV1Contract(chainId, c.address).getSlotData(onChainEventId, slot);
  return {
    owner: (result.owner as string).toLowerCase(),
    orderRef: result.orderRef as string,
  };
}

export async function getOnChainEvent(
  onChainEventId: string,
  chainId: number,
): Promise<OnChainEvent | null> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  if (c.version === "v2") {
    const { getOnChainEventV2 } = await import("./event-contract-v2.js");
    return getOnChainEventV2(onChainEventId, c.address, chainId);
  }
  const result = await getV1Contract(chainId, c.address).events(onChainEventId);
  if (result.totalSupply === 0n) return null;
  return {
    totalSupply: result.totalSupply,
    nextSlot: result.nextSlot,
    organiser: (result.organiser as string).toLowerCase(),
    manifestRef: result.manifestRef as string,
  };
}
