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
 */

import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { getKernelAddressFromECDSA, getValidatorAddress } from "@zerodev/ecdsa-validator";
import { createPublicClient, http, zeroAddress, type Address, type PublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { getChainRpcUrl } from "../chain/event-contract.js";
import { isKernelKnownDeployed, markKernelDeployed } from "./kernel-deployed.js";

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

/** owner EOA (lower) → counterfactual Kernel (lower). Pure CREATE2 — immutable,
 *  cache forever. */
const _kernelOfCache = new Map<string, string>();

/** kernel (lower) → { owner (lower) | null (undeployed/unset), fetchedAt }.
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
 *  a wrong-key attempt pays one eth_call, behind the auth rate limits. */
const _ownerCache = new Map<string, { owner: string | null; fetchedAt: number }>();
const OWNER_CACHE_TTL_MS = 5 * 60 * 1000;

/** Test seam — replaces the on-chain owner fetch (RPC-free tests); null restores. */
let _ownerFetchOverride: ((kernel: string) => Promise<string | null | "error">) | null = null;
export function _setOwnerFetchForTests(
  f: ((kernel: string) => Promise<string | null | "error">) | null,
): void {
  _ownerFetchOverride = f;
}
export function _resetOwnerCacheForTests(): void {
  _ownerCache.clear();
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
    return kernel;
  } catch {
    return null;
  }
}

/** Live on-chain ECDSA sudo owner of a Kernel: lowercased address, `null` when
 *  the Kernel is not deployed / owner unset, `"error"` when the read failed
 *  (RPC outage) — callers must distinguish "provably no owner" from "unknown". */
export async function readKernelOwner(kernelAddress: string): Promise<string | null | "error"> {
  const key = kernelAddress.toLowerCase();
  const cached = _ownerCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS) return cached.owner;
  return _fetchAndCacheOwner(key);
}

/** The live read itself: caches definitive answers, never caches "error". */
async function _fetchAndCacheOwner(key: string): Promise<string | null | "error"> {
  try {
    if (_ownerFetchOverride) {
      const owner = await _ownerFetchOverride(key);
      if (owner === "error") return "error";
      if (owner) markKernelDeployed(key);
      _ownerCache.set(key, { owner, fetchedAt: Date.now() });
      return owner;
    }
    const validatorAddress = getValidatorAddress(entryPoint, kernelVersion);
    const owner = (await client().readContract({
      address: validatorAddress as Address,
      abi: ECDSA_VALIDATOR_STORAGE_ABI,
      functionName: "ecdsaValidatorStorage",
      args: [key as Address],
    })) as Address;
    const lower = !owner || owner.toLowerCase() === zeroAddress ? null : owner.toLowerCase();
    // A real owner means this account is deployed and has one. Remember that
    // durably: it is what tells a LATER failed read that the counterfactual
    // fallback no longer applies here (#200, kernel-deployed.ts).
    if (lower) markKernelDeployed(key);
    _ownerCache.set(key, { owner: lower, fetchedAt: Date.now() });
    return lower;
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

export async function isKernelOwner(eoaAddress: string, parentAddress: string): Promise<boolean> {
  const eoa = eoaAddress.toLowerCase();
  const parent = parentAddress.toLowerCase();

  const cached = _ownerCache.get(parent);
  const cacheFresh = cached !== undefined && Date.now() - cached.fetchedAt < OWNER_CACHE_TTL_MS;
  const ownerRead = cacheFresh ? cached.owner : await _fetchAndCacheOwner(parent);
  const allowed = await _decideFromRead(ownerRead, eoa, parent);
  if (allowed || !cacheFresh) return allowed;

  // A cached answer may confirm ownership, never deny it (#273): re-read the
  // chain before rejecting. The refresh also retires a rotated-OUT key on its
  // very next request instead of at TTL expiry — the #200 grace window shrinks
  // to first contact by the new owner.
  return _decideFromRead(await _fetchAndCacheOwner(parent), eoa, parent);
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
