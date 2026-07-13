import { Wallet, HDNodeWallet, Contract, Interface, JsonRpcProvider } from "ethers";
import {
  getActiveChainId,
  getWoCoEventAddress,
  getChainRpcUrl,
  getEventContractVersion,
} from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";
import {
  claimForV2,
  batchClaimForV2,
  registerEventV2,
  isSponsorAuthorisedV2,
} from "./event-contract-v2.js";

/** V2 registerEvent params not present in the V1 2-arg call. */
export interface RegisterV2Params {
  /** Per-ticket price in payment-token base units. Stripe path = 0n. */
  priceBaseUnits: bigint;
  /** Receives escrowed funds at withdraw time (the organiser). */
  payoutRecipient: string;
  /** Optional gate contract; address(0) = open FIFO. */
  dropGate: string;
  /** UNIX seconds sales cutoff; MUST be > now (contract reverts otherwise). */
  eventEndTs: number;
}

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
  // Tighten tx.wait(1) polling — ethers v6 defaults to 4000ms, which was most of
  // the registerEvent/batchClaim latency on a sub-second L2. See event-contract.ts.
  provider.pollingInterval = 500;
  _wallet = new Wallet(pk, provider);
  return _wallet;
}

/** Generate a fresh ephemeral burner address. Private key is discarded immediately. */
export function generateBurnerAddress(): string {
  return Wallet.createRandom().address;
}

/** Public address of the platform sponsor wallet (no provider needed). */
export function getSponsorAddress(): string {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
  return new Wallet(pk).address;
}

// Sponsor authorisation is a config invariant that only changes via an owner
// addSponsor/removeSponsor tx, so a confirmed-ready result is cached. Only the
// positive is cached — a negative is a fixable misconfig we want to re-detect
// promptly (e.g. right after the owner runs addSponsor).
const SPONSOR_READY_TTL_MS = 10 * 60 * 1000;
let _sponsorReady: { chainId: number; expires: number } | null = null;

/**
 * Whether the sponsor wallet can actually mint on the active contract. V1 uses
 * a different (deploy-time) authorisation model and is treated as always ready;
 * V2 gates `claimFor`/`batchClaimFor` behind `authorisedSponsors`, so an
 * unauthorised sponsor would make every paid claim revert `NotAuthorised`.
 *
 * Throws on RPC failure (caller decides fail-open vs fail-closed). A definitive
 * `false` means the sponsor is genuinely not on the allow-list.
 */
export async function isSponsorReady(chainId: number): Promise<boolean> {
  if (getEventContractVersion(chainId) !== "v2") return true;

  const now = Date.now();
  if (_sponsorReady && _sponsorReady.chainId === chainId && _sponsorReady.expires > now) {
    return true;
  }

  const address = getWoCoEventAddress(chainId);
  if (!address) return false;

  const ready = await isSponsorAuthorisedV2(getSponsorAddress(), address, chainId);
  if (ready) _sponsorReady = { chainId, expires: now + SPONSOR_READY_TTL_MS };
  return ready;
}

/**
 * Boot-time readiness probe. Logs loudly if the sponsor can't mint on the
 * active contract so a misconfigured deploy is caught immediately rather than
 * at the first (charged-then-refunded) purchase. Never throws — purely
 * advisory; the create-checkout gate is the hard guard.
 */
export async function logSponsorReadiness(): Promise<void> {
  const chainId = getActiveChainId();
  try {
    const ready = await isSponsorReady(chainId);
    if (ready) {
      console.log(`[sponsor] readiness OK — authorised to mint on chain ${chainId}`);
    } else {
      console.error(
        `[sponsor] NOT AUTHORISED on chain ${chainId} contract ${getWoCoEventAddress(chainId)} — ` +
        `paid checkouts will be refused. Owner must call addSponsor(${getSponsorAddress()}).`,
      );
    }
  } catch (err) {
    console.warn(`[sponsor] readiness probe failed on chain ${chainId} (RPC?):`, err);
  }
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

  if (getEventContractVersion(chainId) === "v2") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    return claimForV2(onChainEventId, burnerAddress, orderRefBytes32, address, pk, chainId);
  }

  const wallet = getSponsorWallet();
  const contract = new Contract(address, CLAIM_ABI, wallet);

  console.log(
    `[sponsor] claimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `burner=${burnerAddress} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "v1.claimFor" },
    (o) => contract.claimFor(onChainEventId, burnerAddress, orderRefBytes32, o),
  );
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

  if (getEventContractVersion(chainId) === "v2") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    return batchClaimForV2(onChainEventId, burners, orderRefBytes32, address, pk, chainId);
  }

  const wallet = getSponsorWallet();
  const contract = new Contract(address, CLAIM_ABI, wallet);

  console.log(
    `[sponsor] batchClaimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `n=${burners.length} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "v1.batchClaimFor" },
    (o) => contract.batchClaimFor(onChainEventId, burners, orderRefBytes32, o),
  );
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
 * @param v2Params       Required when the active chain runs the V2 contract
 *                       (6-arg registerEvent); ignored on V1 chains.
 * @returns on-chain eventId emitted in the Registered event
 */
export async function registerEventOnChain(
  supply: number,
  manifestRef: string,
  v2Params?: RegisterV2Params,
): Promise<{ onChainEventId: string; txHash: string }> {
  const chainId = getActiveChainId();
  const address = getWoCoEventAddress(chainId);
  if (!address) throw new Error(`No WoCoEvent contract on chain ${chainId}`);

  if (getEventContractVersion(chainId) === "v2") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    if (!v2Params) {
      throw new Error(`registerEventOnChain: chain ${chainId} runs V2 but no v2Params supplied`);
    }
    return registerEventV2(
      supply,
      v2Params.priceBaseUnits,
      v2Params.payoutRecipient,
      v2Params.dropGate,
      manifestRef,
      v2Params.eventEndTs,
      address,
      pk,
      chainId,
    );
  }

  const wallet = getSponsorWallet();
  const contract = new Contract(address, REGISTER_ABI, wallet);

  console.log(
    `[sponsor] registerEvent supply=${supply} manifestRef=${manifestRef.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "v1.registerEvent" },
    (o) => contract.registerEvent(supply, manifestRef, o),
  );
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
