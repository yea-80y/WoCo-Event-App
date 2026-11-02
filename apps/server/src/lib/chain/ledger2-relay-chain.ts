/**
 * The chain side of the ledger2 relay (`lib/event/ledger2-relay.ts`): the relay key,
 * the reads that refuse a change early, and the one Multicall3 transaction a save is.
 *
 * THE RELAY KEY HOLDS NO ROLE. Every function it calls on the ledger is a signed path
 * that ignores `msg.sender` ("anyone may submit"), so `LEDGER2_RELAY_PRIVATE_KEY` is
 * only ever a gas float: never `addSponsor` it, never make it a dispute authority. A
 * key of its own, not the ticket sponsor's, so an organiser's save never queues in front
 * of a card-sale mint on the sponsor's nonce lane (`sendSponsorTx` serialises per
 * address), and boot refuses it equal to any other platform key.
 *
 * Calls go through canonical Multicall3, so one save is one transaction. Seat moves are
 * `allowFailure: false` and first, so a rearrangement lands whole or not at all; terms
 * writes are `allowFailure: true` and after them (a terms write bumps `termsNonces`,
 * which every seat move commits to), so one series that changed in the meantime does not
 * undo the others. What landed is read from the receipt's ledger logs. The ledger's
 * NatSpec names the organiser's own account as the atomic submitter of a dependent seat
 * sequence (audit 1156 L-1); an `allowFailure: false` Multicall3 batch is a second way to
 * meet the same rule.
 */

import { Contract, Interface, JsonRpcProvider, Wallet, keccak256, type TransactionReceipt, type TransactionResponse } from "ethers";
import { MULTICALL3_ADDRESS, MULTICALL3_CODE_HASH } from "@woco/shared/ticket/ledger2-terms";
import { getChainRpcUrl } from "./event-contract.js";
import { sendSponsorTx } from "./sponsor-nonce.js";

/** Everything the relay encodes, reads or decodes on the ledger. */
export const LEDGER2_RELAY_ABI = [
  "function getEvent(bytes32 eventId) view returns (uint64 totalSupply, uint64 nextSlot, address organiser, bytes32 manifestRef)",
  "function getEventStatus(bytes32 eventId) view returns (uint64 eventEndTs, bool cancelled)",
  "function getOrganiserKey(bytes32 eventId) view returns (address)",
  "function getRegisteredSupply(bytes32 eventId) view returns (uint64)",
  "function isSeated(bytes32 eventId) view returns (bool)",
  "function termsNonces(bytes32 eventId) view returns (uint256)",
  "function slotOwner(bytes32 eventId, uint256 slot) view returns (address)",
  "function transferNonces(bytes32 eventId, uint256 slot) view returns (uint256)",
  "function seatOf(bytes32 eventId, uint256 slot) view returns (uint256)",
  "function seatNonces(bytes32 eventId, uint256 seat) view returns (uint256)",

  "function setSupplyWithSignature(bytes32 eventId, uint64 supply, uint256 issuedAt, uint256 deadline, bytes signature)",
  "function extendSalesEndWithSignature(bytes32 eventId, uint64 eventEndTs, uint256 issuedAt, uint256 deadline, bytes signature)",
  "function cancelEventWithSignature(bytes32 eventId, uint256 issuedAt, uint256 deadline, bytes signature)",
  "function revokeSignaturesWithSignature(bytes32 eventId, uint256 issuedAt, uint256 deadline, bytes signature)",
  "function reseatBearer(bytes32 eventId, uint256 slot, uint256 toSeat, uint256 issuedAt, uint256 deadline, bytes organiserSig)",
  "function reseat(bytes32 eventId, uint256 slot, uint256 toSeat, uint256 issuedAt, uint256 deadline, bytes organiserSig, bytes holderSig)",

  "event SupplySet(bytes32 indexed eventId, uint64 previous, uint64 supply)",
  "event SalesEndExtended(bytes32 indexed eventId, uint64 previous, uint64 eventEndTs)",
  "event EventCancelled(bytes32 indexed eventId, address indexed by, bool forced)",
  "event SignaturesRevoked(bytes32 indexed eventId, address indexed by)",
  "event SlotReseated(bytes32 indexed eventId, uint256 indexed slot, uint256 fromSeat, uint256 toSeat)",

  // Every refusal a relayed call can meet, so a simulation's first failure has a name.
  "error EventNotFound()",
  "error NotOrganiserKey()",
  "error SignatureExpired()",
  "error SignatureNotYetValid()",
  "error DeadlineTooFar()",
  "error AlreadyCancelled()",
  "error SalesClosed()",
  "error SupplyUnchanged()",
  "error InsufficientSupply()",
  "error SupplyAboveRegistered()",
  "error InvalidEventEnd()",
  "error SalesEndTooFar()",
  "error NotSeated()",
  "error InvalidSeat()",
  "error SeatTaken()",
  "error SeatUnchanged()",
  "error SlotUnclaimed()",
  "error NotBearer()",
  "error SlotHeld()",
  "error BearerMintsOff()",
  "error NotSlotOwner()",
] as const;

const MULTICALL3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
] as const;

export const ledger2RelayIface = new Interface(LEDGER2_RELAY_ABI);
const multicallIface = new Interface(MULTICALL3_ABI);

/** Padded estimate above this is refused: a 50-move batch measures ~3-4M. */
export const RELAY_GAS_CEILING = 6_000_000n;
/** Same rule as the names relay (`paddedRelayGasLimit`): a limit is not a charge. */
export function paddedLedger2RelayGas(estimate: bigint): bigint {
  return estimate + estimate / 5n + 150_000n;
}

// ── The key ──────────────────────────────────────────────────────────────────

const OTHER_PLATFORM_KEYS = [
  "WOCO_SPONSOR_PRIVATE_KEY",
  "ATTENDEE_STAMPER_PRIVATE_KEY",
  "SUB_ENS_SPONSOR_PRIVATE_KEY",
  "FEED_PRIVATE_KEY",
  "CAMPAIGN_ISSUER_PRIVATE_KEY",
  "SOCIAL_INDEXER_PRIVATE_KEY",
] as const;

/**
 * Boot check: the relay key is a key of its own. Its whole point is that it can be
 * drained or lost without touching minting, storage or names; the same key under two
 * names defeats that silently. The reason to refuse, or null (also null when unset:
 * the relay is then simply off).
 */
export function relayKeyConflict(env: NodeJS.ProcessEnv = process.env): string | null {
  const relay = env.LEDGER2_RELAY_PRIVATE_KEY?.trim();
  if (!relay) return null;
  let relayAddress: string;
  try {
    relayAddress = new Wallet(relay).address;
  } catch {
    return "LEDGER2_RELAY_PRIVATE_KEY is not a valid private key";
  }
  for (const name of OTHER_PLATFORM_KEYS) {
    const other = env[name]?.trim();
    if (!other) continue;
    try {
      if (new Wallet(other).address === relayAddress) {
        return `LEDGER2_RELAY_PRIVATE_KEY must not be the same key as ${name}`;
      }
    } catch {
      // Another key's own validity is its own boot check's business.
    }
  }
  return null;
}

export class RelayKeyUnconfigured extends Error {
  constructor() {
    super("LEDGER2_RELAY_PRIVATE_KEY is not set");
    this.name = "RelayKeyUnconfigured";
  }
}

function relayKey(): string {
  const pk = process.env.LEDGER2_RELAY_PRIVATE_KEY?.trim();
  if (!pk) throw new RelayKeyUnconfigured();
  return pk;
}

export function relayConfigured(): boolean {
  return !!process.env.LEDGER2_RELAY_PRIVATE_KEY?.trim() && relayKeyConflict() === null;
}

export function relayAddress(): string {
  return new Wallet(relayKey()).address.toLowerCase();
}

const _providers = new Map<number, JsonRpcProvider>();
function provider(chainId: number): JsonRpcProvider {
  let p = _providers.get(chainId);
  if (!p) {
    p = new JsonRpcProvider(getChainRpcUrl(chainId));
    _providers.set(chainId, p);
  }
  return p;
}

export async function readRelayBalance(chainId: number): Promise<bigint> {
  return provider(chainId).getBalance(relayAddress());
}

// ── Code checks ──────────────────────────────────────────────────────────────

/** Per `${chainId}:${ledger}`: verified once, remembered for the process. */
const _codeVerified = new Set<string>();

export type CodeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Multicall3 at its canonical address carries the canonical code, and the ledger has
 * code at all (a call to an empty address "succeeds" and changes nothing). Checked
 * before the first relay and by the health probe, remembered once it passes; until it
 * passes the relay refuses. Throws on a read that did not answer.
 */
export async function verifyRelayCode(chainId: number, ledger: string): Promise<CodeCheck> {
  const k = `${chainId}:${ledger.toLowerCase()}`;
  if (_codeVerified.has(k)) return { ok: true };
  const p = provider(chainId);
  const [multicall, ledgerCode] = await Promise.all([p.getCode(MULTICALL3_ADDRESS), p.getCode(ledger)]);
  if (multicall === "0x" || keccak256(multicall) !== MULTICALL3_CODE_HASH) {
    return { ok: false, reason: "Multicall3 at its canonical address does not carry the canonical code" };
  }
  if (ledgerCode === "0x") return { ok: false, reason: "the ledger address has no code" };
  _codeVerified.add(k);
  return { ok: true };
}

export function _resetRelayCodeChecksForTests(): void {
  _codeVerified.clear();
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface SeriesChainState {
  organiser: string;
  organiserKey: string;
  totalSupply: number;
  nextSlot: number;
  registeredSupply: number;
  /** Epoch seconds. */
  eventEndTs: number;
  cancelled: boolean;
  seated: boolean;
  termsNonce: bigint;
}

function ledger(chainId: number, address: string): Contract {
  return new Contract(address, LEDGER2_RELAY_ABI, provider(chainId));
}

/** One series' state, in parallel calls ethers batches into one round trip. Throws on any failure. */
export async function readSeriesChainState(chainId: number, address: string, eventId: string): Promise<SeriesChainState> {
  const c = ledger(chainId, address);
  // ethers v6 reserves `Contract.getEvent` for event-fragment lookup.
  const [ev, status, key, registered, seated, nonce] = await Promise.all([
    c.getFunction("getEvent").staticCall(eventId),
    c.getEventStatus(eventId),
    c.getOrganiserKey(eventId),
    c.getRegisteredSupply(eventId),
    c.isSeated(eventId),
    c.termsNonces(eventId),
  ]);
  return {
    organiser: (ev.organiser as string).toLowerCase(),
    organiserKey: (key as string).toLowerCase(),
    totalSupply: Number(ev.totalSupply),
    nextSlot: Number(ev.nextSlot),
    registeredSupply: Number(registered),
    eventEndTs: Number(status.eventEndTs),
    cancelled: status.cancelled as boolean,
    seated: seated as boolean,
    termsNonce: nonce as bigint,
  };
}

export interface SlotChainState {
  owner: string;
  transferNonce: bigint;
  seat: bigint;
}

export async function readSlotChainState(chainId: number, address: string, eventId: string, slot: number): Promise<SlotChainState> {
  const c = ledger(chainId, address);
  const [owner, nonce, seat] = await Promise.all([
    c.slotOwner(eventId, slot),
    c.transferNonces(eventId, slot),
    c.seatOf(eventId, slot),
  ]);
  return { owner: (owner as string).toLowerCase(), transferNonce: nonce as bigint, seat: seat as bigint };
}

export async function readSeatNonce(chainId: number, address: string, eventId: string, seat: bigint): Promise<bigint> {
  return ledger(chainId, address).seatNonces(eventId, seat) as Promise<bigint>;
}

/** The latest block's timestamp: the clock the ledger checks windows against. */
export async function readChainNowSecs(chainId: number): Promise<number> {
  const b = await provider(chainId).getBlock("latest");
  if (!b) throw new Error("no latest block");
  return b.timestamp;
}

// ── The batch ────────────────────────────────────────────────────────────────

export interface RelayCall {
  /** Calldata on the ledger. */
  data: string;
  allowFailure: boolean;
}

function aggregateData(ledgerAddress: string, calls: readonly RelayCall[]): string {
  return multicallIface.encodeFunctionData("aggregate3", [
    calls.map((c) => ({ target: ledgerAddress, allowFailure: c.allowFailure, callData: c.data })),
  ]);
}

/** One inner call's simulated outcome; `error` names the ledger's custom error when it has one. */
export interface SimulatedCall {
  success: boolean;
  error?: string;
}

/** The ledger error a revert's data names, or null when it names none we know. */
export function decodeLedgerError(data: string): string | null {
  try {
    return ledgerRevertName(data);
  } catch {
    return null;
  }
}

function ledgerRevertName(data: string): string | null {
  if (!data || data === "0x" || data.length < 10) return null;
  const e = ledger2RelayIface.parseError(data);
  return e?.name ?? null;
}

/**
 * Every call run in order at `latest` with failure ALLOWED, so each one's own outcome
 * is visible: `allowFailure: false` reverts with "Multicall3: call failed" and no
 * index. Only the FIRST failure means anything - later calls ran without its state.
 */
export async function simulateRelayBatch(
  chainId: number,
  ledgerAddress: string,
  calls: readonly RelayCall[],
): Promise<SimulatedCall[]> {
  const data = aggregateData(ledgerAddress, calls.map((c) => ({ ...c, allowFailure: true })));
  const raw = await provider(chainId).call({ to: MULTICALL3_ADDRESS, data, from: relayAddress() });
  const [results] = multicallIface.decodeFunctionResult("aggregate3", raw) as unknown as [
    Array<{ success: boolean; returnData: string }>,
  ];
  return results.map((r) =>
    r.success ? { success: true } : { success: false, ...(decodeLedgerError(r.returnData) ? { error: decodeLedgerError(r.returnData)! } : {}) },
  );
}

export class RelayGasCeilingError extends Error {
  constructor(public readonly gasLimit: bigint) {
    super(`relay batch would need ${gasLimit} gas, above the ${RELAY_GAS_CEILING} ceiling`);
    this.name = "RelayGasCeilingError";
  }
}

/** Broadcast the batch from the relay key. Resolves once broadcast; the caller waits. */
export async function sendRelayBatch(
  chainId: number,
  ledgerAddress: string,
  calls: readonly RelayCall[],
  label: string,
): Promise<TransactionResponse> {
  const p = provider(chainId);
  const wallet = new Wallet(relayKey(), p);
  const data = aggregateData(ledgerAddress, calls);
  return sendSponsorTx({ chainId, address: wallet.address, provider: p, label }, async (o) => {
    const estimate = await p.estimateGas({ from: wallet.address, to: MULTICALL3_ADDRESS, data, value: 0n });
    const gasLimit = paddedLedger2RelayGas(estimate);
    if (gasLimit > RELAY_GAS_CEILING) throw new RelayGasCeilingError(gasLimit);
    return wallet.sendTransaction({ to: MULTICALL3_ADDRESS, data, value: 0n, gasLimit, nonce: o.nonce });
  });
}

/** The receipt, or null when none arrived within `timeoutMs` (the tx may still land). */
export async function waitRelayReceipt(tx: TransactionResponse, timeoutMs: number): Promise<TransactionReceipt | null> {
  try {
    return await tx.wait(1, timeoutMs);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // ethers throws CALL_EXCEPTION for a mined-but-reverted tx, carrying the receipt.
    if (code === "CALL_EXCEPTION") {
      const receipt = (err as { receipt?: TransactionReceipt }).receipt;
      if (receipt) return receipt;
    }
    if (code === "TIMEOUT") return null;
    throw err;
  }
}

/** One ledger log the receipt carries, decoded. */
export interface LandedLog {
  name: "SupplySet" | "SalesEndExtended" | "EventCancelled" | "SignaturesRevoked" | "SlotReseated";
  eventId: string;
  slot?: number;
}

/** The ledger's own logs in `logs`, in order. Logs of any other address are ignored. */
export function landedLogs(
  ledgerAddress: string,
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>,
): LandedLog[] {
  const out: LandedLog[] = [];
  const l = ledgerAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== l) continue;
    let parsed;
    try {
      parsed = ledger2RelayIface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    const name = parsed.name as LandedLog["name"];
    if (!["SupplySet", "SalesEndExtended", "EventCancelled", "SignaturesRevoked", "SlotReseated"].includes(name)) continue;
    out.push({
      name,
      eventId: (parsed.args.eventId as string).toLowerCase(),
      ...(name === "SlotReseated" ? { slot: Number(parsed.args.slot) } : {}),
    });
  }
  return out;
}
