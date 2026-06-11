/**
 * Stylus LikeAggregator (#5) — trustless on-chain trending over EAS likes.
 *
 * PULL model: the contract verifies attestation UIDs against EAS itself
 * (staticcall getAttestation), so anyone may submit them — the server is just
 * the convenient first keeper, not a trust anchor. This module is the thin
 * bridge: `pokeAggregator` pushes freshly verified UIDs (fire-and-forget,
 * permissionlessly replayable by anyone if we miss), `getTrendingOnChain`
 * replaces the projection as the trending READ. The projection remains the
 * fallback when the contract is unconfigured or the RPC is down — same
 * "cache, not truth" posture as the rest of the likes rail.
 *
 * Contract source: contracts-stylus/like-aggregator (Rust → WASM, Arb Sepolia).
 */

import { Contract, JsonRpcProvider, Wallet } from "ethers";
import {
  EAS_CHAIN_ID, SubjectType,
  STYLUS_LIKE_AGGREGATOR_ADDRESS, STYLUS_LIKE_AGGREGATOR_ABI,
} from "@woco/shared";
import type { Hex0x, TrendingSubject } from "@woco/shared";
import { getChainRpcUrl } from "../chain/event-contract.js";

export function aggregatorAddress(): string {
  return process.env.STYLUS_AGGREGATOR_ADDRESS ?? STYLUS_LIKE_AGGREGATOR_ADDRESS;
}

let _provider: JsonRpcProvider | null = null;
function provider(): JsonRpcProvider {
  if (!_provider) _provider = new JsonRpcProvider(getChainRpcUrl(EAS_CHAIN_ID), EAS_CHAIN_ID);
  return _provider;
}

function readContract(): Contract {
  return new Contract(aggregatorAddress(), [...STYLUS_LIKE_AGGREGATOR_ABI], provider());
}

let _keeper: Wallet | null = null;
function keeperContract(): Contract | null {
  const pk = process.env.WOCO_SPONSOR_PRIVATE_KEY;
  if (!pk) return null;
  if (!_keeper) _keeper = new Wallet(pk, provider());
  return new Contract(aggregatorAddress(), [...STYLUS_LIKE_AGGREGATOR_ABI], _keeper);
}

// Pokes are serialised: concurrent sends from one wallet race on the nonce.
let _pokeQueue: Promise<void> = Promise.resolve();

/**
 * Push a chain-verified attestation UID into the aggregator. Fire-and-forget:
 * a missed poke only delays the on-chain count — the UID stays submittable by
 * anyone forever, and `record` is idempotent (dedup by attester, no-op replays).
 * Call AFTER `getVerifiedLike` succeeded; works for both like (counts) and
 * unlike (the revoked UID decrements).
 */
export function pokeAggregator(uid: Hex0x): void {
  const contract = keeperContract();
  if (!contract) return;
  _pokeQueue = _pokeQueue
    .then(async () => {
      const tx = await contract.record(uid);
      const receipt = await tx.wait(1);
      console.log(`[stylus] record(${uid.slice(0, 10)}…) tx=${receipt?.hash} gas=${receipt?.gasUsed}`);
    })
    .catch((err) => {
      console.warn(`[stylus] poke failed for ${uid.slice(0, 10)}… (recoverable — anyone can resubmit):`, err?.message ?? err);
    });
}

async function trendingForType(
  contract: Contract,
  subjectType: SubjectType,
  limit: number,
): Promise<TrendingSubject[]> {
  // Single tuple return (see STYLUS_LIKE_AGGREGATOR_ABI note) — ethers unwraps
  // it to a Result of [subjects, counts].
  const result = await contract.getTrending(subjectType, limit);
  const subjects = result[0] as string[];
  const counts = result[1] as bigint[];
  return subjects.map((subject, i) => ({
    subject: subject.toLowerCase() as Hex0x,
    subjectType,
    count: Number(counts[i]),
  }));
}

/**
 * Trustless trending read. Returns null when the RPC call fails — the route
 * falls back to the server projection. `subjectType` undefined = both types
 * merged by count (the contract ranks per-type; profiles and events are
 * independent leaderboards on-chain).
 */
export async function getTrendingOnChain(
  subjectType?: SubjectType,
  limit = 20,
): Promise<TrendingSubject[] | null> {
  const contract = readContract();
  try {
    if (subjectType !== undefined) return await trendingForType(contract, subjectType, limit);
    const [profiles, events] = await Promise.all([
      trendingForType(contract, SubjectType.Profile, limit),
      trendingForType(contract, SubjectType.Event, limit),
    ]);
    return [...profiles, ...events].sort((a, b) => b.count - a.count).slice(0, limit);
  } catch (err) {
    console.warn("[stylus] getTrending read failed — falling back to projection:", (err as Error)?.message);
    return null;
  }
}
