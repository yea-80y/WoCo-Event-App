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

export type EventContractVersion = "v1" | "v2" | "ledger";

/**
 * A MISCONFIGURATION, not a transient failure.
 *
 * Distinct class because callers that legitimately fail open on transient RPC
 * errors must NOT fail open on this one: `stripe/create-checkout` swallows
 * readiness errors so a flaky node cannot block sales, which would otherwise
 * mean a typo'd WOCO_EVENT_VERSION_* charges every buyer and refunds them at
 * fulfilment.
 */
export class EventContractConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventContractConfigError";
  }
}

/**
 * Exhaustiveness guard for version dispatch.
 *
 * Every `switch` on EventContractVersion below ends in a `default` that calls
 * this. The `never` parameter means adding a version to the union turns each
 * unhandled site into a COMPILE error rather than a silent fallthrough.
 *
 * This is not decoration. Before the ledger landed, dispatch was written as
 * `if (version === "v2") { … } else { …v1 path… }`, so a third version would
 * have degraded silently to V1 at every one of those sites — including
 * `walkChainRegistrations`, whose silent no-op reads as "registration absent"
 * and makes the #318 intent resolver re-register a landed event.
 */
export function unhandledVersion(v: never, context: string): never {
  throw new Error(`${context}: unhandled event-contract version ${JSON.stringify(v)}`);
}

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

/**
 * Deployed WoCoTicketLedger addresses. Override via
 * WOCO_EVENT_ADDRESS_LEDGER_{chainId}.
 *
 * EMPTY until the ledger is deployed — so setting
 * `WOCO_EVENT_VERSION_{chainId}=ledger` before then makes
 * `getWoCoEventAddress` return undefined and every caller throws
 * "No WoCoEvent contract deployed", which is the correct loud failure.
 */
const DEPLOYED_LEDGER: Record<number, string> = {};

/** Chain the server currently uses for event registration. Override via WOCO_EVENT_CHAIN_ID. */
export function getActiveChainId(): number {
  return parseInt(process.env.WOCO_EVENT_CHAIN_ID ?? "84532");
}

/**
 * Active contract version for a chain. UNSET defaults to "v1".
 *
 * An unrecognised NON-EMPTY value THROWS rather than falling back. It used to
 * fall back to "v1" silently, which meant a typo in
 * `WOCO_EVENT_VERSION_{chainId}` routed all traffic to the V1 contract with no
 * signal — the operator would see a working server pointed at the wrong
 * ledger. A misconfiguration must be loud; an absent config may have a default.
 */
export function getEventContractVersion(chainId: number): EventContractVersion {
  const v = process.env[`WOCO_EVENT_VERSION_${chainId}`];
  if (v === undefined || v === "") return "v1";
  if (v === "v1" || v === "v2" || v === "ledger") return v;
  throw new EventContractConfigError(
    `WOCO_EVENT_VERSION_${chainId}="${v}" is not a known contract version ` +
    `(expected "v1", "v2" or "ledger")`,
  );
}

export function getWoCoEventAddress(chainId: number): string | undefined {
  const version = getEventContractVersion(chainId);
  switch (version) {
    case "ledger":
      return process.env[`WOCO_EVENT_ADDRESS_LEDGER_${chainId}`] ?? DEPLOYED_LEDGER[chainId];
    case "v2":
      return process.env[`WOCO_EVENT_ADDRESS_V2_${chainId}`] ?? DEPLOYED_V2[chainId];
    case "v1":
      return process.env[`WOCO_EVENT_ADDRESS_${chainId}`] ?? DEPLOYED_V1[chainId];
    default:
      return unhandledVersion(version, "getWoCoEventAddress");
  }
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

/**
 * The registration counter that seeds `eventId` derivation, keyed by the
 * address that SUBMITS `registerEvent` (in production the sponsor wallet).
 *
 * Kept named "organiser" because `GET /api/events/organiser-nonce/:address` is
 * a public route the frontend calls; the ledger renamed the on-chain getter to
 * `registrantNonce`, which is the honest name for what it counts.
 */
export async function getOrganiserNonce(address: string, chainId: number): Promise<bigint> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  switch (c.version) {
    case "ledger": {
      const { getRegistrantNonceLedger } = await import("./event-contract-ledger.js");
      return getRegistrantNonceLedger(address, c.address, chainId);
    }
    case "v2": {
      const { getOrganiserNonceV2 } = await import("./event-contract-v2.js");
      return getOrganiserNonceV2(address, c.address, chainId);
    }
    case "v1":
      return getV1Contract(chainId, c.address).organiserNonce(address) as Promise<bigint>;
    default:
      return unhandledVersion(c.version, "getOrganiserNonce");
  }
}

export async function getSlotData(
  onChainEventId: string,
  slot: number,
  chainId: number,
): Promise<SlotData> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  switch (c.version) {
    case "ledger": {
      const { getSlotDataLedger } = await import("./event-contract-ledger.js");
      return getSlotDataLedger(onChainEventId, slot, c.address, chainId);
    }
    case "v2": {
      const { getSlotDataV2 } = await import("./event-contract-v2.js");
      return getSlotDataV2(onChainEventId, slot, c.address, chainId);
    }
    case "v1": {
      const result = await getV1Contract(chainId, c.address).getSlotData(onChainEventId, slot);
      return {
        owner: (result.owner as string).toLowerCase(),
        orderRef: result.orderRef as string,
      };
    }
    default:
      return unhandledVersion(c.version, "getSlotData");
  }
}

/**
 * The chain's registered sales end for a series (epoch seconds), or null when
 * there is no on-chain record of it. V1 predates `eventEndTs` entirely, so a
 * V1 deployment reads as "no on-chain end" rather than a fabricated one.
 * Transport failures throw — a caller treating them as "no constraint" would
 * re-open the #294 hole under an RPC blip.
 */
export async function getOnChainEventEnd(
  onChainEventId: string,
  chainId: number,
): Promise<number | null> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  switch (c.version) {
    case "ledger": {
      const { getOnChainEventEndLedger } = await import("./event-contract-ledger.js");
      return getOnChainEventEndLedger(onChainEventId, c.address, chainId);
    }
    case "v2": {
      const { getOnChainEventEndV2 } = await import("./event-contract-v2.js");
      return getOnChainEventEndV2(onChainEventId, c.address, chainId);
    }
    case "v1":
      // V1 predates `eventEndTs` entirely — "no on-chain end", not a fabricated one.
      return null;
    default:
      return unhandledVersion(c.version, "getOnChainEventEnd");
  }
}

export async function getOnChainEvent(
  onChainEventId: string,
  chainId: number,
): Promise<OnChainEvent | null> {
  const c = getDeployedContract(chainId);
  if (!c) throw new Error(`No WoCoEvent contract deployed on chain ${chainId}`);
  switch (c.version) {
    case "ledger": {
      const { getOnChainEventLedger } = await import("./event-contract-ledger.js");
      return getOnChainEventLedger(onChainEventId, c.address, chainId);
    }
    case "v2": {
      const { getOnChainEventV2 } = await import("./event-contract-v2.js");
      return getOnChainEventV2(onChainEventId, c.address, chainId);
    }
    case "v1": {
      const result = await getV1Contract(chainId, c.address).events(onChainEventId);
      if (result.totalSupply === 0n) return null;
      return {
        totalSupply: result.totalSupply,
        nextSlot: result.nextSlot,
        organiser: (result.organiser as string).toLowerCase(),
        manifestRef: result.manifestRef as string,
      };
    }
    default:
      return unhandledVersion(c.version, "getOnChainEvent");
  }
}

/**
 * Boot-time configuration check. Throws on a bad `WOCO_EVENT_VERSION_*`.
 *
 * MUST be called outside any catch during startup. The version parser throws by
 * design, but every runtime caller that reads it sits behind a handler that
 * either fails open (the checkout readiness gate) or logs and continues (the
 * boot readiness probe) — both correct for a flaky RPC, both wrong for a typo.
 * Without this, a misconfigured deploy runs, serves, and charges.
 */
export function assertEventContractConfig(): void {
  const chainId = getActiveChainId();
  const version = getEventContractVersion(chainId); // throws on an unknown value
  const address = getWoCoEventAddress(chainId);
  if (!address) {
    throw new EventContractConfigError(
      `No WoCoEvent contract address for chain ${chainId} at version "${version}". ` +
      `Set WOCO_EVENT_ADDRESS${version === "ledger" ? "_LEDGER" : version === "v2" ? "_V2" : ""}_${chainId}, ` +
      `or point WOCO_EVENT_VERSION_${chainId} at a deployed version.`,
    );
  }
  console.log(`[chain] event contract config OK — chain ${chainId} version "${version}" at ${address}`);
}
