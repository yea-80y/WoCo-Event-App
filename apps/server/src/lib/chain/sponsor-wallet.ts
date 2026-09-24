import { Wallet, HDNodeWallet, Contract, Interface, JsonRpcProvider } from "ethers";
import {
  getActiveChainId,
  getChainRpcUrl,
  getEventContractVersion,
  getDefaultEventContract,
  contractKey,
  EventContractConfigError,
} from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";
import {
  claimForV2,
  batchClaimForV2,
  registerEventV2,
  isSponsorAuthorisedV2,
  V2_ABI,
} from "./event-contract-v2.js";
import {
  LEDGER_ABI,
  LEDGER_UNLIMITED_MINTS,
  isNotThisAbi,
  type SponsorMintAllowance,
} from "./event-contract-ledger.js";
import { unhandledVersion } from "./event-contract.js";
import type { EventContractVersion, EventContractTarget } from "./event-contract.js";

/**
 * Fragment set carrying the `Registered` event for a given contract version.
 *
 * The topic differs per version — V2 carries the escrow config, the ledger
 * carries `registrant` — so parsing a receipt with the wrong set matches
 * NOTHING and reports a landed registration as absent, which is how the #318
 * resolver ends up broadcasting a duplicate.
 */
function registeredFragmentsFor(v: EventContractVersion): readonly string[] {
  switch (v) {
    case "ledger": return LEDGER_ABI;
    case "v2":     return V2_ABI;
    case "v1":     return REGISTER_ABI;
    default:       return unhandledVersion(v, "registeredFragmentsFor");
  }
}

/**
 * registerEvent params not present in the V1 2-arg call. Consumed differently
 * per version — the field comments say which contract reads what.
 */
export interface RegisterEventParams {
  /**
   * The event's owner of record, stamped on chain by the LEDGER.
   *
   * Required, and it must be the real organiser (the feed's creator address) —
   * NOT the sponsor wallet. On V2 the on-chain `organiser` was `msg.sender`,
   * i.e. the sponsor, which is exactly the defect the ledger's explicit
   * parameter exists to fix. Passing the sponsor here would recreate it, and
   * the field is immutable once stamped.
   *
   * Ignored by V1 and V2.
   */
  organiser: string;
  /** Sales cutoff, UNIX seconds. MUST be > now (both V2 and the ledger revert
   *  `InvalidEventEnd` otherwise). Read by V2 and the ledger. */
  eventEndTs: number;
  /** V2 ONLY — per-ticket price in payment-token base units. Stripe path = 0n.
   *  The ledger holds no funds and has no concept of price. */
  priceBaseUnits: bigint;
  /** V2 ONLY — receives escrowed funds at withdraw time. Gone from the ledger
   *  along with the rest of the payment surface; `organiser` replaces its role
   *  as the on-chain record of who the event belongs to. */
  payoutRecipient: string;
  /** V2 ONLY — optional gate contract; address(0) = open FIFO. Removed from
   *  the ledger, which never consulted it on the sponsor path anyway. */
  dropGate: string;
}

/** @deprecated Name kept so existing imports keep compiling. Use RegisterEventParams. */
export type RegisterV2Params = RegisterEventParams;

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

const _wallets = new Map<number, Wallet>();

/** Per chain: a registration recorded on another chain still mints there (#563). */
function getSponsorWallet(chainId: number = getActiveChainId()): Wallet {
  const cached = _wallets.get(chainId);
  if (cached) return cached;
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
  const url = getChainRpcUrl(chainId);
  const provider = new JsonRpcProvider(url);
  // Tighten tx.wait(1) polling — ethers v6 defaults to 4000ms, which was most of
  // the registerEvent/batchClaim latency on a sub-second L2. See event-contract.ts.
  provider.pollingInterval = 500;
  const wallet = new Wallet(pk, provider);
  _wallets.set(chainId, wallet);
  return wallet;
}

/** The env-selected contract, or the loud failure every mint/register path gives. */
function defaultTargetOrThrow(): EventContractTarget {
  const chainId = getActiveChainId();
  const t = getDefaultEventContract(chainId);
  if (!t) throw new Error(`No WoCoEvent contract on chain ${chainId}`);
  return t;
}

/**
 * Called the moment a sponsor tx is broadcast — BEFORE it is awaited. Lets the
 * caller durably record "this tx exists" so a crash or retry during the
 * confirmation window can resolve it instead of sending a second one.
 */
export type SponsorTxSent = (tx: { txHash: string; nonce: number; chainId: number }) => void;

/**
 * Called with the reserved nonce BEFORE the tx is handed to the node (#318).
 * This is the caller's chance to journal the intent durably — and a THROW here
 * ABORTS the broadcast, which is the point: an unjournalled registerEvent is
 * one a crash can silently duplicate. Runs inside the nonce queue's send
 * closure, so a nonce re-sync retry re-invokes it with the corrected nonce.
 */
export type SponsorTxReserved = (r: { nonce: number; chainId: number }) => void;

/** Fate of a previously-broadcast registerEvent tx. */
export type RegisterTxOutcome =
  /** Mined and the Registered log is in the receipt — the registration HAPPENED. */
  | { status: "registered"; onChainEventId: string; txHash: string }
  /** Mined but reverted — no registration; safe to broadcast a replacement. */
  | { status: "reverted" }
  /** The nonce was consumed by a different tx, so this one can never mine. */
  | { status: "replaced" }
  /** Still in the mempool — it MAY yet mine, so it must NOT be re-broadcast. */
  | { status: "pending" };

/**
 * Decide the fate of an already-broadcast registerEvent tx WITHOUT sending anything.
 *
 * The rule this enforces: never re-send a tx that might be in flight. The contract
 * derives its eventId from a sponsor-nonce counter (WoCoEventV2.sol:247), not from
 * the manifest, so a duplicate send is not idempotent — it mints a second on-chain
 * event with its own supply.
 *
 * "replaced" is deliberately conservative. A confirmed sponsor nonce past this tx's
 * nonce proves the slot was taken by something else, but an RPC whose head is ahead
 * of its receipt index would look identical for an instant, so the receipt is re-read
 * after a short delay before we commit to that answer. Anything still ambiguous stays
 * `pending`: a stuck-unregistered event is recoverable, a duplicate registration is not.
 */
export async function resolveRegisterTx(txHash: string, nonce: number): Promise<RegisterTxOutcome> {
  const wallet = getSponsorWallet();
  const provider = wallet.provider!;
  const chainId = getActiveChainId();

  const parse = (receipt: { logs: ReadonlyArray<{ topics: readonly string[]; data: string }> }): string | null => {
    // The `Registered` topic differs per version (V2 carries the escrow config,
    // the ledger carries `registrant`), so the fragment set must match the
    // active contract or `parseLog` silently matches nothing and the resolver
    // reports a landed registration as absent.
    const v = getEventContractVersion(chainId);
    const iface = new Interface(registeredFragmentsFor(v));
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "Registered") return parsed.args.eventId as string;
      } catch {
        // log from another contract
      }
    }
    return null;
  };

  const receipt = await provider.getTransactionReceipt(txHash);
  if (receipt) {
    if (receipt.status === 0) return { status: "reverted" };
    const onChainEventId = parse(receipt);
    if (!onChainEventId) throw new Error(`registerEvent tx ${txHash} mined but has no Registered log`);
    return { status: "registered", onChainEventId, txHash };
  }

  const confirmedNonce = await provider.getTransactionCount(wallet.address, "latest");
  if (confirmedNonce > nonce) {
    await new Promise((r) => setTimeout(r, 2000));
    const recheck = await provider.getTransactionReceipt(txHash);
    if (!recheck) return { status: "replaced" };
    if (recheck.status === 0) return { status: "reverted" };
    const onChainEventId = parse(recheck);
    if (!onChainEventId) throw new Error(`registerEvent tx ${txHash} mined but has no Registered log`);
    return { status: "registered", onChainEventId, txHash };
  }

  return { status: "pending" };
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
// promptly (e.g. right after the owner runs addSponsor). Keyed per contract:
// since #563 one checkout may be for a registration on an older contract, and
// a positive for one contract says nothing about another.
const SPONSOR_READY_TTL_MS = 10 * 60 * 1000;
const _sponsorReady = new Map<string, number>();

/**
 * Whether the sponsor wallet is authorised to mint on `target`. V1 uses a
 * different (deploy-time) authorisation model and is treated as always ready;
 * V2 and the ledger gate `claimFor`/`batchClaimFor` behind `authorisedSponsors`,
 * so an unauthorised sponsor would make every paid claim revert `NotAuthorised`.
 *
 * Says nothing about the ledger's hourly cap — see `checkSponsorCanMint`.
 *
 * Throws on RPC failure (caller decides fail-open vs fail-closed). A definitive
 * `false` means the sponsor is genuinely not on the allow-list.
 */
export async function isSponsorReady(target: EventContractTarget): Promise<boolean> {
  const { version, address, chainId } = target;
  // Only V1 skips the probe (deploy-time authorisation, nothing to read).
  // Written as an explicit V1 test rather than `!== "v2"`: the old form
  // returned TRUE — check skipped — for any version that was not literally
  // "v2", so the ledger would have bypassed the guard that exists to refuse a
  // checkout BEFORE the buyer is charged.
  if (version === "v1") return true;

  const now = Date.now();
  const k = contractKey(target);
  if ((_sponsorReady.get(k) ?? 0) > now) return true;

  let ready: boolean;
  switch (version) {
    case "ledger": {
      const { isSponsorAuthorisedLedger } = await import("./event-contract-ledger.js");
      ready = await isSponsorAuthorisedLedger(getSponsorAddress(), address, chainId);
      break;
    }
    case "v2":
      ready = await isSponsorAuthorisedV2(getSponsorAddress(), address, chainId);
      break;
    default:
      return unhandledVersion(version, "isSponsorReady");
  }
  if (ready) _sponsorReady.set(k, now + SPONSOR_READY_TTL_MS);
  return ready;
}

/**
 * The ledger's answer for this server's sponsor. `EventContractConfigError`
 * when the configured address does not speak the cap ABI at all (a wrong
 * address, or a ledger from before the cap): that never heals, so a caller
 * that fails open on RPC errors must not fail open on it.
 */
export async function readSponsorMintAllowance(target: EventContractTarget): Promise<SponsorMintAllowance> {
  const { readSponsorMintAllowanceLedger } = await import("./event-contract-ledger.js");
  try {
    return await readSponsorMintAllowanceLedger(getSponsorAddress(), target.address, target.chainId);
  } catch (err) {
    if (isNotThisAbi(err)) {
      throw new EventContractConfigError(
        `the ledger at ${target.address} on chain ${target.chainId} does not answer sponsorMintAllowance — ` +
        `wrong address, or a ledger deployed before the per-sponsor mint cap`,
      );
    }
    throw err;
  }
}

export type SponsorMintVerdict =
  | { ok: true }
  | { ok: false; reason: "not-authorised" }
  | {
      ok: false;
      reason: "mint-cap";
      perHour: number;
      mintable: number;
      /**
       * Epoch seconds the refusal lifts, or null when waiting cannot help: the
       * owner set the cap to 0 (a reset lifts nothing), or this one order is
       * larger than a whole window's cap.
       */
      retryAt: number | null;
    };

/** Pure half of `checkSponsorCanMint` — exported so every rule is testable without a chain. */
export function evaluateSponsorMint(
  authorised: boolean,
  allowance: SponsorMintAllowance | null,
  quantity: number,
): SponsorMintVerdict {
  if (!authorised) return { ok: false, reason: "not-authorised" };
  // An uncapped sponsor's `mintable` reads UNLIMITED_MINTS, so it passes here.
  if (allowance === null || allowance.mintable >= quantity) return { ok: true };
  // Cap 0 included: `quantity` is at least 1.
  const hopeless = quantity > allowance.perHour;
  return {
    ok: false,
    reason: "mint-cap",
    perHour: allowance.perHour,
    mintable: allowance.mintable,
    retryAt: hopeless ? null : allowance.windowResetsAt,
  };
}

/** Seams for `checkSponsorCanMint` — both touch the chain. */
export interface SponsorMintReads {
  isSponsorReady(target: EventContractTarget): Promise<boolean>;
  readSponsorMintAllowance(target: EventContractTarget): Promise<SponsorMintAllowance>;
}

const liveSponsorMintReads: SponsorMintReads = { isSponsorReady, readSponsorMintAllowance };

/**
 * Can the sponsor mint `quantity` slots on `target` right now? The pre-charge
 * gate (#662): a "no" here refuses the checkout BEFORE the buyer is charged,
 * where the contract would otherwise refuse the mint after it and the webhook
 * refund.
 *
 * Authorisation is cached (`isSponsorReady`); the ledger's cap is NOT. It moves
 * with every mint any event makes, and the owner's stop lever — cap 0 — has to
 * bite on the next checkout, not ten minutes later. V1 and V2 have no cap.
 *
 * Throws on RPC failure, and `EventContractConfigError` when the ledger does
 * not answer the cap ABI; the caller treats the two differently.
 */
export async function checkSponsorCanMint(
  target: EventContractTarget,
  quantity: number,
  reads: SponsorMintReads = liveSponsorMintReads,
): Promise<SponsorMintVerdict> {
  const authorised = await reads.isSponsorReady(target);
  if (!authorised || target.version !== "ledger") return evaluateSponsorMint(authorised, null, quantity);
  return evaluateSponsorMint(true, await reads.readSponsorMintAllowance(target), quantity);
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
    const target = getDefaultEventContract(chainId);
    if (!target) return; // assertEventContractConfig has already refused to boot
    const ready = await isSponsorReady(target);
    if (!ready) {
      // The cap is a required argument, never defaulted: choosing it is the
      // decision that bounds a leaked key (WoCoTicketLedger.addSponsor).
      const how = target.version === "ledger"
        ? `addSponsor(${getSponsorAddress()}, <perHour>) — the cap is required; UNLIMITED_MINTS only for a sponsor the chain can check`
        : `addSponsor(${getSponsorAddress()})`;
      console.error(
        `[sponsor] NOT AUTHORISED on chain ${chainId} contract ${target.address} — ` +
        `paid checkouts will be refused. Owner must call ${how}.`,
      );
      return;
    }
    if (target.version !== "ledger") {
      console.log(`[sponsor] readiness OK — authorised to mint on chain ${chainId}`);
      return;
    }
    const a = await readSponsorMintAllowance(target);
    if (a.perHour === LEDGER_UNLIMITED_MINTS) {
      console.log(`[sponsor] readiness OK — authorised to mint on chain ${chainId}, no hourly cap`);
    } else if (a.perHour === 0) {
      console.error(
        `[sponsor] mint cap is 0 on chain ${chainId} contract ${target.address} — the owner has stopped this ` +
        `sponsor; paid checkouts will be refused until setSponsorMintCap(${getSponsorAddress()}, <perHour>) raises it.`,
      );
    } else {
      console.log(
        `[sponsor] readiness OK — authorised to mint on chain ${chainId}, cap ${a.perHour}/h, ` +
        `${a.mintable} mintable in the current window`,
      );
    }
  } catch (err) {
    if (err instanceof EventContractConfigError) {
      console.error(`[sponsor] readiness probe: ${err.message} — paid checkouts will be refused`);
      return;
    }
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
  target: EventContractTarget = defaultTargetOrThrow(),
): Promise<number> {
  const { chainId, address, version } = target;
  if (version === "ledger") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    const { claimForLedger } = await import("./event-contract-ledger.js");
    return claimForLedger(onChainEventId, burnerAddress, orderRefBytes32, address, pk, chainId);
  }
  if (version === "v2") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    return claimForV2(onChainEventId, burnerAddress, orderRefBytes32, address, pk, chainId);
  }
  // Everything below is the V1 path. Narrowing explicitly rather than letting
  // it be the fallthrough tail: a new union member would otherwise compile
  // clean here and silently mint through V1's ABI — the same silent-V1
  // fallthrough this module was rewritten to remove.
  if (version !== "v1") return unhandledVersion(version, "claimForOnChain");

  const wallet = getSponsorWallet(chainId);
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
 * @param target          The contract the registration lives on — from the
 *                        server's registration record, never from the event
 *                        feed (#563, #426). Required, so no caller mints into
 *                        today's env contract by omission.
 * @returns Array of 0-based slot indices in the same order as `burners`.
 */
export async function batchClaimForOnChain(
  onChainEventId: string,
  burners: string[],
  orderRefBytes32: string,
  target: EventContractTarget,
): Promise<number[]> {
  if (burners.length === 0) throw new Error("batchClaimForOnChain: empty burners");
  if (burners.length > ON_CHAIN_BATCH_MAX) {
    throw new Error(`batchClaimForOnChain: ${burners.length} exceeds cap ${ON_CHAIN_BATCH_MAX}`);
  }

  const { chainId, address, version } = target;
  if (version === "ledger") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    const { batchClaimForLedger } = await import("./event-contract-ledger.js");
    return batchClaimForLedger(onChainEventId, burners, orderRefBytes32, address, pk, chainId);
  }
  if (version === "v2") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    return batchClaimForV2(onChainEventId, burners, orderRefBytes32, address, pk, chainId);
  }
  // See claimForOnChain — V1 is narrowed, never a fallthrough tail.
  if (version !== "v1") return unhandledVersion(version, "batchClaimForOnChain");

  const wallet = getSponsorWallet(chainId);
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
 * @returns on-chain eventId emitted in the Registered event, and the contract
 *          it was registered on — which the caller records (#563)
 */
export async function registerEventOnChain(
  supply: number,
  manifestRef: string,
  v2Params?: RegisterV2Params,
  onTxSent?: SponsorTxSent,
  onTxReserved?: SponsorTxReserved,
): Promise<{ onChainEventId: string; txHash: string; contract: EventContractTarget }> {
  const contract = defaultTargetOrThrow();
  const registered = await registerOn(contract, supply, manifestRef, v2Params, onTxSent, onTxReserved);
  return { ...registered, contract };
}

async function registerOn(
  target: EventContractTarget,
  supply: number,
  manifestRef: string,
  v2Params?: RegisterV2Params,
  onTxSent?: SponsorTxSent,
  onTxReserved?: SponsorTxReserved,
): Promise<{ onChainEventId: string; txHash: string }> {
  const { chainId, address, version } = target;

  if (version === "ledger") {
    const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
    if (!pk) throw new Error("WOCO_SPONSOR_PRIVATE_KEY is not set");
    if (!v2Params) {
      throw new Error(`registerEventOnChain: chain ${chainId} runs the ledger but no params supplied`);
    }
    if (!v2Params.organiser) {
      throw new Error("registerEventOnChain: ledger requires an explicit organiser address");
    }
    const { registerEventLedger } = await import("./event-contract-ledger.js");
    return registerEventLedger(
      v2Params.organiser,
      supply,
      manifestRef,
      v2Params.eventEndTs,
      address,
      pk,
      chainId,
      onTxSent,
      onTxReserved,
    );
  }

  if (version === "v2") {
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
      onTxSent,
      onTxReserved,
    );
  }

  // See claimForOnChain — V1 is narrowed, never a fallthrough tail.
  if (version !== "v1") return unhandledVersion(version, "registerEventOnChain");

  const wallet = getSponsorWallet(chainId);
  const contract = new Contract(address, REGISTER_ABI, wallet);

  console.log(
    `[sponsor] registerEvent supply=${supply} manifestRef=${manifestRef.slice(0, 10)}… chain=${chainId}`,
  );

  const tx = await sendSponsorTx(
    { chainId, address: wallet.address, provider: wallet.provider!, label: "v1.registerEvent" },
    (o) => {
      // Journal the intent BEFORE the node sees the tx — a throw aborts the send (#318).
      onTxReserved?.({ nonce: o.nonce, chainId });
      return contract.registerEvent(supply, manifestRef, o);
    },
  );
  onTxSent?.({ txHash: tx.hash, nonce: tx.nonce, chainId });
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
