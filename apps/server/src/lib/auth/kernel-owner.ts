/**
 * Kernel-owner authorization for session delegations (2026-07 split-brain fix).
 *
 * Kernel-backed logins (passkey, web3auth) sign `AuthorizeSession` with their
 * RAW owner EOA key (ecrecover-able, RPC-free) while `message.parent` stays the
 * Kernel smart-account address — the user's identity. The
 * server authorizes the delegation iff the recovered EOA *owns* that Kernel:
 *
 *  1. Deterministic (no RPC): the Kernel v3.1 counterfactual CREATE2 address of
 *     the EOA equals the parent. Covers every non-recovered account, deployed
 *     or not — verified byte-equivalent to the client's createKernelAccount
 *     addresses on Arb Sepolia (kernel-addr-equivalence check, 2026-07-10), and
 *     chain-independent: nothing in the CREATE2 derivation reads a chain id, so
 *     the #489 move to Arbitrum One left every address unchanged.
 *  2. On-chain fallback: the deployed Kernel's live ECDSA sudo owner equals the
 *     EOA (`ecdsaValidatorStorage` on the validator singleton). Covers RECOVERED
 *     accounts, whose owner was rotated so their counterfactual diverges — the
 *     accounts the old Kernel-1271-only verify wedged with 403s.
 *
 * This replaces Kernel ERC-1271 as the passkey/web3auth session-verify path
 * (1271 needed a deployed account + owner==live-key + working RPC on every
 * request). 1271/6492 verify remains in verify-delegation.ts for smart wallets
 * (CSW) and delegations minted by pre-fix clients.
 *
 * READS ARE ORDERED (#200). The owner is read at `latest` through a public,
 * load-balanced RPC, and a replica lagging behind a recovery still names the
 * retired owner. Every read therefore fetches the L2 block it executed at in the
 * SAME `eth_call` (Multicall3: ArbSys.arbBlockNumber + the validator getter), and
 * kernel-owner-ordering.ts discards any answer that names a different owner from
 * a block no later than the one where the owner was last seen to change. Without
 * that, a late answer rolled the cache back to the retired key — reachable from
 * every retired-key request, because the #273 re-read below is exactly when a
 * lagging replica gets asked.
 *
 * READS ARE BOUNDED (#163, #210). This module runs before any authorization, so
 * everything it keys on — the parent, the recovered EOA — is caller-chosen, and
 * every cache miss is an eth_call on the RPC the payment path shares. So: both
 * caches are capped (oldest entry evicted); concurrent requests for one Kernel
 * share one read; and a read happens only if the caller's per-client budget
 * allows it (owner-read-budget.ts, supplied by the auth middleware). Over budget,
 * the read reports `"error"` and the rules below decide — refuse for a
 * known-deployed account, counterfactual for an unknown one — never a grant the
 * chain did not give.
 *
 * Two bounds were considered and REJECTED, and are pinned by tests so they are not
 * re-added. A counterfactual short-circuit that skips the chain for a
 * never-observed account would let a retired key, whose counterfactual still
 * matches, never be read at all. A server-side negative cache for FAILED reads
 * would bound an outage's retries — but the client already throttles itself after
 * a double failure (client.ts), and any server window, however short, defeats its
 * one IMMEDIATE retry on a sub-second RPC blip, turning a blip into the "session
 * ended" banner. Upstream load during an outage is bounded by the budget and the
 * shared in-flight read instead.
 *
 * CO-OWNERS (#746, Fable consult 9). An account with more than one passkey moves
 * its root to ZeroDev's WeightedECDSAValidator: every passkey a signer, any one
 * enough (`@woco/shared/kernel/co-owners`). It then has no single owner, and the
 * ECDSA storage reads empty (the switch uninstalls that validation). So the owner
 * read also reads the account's ROOT, and `isAccountSigner` - what sessions use -
 * asks the weighted list whether THIS key is on it: one atomic read of the root
 * and the key's weight, ordered per key exactly as owner reads are ordered per
 * account. A key confirmed on the list makes the account durably known-weighted,
 * so an unreadable chain refuses it instead of falling back to the counterfactual
 * (which the first passkey matches forever, removed or not). A positive answer is
 * cached for one minute, not five: once the account is known co-owned, a key
 * removed from the list stops signing in within that, and at once when its device
 * record is removed (verify-delegation). Each key's removal is kept durably as a
 * floor (kernel-deployed.ts `removed`), so no older read brings it back - not
 * after a restart, not after the in-memory change-point is evicted.
 */

import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { getKernelAddressFromECDSA, getValidatorAddress } from "@zerodev/ecdsa-validator";
import { createPublicClient, http, zeroAddress, type Address, type Chain, type PublicClient } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { KERNEL_CHAIN_ID, type KernelChainId } from "@woco/shared";
import { getChainRpcUrl } from "../chain/event-contract.js";
import {
  ECDSA_ROOT_ID,
  KERNEL_ROOT_VALIDATOR_ABI,
  WEIGHTED_ECDSA_VALIDATOR_V3_1,
  WEIGHTED_GUARDIAN_ABI,
  WEIGHTED_ROOT_ID,
  WEIGHTED_STORAGE_ABI,
} from "@woco/shared/kernel/co-owners";
import {
  coOwnerRemovedBlock,
  isKernelKnownDeployed,
  knownOwnerDisagreesOnAnyChain,
  getKernelOwnerRecord,
  getKernelWeightedRecord,
  recordCoOwnerRemoved,
  recordKernelOwner,
  recordKernelWeighted,
} from "./kernel-deployed.js";
import { observeOwnerRead, type OwnerRead } from "./kernel-owner-ordering.js";

/**
 * The viem chain object for the Kernel chain. The ID itself is the SHARED
 * constant (#489): this pin and the client's used to be independent literals,
 * and a server reading one chain while the client signs for another authorizes
 * against an account that does not exist there.
 */
const KERNEL_CHAINS = {
  42161: arbitrum,
  421614: arbitrumSepolia,
} as const satisfies Record<number, Chain>;
const KERNEL_CHAIN: Chain = KERNEL_CHAINS[KERNEL_CHAIN_ID satisfies KernelChainId];

const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

let _client: PublicClient | null = null;
function client(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: KERNEL_CHAIN,
      transport: http(getChainRpcUrl(KERNEL_CHAIN_ID)),
    });
  }
  return _client;
}

/** Options a caller may pass down to the read path. */
export interface OwnerReadOptions {
  /** Consulted only at the moment a chain read would happen. False = do not read;
   *  the result is reported as `"error"`. Absent = unrestricted (internal
   *  callers and tests). */
  chainReadAllowed?: () => boolean;
}

/** Hard caps. Both maps are keyed by caller-chosen input on a pre-auth path, so
 *  without a cap a caller varying the key grows them without bound (#163). Oldest
 *  entry is evicted first — insertion order is what a Map gives us, and bounding
 *  memory is the requirement; recency would only refine which entry goes. */
const OWNER_CACHE_MAX = 5_000;
const KERNEL_OF_CACHE_MAX = 5_000;

function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}

/** owner EOA (lower) → counterfactual Kernel (lower). Pure CREATE2 — immutable;
 *  cached, capped. */
const _kernelOfCache = new Map<string, string>();

/** kernel (lower) → { owner (lower) | null (undeployed/unset), block, fetchedAt }.
 *  `block` is the L2 block the entry was read at, kept so a cache-hit
 *  confirmation can record the account (see isKernelOwner).
 *  Owners rotate (recovery), so reads expire; a rotated-away key stops
 *  authenticating within TTL. Undeployed (null) results are cached too so
 *  fresh counterfactual accounts don't eth_call on every request.
 *
 *  RULE (#273): a cached read may CONFIRM a signer, never CONDEMN one.
 *  Recovery rotates the owner in a single transaction and the rotated-IN key's
 *  first delegation arrives seconds later — inside any useful TTL. A sibling
 *  session's traffic keeps this entry warm with the PRE-rotation owner, so
 *  deciding a rejection from cache locked the legitimate new owner out for the
 *  full TTL ("Invalid signature" on every fresh delegation). isKernelOwner
 *  therefore re-reads the chain before any rejection that a cached value
 *  decided. Steady-state traffic (owner matches) never pays the extra call;
 *  a wrong-key attempt pays one eth_call, within the caller's read budget. */
const _ownerCache = new Map<string, { owner: string | null; root: RootKind; block: number; fetchedAt: number }>();
const OWNER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The account's root validator as one read saw it. `none`: no code at the
 * address (undeployed) or a root that did not read; the ECDSA owner then decides
 * exactly as before co-owners existed. Only `weighted` changes the path.
 */
export type RootKind = "ecdsa" | "weighted" | "none" | "other";
interface OwnerState extends OwnerRead {
  root: RootKind;
}

/** kernel (lower) → the raw chain read in flight, shared by concurrent callers. */
const _inFlightReads = new Map<string, Promise<OwnerState>>();

/** One read of a key against a co-owned account: the root, the key's weight on
 *  the weighted list, the list's threshold and the L2 block, from a single
 *  `eth_call`. `threshold` defaults to 1 (test seam). */
export interface SignerRead {
  root: RootKind;
  weight: number;
  block: number;
  threshold?: number;
}

/** `${kernel}:${eoa}` → the last POSITIVE membership answer, confirming for
 *  MEMBER_CACHE_TTL_MS. A negative one is never decided from cache, so it is not kept. */
const _memberCache = new Map<string, { block: number; fetchedAt: number }>();
const MEMBER_CACHE_TTL_MS = 60 * 1000;
const MEMBER_CACHE_MAX = 5_000;
/** `${kernel}:${eoa}` → the last membership CHANGE seen and its block: a read
 *  that contradicts it from no later a block predates it (kernel-owner-ordering.ts,
 *  per key). In memory: a removal is made durable by its device record. */
const _memberOrder = new Map<string, { member: boolean; block: number }>();
const _inFlightMember = new Map<string, Promise<SignerRead>>();

/** Test seam — replaces the on-chain owner fetch (RPC-free tests); null restores.
 *  The override returns what the chain would: the owner AND the block it was read
 *  at, so tests can replay reads out of order. `root` defaults to `ecdsa` when an
 *  owner is named and `none` when not. */
let _ownerFetchOverride: ((kernel: string) => Promise<(OwnerRead & { root?: RootKind }) | "error">) | null = null;
export function _setOwnerFetchForTests(
  f: ((kernel: string) => Promise<(OwnerRead & { root?: RootKind }) | "error">) | null,
): void {
  _ownerFetchOverride = f;
}
/** Test seam — replaces the co-owner membership fetch; null restores. */
let _memberFetchOverride: ((kernel: string, eoa: string) => Promise<SignerRead | "error">) | null = null;
export function _setMemberFetchForTests(
  f: ((kernel: string, eoa: string) => Promise<SignerRead | "error">) | null,
): void {
  _memberFetchOverride = f;
}
export function _resetOwnerCacheForTests(): void {
  _ownerCache.clear();
  _inFlightReads.clear();
  _memberCache.clear();
  _memberOrder.clear();
  _inFlightMember.clear();
}
export function _cacheSizesForTests(): { owner: number; kernelOf: number } {
  return { owner: _ownerCache.size, kernelOf: _kernelOfCache.size };
}

/**
 * ECDSAValidator singleton per-account owner storage getter (mirrors the
 * client's readKernelEcdsaOwner in apps/web/.../kernel-account.ts).
 */
const ECDSA_VALIDATOR_STORAGE_ABI = [
  {
    type: "function",
    name: "ecdsaValidatorStorage",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** ArbSys precompile — `arbBlockNumber()` is the L2 block a call executes at.
 *  (The EVM's `block.number` on Arbitrum is the L1-ish number: coarse, and many
 *  L2 blocks share one value, so it cannot order reads. Verified live 2026-08-22:
 *  arbBlockNumber 300896544 vs Multicall3.getBlockNumber 11544676.) */
const ARBSYS_ADDRESS = "0x0000000000000000000000000000000000000064" as const;
const ARBSYS_ABI = [
  {
    type: "function",
    name: "arbBlockNumber",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Does a FRESH cache entry name `eoa` as `parent`'s owner? Never reads the chain,
 * never records anything, and a `false` decides nothing (#273: a cache may confirm,
 * never condemn). For callers choosing which check to run first so that the one
 * they run is a cached confirmation (verify-delegation.ts, #746).
 */
export function cachedOwnerIs(parent: string, eoa: string): boolean {
  const cached = _ownerCache.get(parent.toLowerCase());
  return (
    cached !== undefined &&
    Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS &&
    cached.owner === eoa.toLowerCase()
  );
}

/** {@link cachedOwnerIs}, or a fresh cached confirmation that `eoa` is on the
 *  account's co-owner list. The same rule: true confirms, false decides nothing. */
export function cachedSignerIs(parent: string, eoa: string): boolean {
  return cachedOwnerIs(parent, eoa) || _memberConfirmed(parent.toLowerCase(), eoa.toLowerCase());
}

/** A fresh positive membership answer newer than the key's last removal. */
function _memberConfirmed(parent: string, eoa: string): boolean {
  const m = _memberCache.get(`${parent}:${eoa}`);
  return m !== undefined && Date.now() - m.fetchedAt < MEMBER_CACHE_TTL_MS && m.block > (coOwnerRemovedBlock(parent, eoa) ?? -1);
}

/** What `rootValidator()` answered, as a kind. Pure. */
export function rootKindOf(result: { status: string; result?: unknown }): RootKind {
  if (result.status !== "success" || typeof result.result !== "string") return "none";
  const v = result.result.toLowerCase();
  if (v === ECDSA_ROOT_ID) return "ecdsa";
  if (v === WEIGHTED_ROOT_ID) return "weighted";
  if (/^0x0*$/.test(v)) return "none";
  return "other";
}

/** Deterministic Kernel v3.1 address for an owner EOA (lowercased), or null on
 *  computation failure. RPC-free for EntryPoint 0.7. */
export async function kernelAddressOfOwner(eoaAddress: string): Promise<string | null> {
  const key = eoaAddress.toLowerCase();
  const cached = _kernelOfCache.get(key);
  if (cached) return cached;
  try {
    const kernel = (
      await getKernelAddressFromECDSA({
        entryPoint,
        kernelVersion,
        eoaAddress: eoaAddress as Address,
        index: 0n,
        publicClient: client(),
      })
    ).toLowerCase();
    _kernelOfCache.set(key, kernel);
    capMap(_kernelOfCache, KERNEL_OF_CACHE_MAX);
    return kernel;
  } catch {
    return null;
  }
}

/** Live on-chain ECDSA sudo owner of a Kernel: lowercased address, `null` when
 *  the Kernel is not deployed / owner unset, `"error"` when the read failed
 *  (RPC outage) — callers must distinguish "provably no owner" from "unknown". */
export async function readKernelOwner(
  kernelAddress: string,
  opts: OwnerReadOptions = {},
): Promise<string | null | "error"> {
  const key = kernelAddress.toLowerCase();
  const cached = _ownerCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS) return cached.owner;
  const state = await _fetchOwnerState(key, undefined, opts);
  return state === "error" ? "error" : state.owner;
}

/** The raw chain call, one per Kernel at a time: concurrent callers share it. */
function _readOwnerAtBlock(key: string): Promise<OwnerState> {
  const inFlight = _inFlightReads.get(key);
  if (inFlight) return inFlight;
  const p = (async (): Promise<OwnerState> => {
    if (_ownerFetchOverride) {
      const read = await _ownerFetchOverride(key);
      if (read === "error") throw new Error("owner fetch override: error");
      return { ...read, root: read.root ?? (read.owner ? "ecdsa" : "none") };
    }
    const validatorAddress = getValidatorAddress(entryPoint, kernelVersion);
    // One atomic read: the owner, the account's root and the L2 block it was read
    // at, from a single `eth_call` through Multicall3 so all come from one replica
    // at one state. The root may not read (no code at the address - undeployed);
    // the block and the owner must.
    const [l2Block, owner, root] = await client().multicall({
      contracts: [
        { address: ARBSYS_ADDRESS, abi: ARBSYS_ABI, functionName: "arbBlockNumber" },
        {
          address: validatorAddress as Address,
          abi: ECDSA_VALIDATOR_STORAGE_ABI,
          functionName: "ecdsaValidatorStorage",
          args: [key as Address],
        },
        { address: key as Address, abi: KERNEL_ROOT_VALIDATOR_ABI, functionName: "rootValidator" },
      ],
      allowFailure: true,
    });
    if (l2Block.status !== "success" || owner.status !== "success") throw new Error("owner read failed");
    const o = owner.result;
    const lower = !o || o.toLowerCase() === zeroAddress ? null : o.toLowerCase();
    return { owner: lower, root: rootKindOf(root), block: Number(l2Block.result) };
  })();
  _inFlightReads.set(key, p);
  p.finally(() => _inFlightReads.delete(key)).catch(() => {});
  return p;
}

/** The live read itself: caches definitive, in-order answers; never caches a
 *  read that ordering judged stale — a stale answer is reported as "error" so
 *  the caller treats it as "knows nothing current", which for a known-deployed
 *  account means refuse. A FAILED read is not cached either (see the header).
 *
 *  `presentedBy` is the EOA whose delegation triggered the read, when there is
 *  one — it decides whether a store record may be CREATED (ordering.ts, #210). */
async function _fetchOwnerState(
  key: string,
  presentedBy: string | undefined,
  opts: OwnerReadOptions,
): Promise<OwnerState | "error"> {
  // Joining a read already in flight costs nothing, so it needs no budget.
  // A read this caller would START does.
  if (!_inFlightReads.has(key) && opts.chainReadAllowed && !opts.chainReadAllowed()) {
    console.warn(`[kernel-owner] owner read for ${key.slice(0, 10)}… refused: read budget exhausted`);
    return "error";
  }
  try {
    const read = await _readOwnerAtBlock(key);
    if (read.root === "weighted") {
      // A co-owned account has no single owner to order: its ECDSA storage is
      // empty by design and says nothing. Membership is read per key. An account
      // already on record (seen with an owner) is UPDATED to co-owned at once - an
      // update, as a rotation updates it; nothing is created by this read (#210).
      if (isKernelKnownDeployed(key)) recordKernelWeighted(key, read.block);
      const state: OwnerState = { owner: null, root: "weighted", block: read.block };
      _ownerCache.set(key, { ...state, fetchedAt: Date.now() });
      capMap(_ownerCache, OWNER_CACHE_MAX);
      return state;
    }
    // A replica from before the account moved to co-owners still shows the ECDSA
    // root and its first owner. It predates what we know: discard it.
    const weighted = getKernelWeightedRecord(key);
    if (weighted && read.block <= weighted.block) return "error";
    // Reconcile with what we already know, durably: a confirmed owner marks the
    // account deployed (so a LATER failed read refuses instead of falling back
    // to the counterfactual — #200, kernel-deployed.ts), and a rotation advances
    // the record so no lagging replica can roll it back.
    const owner = observeOwnerRead(key, read, presentedBy);
    if (owner === "stale") return "error";
    _ownerCache.set(key, { owner, root: read.root, block: read.block, fetchedAt: Date.now() });
    capMap(_ownerCache, OWNER_CACHE_MAX);
    return { owner, root: read.root, block: read.block };
  } catch {
    return "error";
  }
}

/**
 * Does `eoaAddress` own the Kernel at `parentAddress`?
 *
 * The live on-chain owner is AUTHORITATIVE when readable: a counterfactual
 * match alone is NOT sufficient for a deployed Kernel, because after a
 * recovery the RETIRED original key still counterfactual-matches the preserved
 * address — accepting it would let a device still holding the retired key keep
 * API access after the owner rotated away. So:
 *  - owner readable → decide by owner == eoa (rotated-in keys pass, rotated-out
 *    keys fail);
 *  - provably undeployed/unset (null) → decide by counterfactual match (only
 *    the key whose init data derives this address can ever deploy it);
 *  - read error (RPC outage) → REFUSE if this Kernel has ever been seen with an
 *    on-chain owner; otherwise counterfactual match, as for the undeployed case.
 *
 * That last rule is the #200 fix, and it turns on what the counterfactual actually
 * proves. The Kernel address is CREATE2-derived from the original owner's init
 * data, so the original key matches it forever — including after recovery has
 * rotated the owner away. For an account with no on-chain owner that is the only
 * evidence available and it is sound. For an account that HAS one, it is evidence
 * about the account's birth rather than about who controls it now, and treating it
 * as authority hands a rotated-out key its access back for as long as the read
 * keeps failing.
 *
 * Previously both outcomes shared the fallback, on an availability argument. The
 * cost of that bias is paid by exactly the keys someone decided to stop trusting,
 * and the duration is set by a third-party RPC rather than by us. Refusing costs a
 * deployed-account user their session during an outage, which is the same failure
 * every auth system has when its backing store is unreachable, and it is bounded
 * by the outage. Undeployed accounts are unaffected — they keep the fallback,
 * because for them it is the whole mechanism.
 */
/**
 * The decision itself, as a pure function over the four facts it needs.
 *
 * Separated from the I/O so the truth table can be pinned without mocking an RPC.
 * Every row below is a test: the branch this file exists to change is the
 * `knownDeployed` one, and while it lived inline nothing exercised it — the whole
 * `isKernelOwner` hunk could be reverted with the suite still green.
 */
export function decideKernelOwnership(args: {
  /** Live read: an owner, `null` for no owner on chain, `"error"` for unreadable. */
  ownerRead: string | null | "error";
  eoa: string;
  counterfactualMatches: boolean;
  /** Has this Kernel ever been observed WITH an on-chain owner ON THIS CHAIN? */
  knownDeployed: boolean;
  /**
   * Has any record for this Kernel — on ANY chain — named an owner OTHER than
   * this EOA? A fact about the account, not about a chain: see
   * `knownOwnerDisagreesOnAnyChain`.
   */
  knownRotatedAway: boolean;
}): boolean {
  const { ownerRead, eoa, counterfactualMatches, knownDeployed, knownRotatedAway } = args;

  // A definitive owner settles it outright, in both directions.
  if (ownerRead !== null && ownerRead !== "error") return ownerRead === eoa;

  // Neither remaining outcome may fall back for an account we have SEEN with an
  // owner — and that includes a read that succeeded and returned nothing.
  //
  // The error case is the obvious one. The `null` case is the subtler half and was
  // missed on the first pass: a storage read against state a node does not have
  // returns zero rather than failing, so a lagging or load-balanced RPC serving
  // pre-deployment state is indistinguishable from "no owner" — and would hand the
  // rotated-out key its access back through the counterfactual, which is precisely
  // the outcome this guard exists to prevent. A validator-address change or an
  // uninstalled ECDSA validator reads the same way.
  //
  // The record says this account HAS an owner. A read saying otherwise contradicts
  // it, and a contradiction is not evidence of control.
  //
  // `knownRotatedAway` is the same refusal reached from the other direction, and
  // it is what survives a CHAIN MOVE (#489). After the move a recovered account
  // is genuinely counterfactual on the new chain, so `knownDeployed` is correctly
  // false and the read correctly returns `null` — and the counterfactual, which
  // is derived from the ORIGINAL owner's init data on every chain at once, would
  // hand the retired key its access back. A key the account has been seen to move
  // away from anywhere is not evidence of control here.
  if (knownDeployed || knownRotatedAway) return false;

  // Never seen with an owner: the counterfactual is the only evidence there is, and
  // for a genuinely undeployed account it is sound — only the key whose init data
  // derives this address can ever deploy it.
  return counterfactualMatches;
}

export async function isKernelOwner(
  eoaAddress: string,
  parentAddress: string,
  opts: OwnerReadOptions = {},
): Promise<boolean> {
  const eoa = eoaAddress.toLowerCase();
  const parent = parentAddress.toLowerCase();

  const cached = _ownerCache.get(parent);
  const cacheFresh = cached !== undefined && Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS;
  const state = cacheFresh ? cached : await _fetchOwnerState(parent, eoa, opts);
  // A co-owned account has no single owner; `isAccountSigner` decides for it.
  if (state !== "error" && state.root === "weighted") return false;
  const ownerRead = state === "error" ? "error" : state.owner;
  const allowed = await _decideFromRead(ownerRead, eoa, parent);
  if (allowed && cacheFresh && cached.owner === eoa && !getKernelOwnerRecord(parent)) {
    // A confirmation from cache is as much a confirmed read as the one that
    // filled the cache — and that one may have been UNCONFIRMED (someone else
    // presenting the wrong key), which creates no record (#210). Without this,
    // an account could be confirmed for a whole TTL with no record, and an
    // unreadable chain after expiry would fall back to the counterfactual for a
    // Kernel we have in fact seen with an owner.
    recordKernelOwner(parent, cached.owner, cached.block);
  }
  if (allowed || !cacheFresh) return allowed;

  // A cached answer may confirm ownership, never deny it (#273): re-read the
  // chain before rejecting. The refresh also retires a rotated-OUT key on its
  // very next request instead of at TTL expiry — the #200 grace window shrinks
  // to first contact by the new owner.
  const again = await _fetchOwnerState(parent, eoa, opts);
  if (again !== "error" && again.root === "weighted") return false;
  return _decideFromRead(again === "error" ? "error" : again.owner, eoa, parent);
}

/**
 * How `eoa` may sign for the account at `parent`: as its single ECDSA `owner`
 * (every account until it holds two passkeys - exactly `isKernelOwner`), as a
 * `co-owner` on its weighted list (#746), or not at all.
 *
 * A Kernel that is not known to be co-owned takes the owner path first, so a
 * one-passkey account pays nothing new. When that path finds the root is the
 * weighted validator - from the read it made, or the re-read a cached denial
 * forces - the list decides.
 */
export async function accountSignerKind(
  eoaAddress: string,
  parentAddress: string,
  opts: OwnerReadOptions = {},
): Promise<"owner" | "co-owner" | null> {
  const eoa = eoaAddress.toLowerCase();
  const parent = parentAddress.toLowerCase();
  const knownWeighted = () => getKernelWeightedRecord(parent) !== undefined || _ownerCache.get(parent)?.root === "weighted";
  if (knownWeighted()) return (await _isWeightedMember(eoa, parent, opts)) ? "co-owner" : null;
  if (await isKernelOwner(eoa, parent, opts)) return "owner";
  if (knownWeighted()) return (await _isWeightedMember(eoa, parent, opts)) ? "co-owner" : null;
  return null;
}

/** May `eoa` sign for `parent` - as its owner or as one of its co-owners? */
export async function isAccountSigner(
  eoaAddress: string,
  parentAddress: string,
  opts: OwnerReadOptions = {},
): Promise<boolean> {
  return (await accountSignerKind(eoaAddress, parentAddress, opts)) !== null;
}

/**
 * Is `eoa` on the co-owner list of `parent`, which is known to be co-owned?
 *
 * Unreadable means NO: the account is known co-owned, so the counterfactual says
 * nothing about who controls it. A read that contradicts the last change seen for
 * this key, from no later a block, predates it and is not acted on. A read showing
 * the ECDSA root again is a replica from before the switch (refused) or, from a
 * later block, a root that changed back - and then only the owner it names decides.
 */
async function _isWeightedMember(eoa: string, parent: string, opts: OwnerReadOptions): Promise<boolean> {
  const key = `${parent}:${eoa}`;
  if (_memberConfirmed(parent, eoa)) return true;
  const read = await _fetchMember(parent, eoa, opts);
  if (read === "error") return false;
  if (read.root !== "weighted") {
    // A replica from before the switch (the owner read discards it), a root changed
    // back to ECDSA, or a root that does not read - which on an account seen
    // co-owned means unreadable, not undeployed. Only an owner the ECDSA root NAMES
    // decides, never the counterfactual, which the first passkey matches forever.
    _ownerCache.delete(parent);
    const state = await _fetchOwnerState(parent, eoa, opts);
    return state !== "error" && state.root === "ecdsa" && state.owner === eoa;
  }
  // The account's root is weighted at this block: a cached single owner from
  // before the switch must not keep confirming the first passkey (Fable sign-off
  // SHOULD-2 - the #273 "first contact by the new owner" rule).
  const oc = _ownerCache.get(parent);
  if (!oc || oc.block < read.block) {
    _ownerCache.set(parent, { owner: null, root: "weighted", block: read.block, fetchedAt: Date.now() });
    capMap(_ownerCache, OWNER_CACHE_MAX);
  }
  const threshold = read.threshold ?? 1;
  const member = threshold > 0 && read.weight >= threshold;
  const seen = _memberOrder.get(key);
  const removedAt = coOwnerRemovedBlock(parent, eoa);
  if (
    (seen && seen.member !== member && read.block <= seen.block) ||
    (member && removedAt !== undefined && read.block <= removedAt)
  ) {
    console.warn(`[kernel-owner] stale co-owner read for ${parent.slice(0, 10)}… discarded`);
    return false;
  }
  if (!seen || seen.member !== member) {
    _memberOrder.set(key, { member, block: read.block });
    capMap(_memberOrder, MEMBER_CACHE_MAX);
  }
  if (member) {
    _memberCache.set(key, { block: read.block, fetchedAt: Date.now() });
    capMap(_memberCache, MEMBER_CACHE_MAX);
    // Confirmed: the key on the list is the key presenting (#210 - only a confirmed
    // read creates a record).
    recordKernelWeighted(parent, read.block);
  } else {
    _memberCache.delete(key);
    // Durable floor for a key we know WAS on the list: this process saw it there,
    // or it is the account's recorded owner from before the switch.
    if (seen?.member || getKernelOwnerRecord(parent)?.owner === eoa) recordCoOwnerRemoved(parent, eoa, read.block);
  }
  return member;
}

/**
 * A co-owner asked to remove `eoa` (the device-record removal route). Read it
 * fresh and, if it is off the list and is a key we know was on it - a device
 * record (`knownDevice`), this process's memory, or the recorded owner from
 * before the switch (the first passkey, which has no device record) - floor it
 * durably. Returns whether the floor is in place. Never grants anything.
 */
export async function noteCoOwnerRemoved(
  eoaAddress: string,
  parentAddress: string,
  opts: OwnerReadOptions & { knownDevice?: boolean } = {},
): Promise<boolean> {
  const eoa = eoaAddress.toLowerCase();
  const parent = parentAddress.toLowerCase();
  if (!getKernelWeightedRecord(parent)) return false;
  const read = await _fetchMember(parent, eoa, opts);
  if (read === "error" || read.root !== "weighted") return false;
  const threshold = read.threshold ?? 1;
  if (threshold > 0 && read.weight >= threshold) return false;
  const evidence =
    opts.knownDevice === true || _memberOrder.get(`${parent}:${eoa}`)?.member === true || getKernelOwnerRecord(parent)?.owner === eoa;
  if (!evidence) return false;
  _memberCache.delete(`${parent}:${eoa}`);
  _memberOrder.set(`${parent}:${eoa}`, { member: false, block: read.block });
  recordCoOwnerRemoved(parent, eoa, read.block);
  return true;
}

async function _fetchMember(parent: string, eoa: string, opts: OwnerReadOptions): Promise<SignerRead | "error"> {
  const key = `${parent}:${eoa}`;
  if (!_inFlightMember.has(key) && opts.chainReadAllowed && !opts.chainReadAllowed()) {
    console.warn(`[kernel-owner] co-owner read for ${parent.slice(0, 10)}… refused: read budget exhausted`);
    return "error";
  }
  try {
    return await _readMemberAtBlock(parent, eoa);
  } catch {
    return "error";
  }
}

/** The raw chain call, one per (Kernel, key) at a time. */
function _readMemberAtBlock(parent: string, eoa: string): Promise<SignerRead> {
  const key = `${parent}:${eoa}`;
  const inFlight = _inFlightMember.get(key);
  if (inFlight) return inFlight;
  const p = (async (): Promise<SignerRead> => {
    if (_memberFetchOverride) {
      const read = await _memberFetchOverride(parent, eoa);
      if (read === "error") throw new Error("member fetch override: error");
      return read;
    }
    const [l2Block, root, guardian, storage] = await client().multicall({
      contracts: [
        { address: ARBSYS_ADDRESS, abi: ARBSYS_ABI, functionName: "arbBlockNumber" },
        { address: parent as Address, abi: KERNEL_ROOT_VALIDATOR_ABI, functionName: "rootValidator" },
        {
          address: WEIGHTED_ECDSA_VALIDATOR_V3_1 as Address,
          abi: WEIGHTED_GUARDIAN_ABI,
          functionName: "guardian",
          args: [eoa as Address, parent as Address],
        },
        {
          address: WEIGHTED_ECDSA_VALIDATOR_V3_1 as Address,
          abi: WEIGHTED_STORAGE_ABI,
          functionName: "weightedStorage",
          args: [parent as Address],
        },
      ],
      allowFailure: true,
    });
    if (l2Block.status !== "success" || guardian.status !== "success" || storage.status !== "success") {
      throw new Error("co-owner read failed");
    }
    return {
      root: rootKindOf(root),
      weight: Number(guardian.result[0]),
      threshold: Number(storage.result[1]),
      block: Number(l2Block.result),
    };
  })();
  _inFlightMember.set(key, p);
  p.finally(() => _inFlightMember.delete(key)).catch(() => {});
  return p;
}

async function _decideFromRead(
  ownerRead: string | null | "error",
  eoa: string,
  parent: string,
): Promise<boolean> {
  const unreadable = ownerRead === null || ownerRead === "error";
  const knownDeployed = unreadable ? isKernelKnownDeployed(parent) : false;
  const knownRotatedAway = unreadable ? knownOwnerDisagreesOnAnyChain(parent, eoa) : false;

  if (knownDeployed || knownRotatedAway) {
    // Distinguished in the log because the two say different things to an
    // operator: the first is "the chain disagrees with our memory", the second is
    // "this key was retired" — and only the second is expected traffic after a
    // chain move. Opaque 403s are the diagnosability problem #107 exists to fix.
    console.warn(
      `[kernel-owner] ${ownerRead === "error" ? "owner read failed" : "owner read returned none"} ` +
        `for ${knownDeployed ? "known-deployed" : "rotated-away"} ${parent.slice(0, 10)}… — refusing`,
    );
    return decideKernelOwnership({
      ownerRead,
      eoa,
      counterfactualMatches: false,
      knownDeployed,
      knownRotatedAway,
    });
  }

  // Only computed when it can still matter — it is a local CREATE2 derivation, but
  // there is no reason to run it on the path that has already decided.
  const counterfactualMatches =
    ownerRead === null || ownerRead === "error"
      ? (await kernelAddressOfOwner(eoa)) === parent
      : false;

  return decideKernelOwnership({ ownerRead, eoa, counterfactualMatches, knownDeployed, knownRotatedAway });
}
