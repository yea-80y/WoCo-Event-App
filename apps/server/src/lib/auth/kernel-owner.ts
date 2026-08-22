/**
 * Kernel-owner authorization for session delegations (2026-07 split-brain fix).
 *
 * Kernel-backed logins (passkey, web3auth) sign `AuthorizeSession` with their
 * RAW owner EOA key (ecrecover-able, RPC-free) while `message.parent` stays the
 * Kernel smart-account address — the user's identity and EAS attester. The
 * server authorizes the delegation iff the recovered EOA *owns* that Kernel:
 *
 *  1. Deterministic (no RPC): the Kernel v3.1 counterfactual CREATE2 address of
 *     the EOA equals the parent. Covers every non-recovered account, deployed
 *     or not — verified byte-equivalent to the client's createKernelAccount
 *     addresses on Arb Sepolia (kernel-addr-equivalence check, 2026-07-10).
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
 */

import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { getKernelAddressFromECDSA, getValidatorAddress } from "@zerodev/ecdsa-validator";
import { createPublicClient, http, zeroAddress, type Address, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { getChainRpcUrl } from "../chain/event-contract.js";
import { isKernelKnownDeployed, getKernelOwnerRecord, recordKernelOwner } from "./kernel-deployed.js";
import { observeOwnerRead, type OwnerRead } from "./kernel-owner-ordering.js";

/** Kernel deployments live on Arbitrum Sepolia (KERNEL_CHAIN_ID client-side). */
const KERNEL_CHAIN_ID = 421614;

const entryPoint = getEntryPoint("0.7");
const kernelVersion = KERNEL_V3_1;

let _client: PublicClient | null = null;
function client(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: arbitrumSepolia,
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
const _ownerCache = new Map<string, { owner: string | null; block: number; fetchedAt: number }>();
const OWNER_CACHE_TTL_MS = 5 * 60 * 1000;

/** kernel (lower) → the raw chain read in flight, shared by concurrent callers. */
const _inFlightReads = new Map<string, Promise<OwnerRead>>();

/** Test seam — replaces the on-chain owner fetch (RPC-free tests); null restores.
 *  The override returns what the chain would: the owner AND the block it was read
 *  at, so tests can replay reads out of order. */
let _ownerFetchOverride: ((kernel: string) => Promise<OwnerRead | "error">) | null = null;
export function _setOwnerFetchForTests(
  f: ((kernel: string) => Promise<OwnerRead | "error">) | null,
): void {
  _ownerFetchOverride = f;
}
export function _resetOwnerCacheForTests(): void {
  _ownerCache.clear();
  _inFlightReads.clear();
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
  return _fetchAndCacheOwner(key, undefined, opts);
}

/** The raw chain call, one per Kernel at a time: concurrent callers share it. */
function _readOwnerAtBlock(key: string): Promise<OwnerRead> {
  const inFlight = _inFlightReads.get(key);
  if (inFlight) return inFlight;
  const p = (async (): Promise<OwnerRead> => {
    if (_ownerFetchOverride) {
      const read = await _ownerFetchOverride(key);
      if (read === "error") throw new Error("owner fetch override: error");
      return read;
    }
    const validatorAddress = getValidatorAddress(entryPoint, kernelVersion);
    // One atomic read: the owner and the L2 block it was read at, from a single
    // `eth_call` through Multicall3 so both come from one replica at one state.
    const [l2Block, owner] = await client().multicall({
      contracts: [
        { address: ARBSYS_ADDRESS, abi: ARBSYS_ABI, functionName: "arbBlockNumber" },
        {
          address: validatorAddress as Address,
          abi: ECDSA_VALIDATOR_STORAGE_ABI,
          functionName: "ecdsaValidatorStorage",
          args: [key as Address],
        },
      ],
      allowFailure: false,
    });
    const lower = !owner || owner.toLowerCase() === zeroAddress ? null : owner.toLowerCase();
    return { owner: lower, block: Number(l2Block) };
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
async function _fetchAndCacheOwner(
  key: string,
  presentedBy: string | undefined,
  opts: OwnerReadOptions,
): Promise<string | null | "error"> {
  // Joining a read already in flight costs nothing, so it needs no budget.
  // A read this caller would START does.
  if (!_inFlightReads.has(key) && opts.chainReadAllowed && !opts.chainReadAllowed()) {
    console.warn(`[kernel-owner] owner read for ${key.slice(0, 10)}… refused: read budget exhausted`);
    return "error";
  }
  try {
    const read = await _readOwnerAtBlock(key);
    // Reconcile with what we already know, durably: a confirmed owner marks the
    // account deployed (so a LATER failed read refuses instead of falling back
    // to the counterfactual — #200, kernel-deployed.ts), and a rotation advances
    // the record so no lagging replica can roll it back.
    const owner = observeOwnerRead(key, read, presentedBy);
    if (owner === "stale") return "error";
    _ownerCache.set(key, { owner, block: read.block, fetchedAt: Date.now() });
    capMap(_ownerCache, OWNER_CACHE_MAX);
    return owner;
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
  /** Has this Kernel ever been observed WITH an on-chain owner? */
  knownDeployed: boolean;
}): boolean {
  const { ownerRead, eoa, counterfactualMatches, knownDeployed } = args;

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
  if (knownDeployed) return false;

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
  const ownerRead = cacheFresh ? cached.owner : await _fetchAndCacheOwner(parent, eoa, opts);
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
  return _decideFromRead(await _fetchAndCacheOwner(parent, eoa, opts), eoa, parent);
}

async function _decideFromRead(
  ownerRead: string | null | "error",
  eoa: string,
  parent: string,
): Promise<boolean> {
  const knownDeployed =
    ownerRead === null || ownerRead === "error" ? isKernelKnownDeployed(parent) : false;

  if (knownDeployed) {
    console.warn(
      `[kernel-owner] ${ownerRead === "error" ? "owner read failed" : "owner read returned none"} ` +
        `for known-deployed ${parent.slice(0, 10)}… — refusing`,
    );
    return decideKernelOwnership({ ownerRead, eoa, counterfactualMatches: false, knownDeployed });
  }

  // Only computed when it can still matter — it is a local CREATE2 derivation, but
  // there is no reason to run it on the path that has already decided.
  const counterfactualMatches =
    ownerRead === null || ownerRead === "error"
      ? (await kernelAddressOfOwner(eoa)) === parent
      : false;

  return decideKernelOwnership({ ownerRead, eoa, counterfactualMatches, knownDeployed });
}
