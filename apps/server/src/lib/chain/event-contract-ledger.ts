import { JsonRpcProvider, Contract, Interface, Wallet, id } from "ethers";
import { getChainRpcUrl } from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";
import type { OnChainEvent, SlotData } from "./event-contract.js";

/**
 * WoCoTicketLedger ABI — the allocation ledger with payments removed.
 *
 * Successor to WoCoEventV2 (WoCo-Contracts `5b1d67c`). What changed, and why
 * this is a separate module rather than an edit to event-contract-v2.ts: V2 is
 * still deployed on Arb Sepolia and production points at it until the env flips,
 * so both surfaces must be readable at once.
 *
 *   registerEvent  — now (organiser, supply, manifestRef, eventEndTs). The
 *                    price/payout/dropGate args are gone with the payment code,
 *                    and `organiser` is NEW: it used to be `msg.sender`, which
 *                    in production is the SPONSOR WALLET, so the real organiser
 *                    only ever existed in `payoutRecipient` — a payments field
 *                    that left with the rest.
 *   getEvent       — 4 fields, was 8.
 *   getEventStatus — (eventEndTs, cancelled), was 6 fields.
 *   getSlotData    — (owner, claimer, orderRef); the escrowed/refunded flags
 *                    were payments state.
 *   registrantNonce — renamed from `organiserNonce`; it counts registrations by
 *                    msg.sender and became a misnomer once organiser stopped
 *                    being msg.sender.
 *
 * UNCHANGED, deliberately: `claimFor`, `batchClaimFor` and the `SlotClaimed`
 * event are byte-identical to V2, so the claim ABI and receipt parsing are the
 * same shape. Keep them that way — the fulfilment path is the hottest code here.
 */
const LEDGER_READ_ABI = [
  "function registrantNonce(address) view returns (uint256)",
  "function getEvent(bytes32) view returns (uint64 totalSupply, uint64 nextSlot, address organiser, bytes32 manifestRef)",
  "function getEventStatus(bytes32) view returns (uint64 eventEndTs, bool cancelled)",
  "function getSlotData(bytes32 eventId, uint256 slot) view returns (address owner, address claimer, bytes32 orderRef)",
  "function authorisedSponsors(address) view returns (bool)",
  "function remaining(bytes32) view returns (uint256)",
  // Declared so ethers decodes the revert — getOnChainEventLedger keys on its name.
  "error EventNotFound()",
];

/** Identical to V2's claim surface. Same selectors, same SlotClaimed topics. */
const LEDGER_CLAIM_ABI = [
  "function claimFor(bytes32 eventId, address owner, bytes32 orderRef) returns (uint256 slot)",
  "function batchClaimFor(bytes32 eventId, address[] owners, bytes32 orderRef) returns (uint256 firstSlot)",
  "event SlotClaimed(bytes32 indexed eventId, uint256 indexed slot, address indexed owner, address claimer, bytes32 orderRef)",
];

const LEDGER_REGISTER_ABI = [
  "function registerEvent(address organiser, uint64 supply, bytes32 manifestRef, uint64 eventEndTs) returns (bytes32 eventId)",
  "event Registered(bytes32 indexed eventId, address indexed organiser, address indexed registrant, uint64 supply, bytes32 manifestRef, uint64 eventEndTs)",
];

export const LEDGER_ABI = [
  ...LEDGER_READ_ABI,
  ...LEDGER_CLAIM_ABI,
  ...LEDGER_REGISTER_ABI,
] as const;

/** Computed, never hardcoded — same error name as V2, so the same selector. */
const EVENT_NOT_FOUND_SELECTOR = id("EventNotFound()").slice(0, 10);

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
  return new Contract(address, LEDGER_READ_ABI, getProvider(chainId));
}

export async function getRegistrantNonceLedger(
  address: string,
  contractAddress: string,
  chainId: number,
): Promise<bigint> {
  return readContract(contractAddress, chainId).registrantNonce(address) as Promise<bigint>;
}

export async function isSponsorAuthorisedLedger(
  sponsorAddress: string,
  contractAddress: string,
  chainId: number,
): Promise<boolean> {
  return readContract(contractAddress, chainId).authorisedSponsors(sponsorAddress) as Promise<boolean>;
}

/**
 * Core event params. `null` means EXACTLY `EventNotFound()`; every other
 * failure throws — callers (delete-safety in event/service.ts, availability,
 * gate tiers) rely on that, because a transport failure read as "0 claimed"
 * would let a sold-out event be deleted or a closed gate open.
 *
 * Fields are read BY NAME, not by index. The V2 reader destructured
 * positionally (r[3] → organiser, r[7] → manifestRef); when the view shrank
 * from 8 fields to 4 those indices silently pointed at different data with no
 * type error. Do not reintroduce positional reads here.
 */
export async function getOnChainEventLedger(
  onChainEventId: string,
  contractAddress: string,
  chainId: number,
): Promise<OnChainEvent | null> {
  try {
    // ethers v6 reserves `Contract.getEvent` for event-fragment lookup, so go
    // through `getFunction` to reach the view of the same name.
    const fn = readContract(contractAddress, chainId).getFunction("getEvent");
    const r = await fn.staticCall(onChainEventId);
    return {
      totalSupply: BigInt(r.totalSupply),
      nextSlot:    BigInt(r.nextSlot),
      organiser:   (r.organiser as string).toLowerCase(),
      manifestRef: r.manifestRef as string,
    };
  } catch (err) {
    const e = err as { revert?: { name?: string } | null; data?: unknown };
    if (e?.revert?.name === "EventNotFound") return null;
    if (typeof e?.data === "string" && e.data.toLowerCase() === EVENT_NOT_FOUND_SELECTOR) {
      return null;
    }
    throw err;
  }
}

/**
 * The contract's registered sales end (`eventEndTs`, epoch seconds) — set once
 * at `registerEvent` and IMMUTABLE (the ledger has no setter), which is why
 * #294 exists: the feed's `endDate` can be edited, this cannot. `null` means
 * exactly `EventNotFound()`; every other failure throws.
 */
export async function getOnChainEventEndLedger(
  onChainEventId: string,
  contractAddress: string,
  chainId: number,
): Promise<number | null> {
  try {
    const fn = readContract(contractAddress, chainId).getFunction("getEventStatus");
    const r = await fn.staticCall(onChainEventId);
    return Number(r.eventEndTs);
  } catch (err) {
    const e = err as { revert?: { name?: string } | null; data?: unknown };
    if (e?.revert?.name === "EventNotFound") return null;
    if (typeof e?.data === "string" && e.data.toLowerCase() === EVENT_NOT_FOUND_SELECTOR) {
      return null;
    }
    throw err;
  }
}

/**
 * Whether the event has been cancelled on chain. The ledger's `cancelled` flag
 * is one-way and stops all further minting; a future payments contract reads it
 * to open refunds. No V2 equivalent is exposed here because nothing consumed it.
 */
export async function isEventCancelledLedger(
  onChainEventId: string,
  contractAddress: string,
  chainId: number,
): Promise<boolean | null> {
  try {
    const fn = readContract(contractAddress, chainId).getFunction("getEventStatus");
    const r = await fn.staticCall(onChainEventId);
    return Boolean(r.cancelled);
  } catch (err) {
    const e = err as { revert?: { name?: string } | null; data?: unknown };
    if (e?.revert?.name === "EventNotFound") return null;
    if (typeof e?.data === "string" && e.data.toLowerCase() === EVENT_NOT_FOUND_SELECTOR) {
      return null;
    }
    throw err;
  }
}

export async function getSlotDataLedger(
  onChainEventId: string,
  slot: number,
  contractAddress: string,
  chainId: number,
): Promise<SlotData> {
  const r = await readContract(contractAddress, chainId).getSlotData(onChainEventId, slot);
  // `owner == 0` means the slot is unclaimed. The other two fields are then the
  // batch-0 claimer/orderRef rather than zeroes (batchFirstSlot defaults to 0),
  // so they must not be read in that case — see the contract's natspec.
  return {
    owner:    (r.owner as string).toLowerCase(),
    orderRef: r.orderRef as string,
  };
}

/**
 * All on-chain slot indices currently owned by `owner` — the TRUSTLESS holdings
 * source for POD gating. Reads `SlotClaimed` logs filtered by the indexed
 * `(eventId, owner)` topics. Same event topology as V2.
 */
export async function querySlotsOwnedLedger(
  onChainEventId: string,
  owner: string,
  contractAddress: string,
  chainId: number,
): Promise<number[]> {
  const contract = new Contract(contractAddress, LEDGER_CLAIM_ABI, getProvider(chainId));
  const filter = contract.filters.SlotClaimed(onChainEventId, null, owner);
  const logs = await contract.queryFilter(filter);
  const slots = new Set<number>();
  for (const log of logs) {
    const args = (log as unknown as { args?: { slot?: bigint } }).args;
    if (args?.slot != null) slots.add(Number(args.slot));
  }
  return [...slots].sort((a, b) => a - b);
}

/**
 * Sponsor-path claim. The ledger reverts `SalesClosed` at or after
 * `eventEndTs`, so a sponsor mint made past the deadline fails on chain and the
 * webhook surfaces the error.
 */
export async function claimForLedger(
  onChainEventId: string,
  burnerAddress: string,
  orderRefBytes32: string,
  contractAddress: string,
  sponsorPk: string,
  chainId: number,
): Promise<number> {
  const wallet   = new Wallet(sponsorPk, getProvider(chainId));
  const contract = new Contract(contractAddress, LEDGER_CLAIM_ABI, wallet);

  console.log(
    `[sponsor ledger] claimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `burner=${burnerAddress} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "claimFor" },
    (o) => contract.claimFor(onChainEventId, burnerAddress, orderRefBytes32, o),
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from ledger claimFor tx");

  console.log(`[sponsor ledger] claimFor confirmed txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);

  return parseSlotClaimedSlots(receipt.logs, 1)[0];
}

export async function batchClaimForLedger(
  onChainEventId: string,
  burners: string[],
  orderRefBytes32: string,
  contractAddress: string,
  sponsorPk: string,
  chainId: number,
): Promise<number[]> {
  if (burners.length === 0) throw new Error("batchClaimForLedger: empty burners");

  const wallet   = new Wallet(sponsorPk, getProvider(chainId));
  const contract = new Contract(contractAddress, LEDGER_CLAIM_ABI, wallet);

  console.log(
    `[sponsor ledger] batchClaimFor eventId=${onChainEventId.slice(0, 10)}… ` +
    `n=${burners.length} orderRef=${orderRefBytes32.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "batchClaimFor" },
    (o) => contract.batchClaimFor(onChainEventId, burners, orderRefBytes32, o),
  );
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from ledger batchClaimFor tx");

  console.log(
    `[sponsor ledger] batchClaimFor confirmed txHash=${receipt.hash} ` +
    `gasUsed=${receipt.gasUsed} gasPerSlot=${(Number(receipt.gasUsed) / burners.length).toFixed(0)}`,
  );

  const slots = parseSlotClaimedSlots(receipt.logs, burners.length);
  if (slots.length !== burners.length) {
    throw new Error(
      `ledger batchClaimFor: expected ${burners.length} SlotClaimed events, got ${slots.length}`,
    );
  }
  return slots;
}

/**
 * Register an event via the sponsor wallet.
 *
 * `organiser` is stamped explicitly and is NOT the caller: the caller is this
 * sponsor wallet. Pass the real organiser (the feed's creator address) —
 * passing the sponsor here would recreate exactly the V2 defect this parameter
 * exists to fix, and the field is immutable once stamped.
 *
 * The contract reverts `InvalidEventEnd` unless `eventEndTs > block.timestamp`,
 * so callers must floor it above now.
 */
export async function registerEventLedger(
  organiser: string,
  supply: number,
  manifestRef: string,
  eventEndTs: number,
  contractAddress: string,
  sponsorPk: string,
  chainId: number,
  onTxSent?: (tx: { txHash: string; nonce: number; chainId: number }) => void,
  onTxReserved?: (r: { nonce: number; chainId: number }) => void,
): Promise<{ onChainEventId: string; txHash: string }> {
  const wallet   = new Wallet(sponsorPk, getProvider(chainId));
  const contract = new Contract(contractAddress, LEDGER_REGISTER_ABI, wallet);

  console.log(
    `[sponsor ledger] registerEvent organiser=${organiser} supply=${supply} ` +
    `eventEndTs=${eventEndTs} manifestRef=${manifestRef.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "registerEvent" },
    (o) => {
      // Journal the intent BEFORE the node sees the tx — a throw aborts the
      // send (#318). Inside the closure so a nonce re-sync retry re-journals
      // the corrected nonce.
      onTxReserved?.({ nonce: o.nonce, chainId });
      return contract.registerEvent(organiser, supply, manifestRef, eventEndTs, o);
    },
  );
  // Durably mark the tx as broadcast BEFORE awaiting it: everything from here to
  // the caller's confirmation write is a window in which a crash or a client
  // retry could otherwise re-send, and registerEvent is not idempotent.
  onTxSent?.({ txHash: tx.hash, nonce: tx.nonce, chainId });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt from ledger registerEvent tx");

  console.log(`[sponsor ledger] registerEvent confirmed txHash=${receipt.hash} gasUsed=${receipt.gasUsed}`);

  const iface = new Interface(LEDGER_REGISTER_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "Registered") {
        const onChainEventId = parsed.args.eventId as string;
        console.log(`[sponsor ledger] Registered onChainEventId=${onChainEventId}`);
        return { onChainEventId, txHash: receipt.hash };
      }
    } catch {
      // skip logs from other contracts
    }
  }

  throw new Error("Registered event not found in ledger registerEvent receipt");
}

function parseSlotClaimedSlots(
  logs: ReadonlyArray<{ topics: readonly string[]; data: string }>,
  expectedCount: number,
): number[] {
  const iface = new Interface(LEDGER_CLAIM_ABI);
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
