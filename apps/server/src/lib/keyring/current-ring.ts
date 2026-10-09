/**
 * An account's CURRENT key ring (#186), as the chain names it: one `ringOf(account)`
 * read on the key-ring anchor, then the ring's bytes from Swarm, checked chunk by chunk
 * against that reference. Nothing here is server state - it is the same answer any
 * reader gets from chain + Swarm, cached.
 *
 * The money path asks for it on every event read: a ring names the account's current
 * content-feed signer and order key, which a removed passkey no longer has.
 *
 * Caching: the anchor for `ANCHOR_TTL_MS` (a removing device calls `refreshRing` the
 * moment its op lands, so that wait applies only to everyone else), ring bytes by
 * reference forever (content-addressed). When the chain cannot be read, the last ring
 * seen for the account is used: rings only move forward, so a stale one is at worst the
 * generation before a removal this server has not seen yet. With nothing seen, the
 * answer is `unavailable` - never "no ring", which would mean generation 0.
 */

import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { KERNEL_CHAIN_ID } from "@woco/shared";
import { KEY_RING_ANCHOR_ABI, KEY_RING_ANCHOR_ADDRESS, anchorToRingRef } from "@woco/shared/keyring/anchor";
import { parseKeyRing, type KeyRing } from "@woco/shared/keyring/ring";
import { readBytesTree } from "@woco/shared/swarm/bytes-tree";
import { getChainRpcUrl } from "../chain/event-contract.js";
import { ethernaSource, wocoBeeSource } from "../swarm/soc-read.js";

/** A ring holds at most ten X-Wing entries plus a back blob: well under this. */
export const MAX_KEY_RING_BYTES = 64 * 1024;
export const ANCHOR_TTL_MS = 30_000;
const RING_CACHE_MAX = 1_000;

export type CurrentRing =
  | { status: "none" }
  | { status: "ring"; ref: string; ring: KeyRing }
  | { status: "unavailable"; reason: string };

export interface CurrentRingDeps {
  /** `ringOf(account)` as bytes32 hex. Throws when the chain cannot answer. */
  readAnchor(account: string): Promise<string>;
  /** A chunk as `GET /chunks/{address}` returns it. Throws when no source has it. */
  fetchChunk(address: string): Promise<Uint8Array>;
  now(): number;
}

let _client: PublicClient | null = null;
function client(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: KERNEL_CHAIN_ID === 42161 ? arbitrum : arbitrumSepolia,
      transport: http(getChainRpcUrl(KERNEL_CHAIN_ID)),
    }) as PublicClient;
  }
  return _client;
}
const ANCHOR_ABI = parseAbi(KEY_RING_ANCHOR_ABI);

const liveDeps: CurrentRingDeps = {
  readAnchor: (account) =>
    client().readContract({
      address: KEY_RING_ANCHOR_ADDRESS as Address,
      abi: ANCHOR_ABI,
      functionName: "ringOf",
      args: [account as Address],
    }) as Promise<string>,
  fetchChunk: async (address) => {
    for (const source of [wocoBeeSource, ethernaSource]) {
      const r = await source.read(address);
      if (r.status === "found") return r.raw;
    }
    throw new Error(`chunk ${address} not found`);
  },
  now: () => Date.now(),
};

let deps: CurrentRingDeps = liveDeps;
const anchors = new Map<string, { ref: string | null; at: number }>();
const rings = new Map<string, KeyRing>();

/** Tests only: swap the chain and Swarm reads, and forget everything cached. */
export function _setCurrentRingDepsForTests(d: Partial<CurrentRingDeps> | null): void {
  deps = d ? { ...liveDeps, ...d } : liveDeps;
  anchors.clear();
  rings.clear();
}

async function ringAt(ref: string, account: string): Promise<KeyRing> {
  let ring = rings.get(ref);
  if (!ring) {
    ring = parseKeyRing(await readBytesTree(ref, deps.fetchChunk, MAX_KEY_RING_BYTES));
    rings.set(ref, ring);
    while (rings.size > RING_CACHE_MAX) rings.delete(rings.keys().next().value as string);
  }
  // On EVERY answer, cached or not: any account may write any reference into its own
  // entry, so another account's ring is never this account's, however it was cached.
  if (ring.parent !== account) throw new Error(`ring ${ref} names account ${ring.parent}`);
  return ring;
}

/**
 * An RPC failure, said without the RPC: viem puts the request URL in `message`, and an
 * RPC URL can carry a provider key (`RPC_URL_{chainId}`). Its `shortMessage` does not.
 */
function rpcReason(e: unknown): string {
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage;
  if (typeof short === "string" && short) return short;
  return "RPC error";
}

/**
 * The account's current ring. `fresh` skips the anchor cache - for the account's own
 * device telling us it just moved.
 */
export async function currentRing(account: string, opts: { fresh?: boolean } = {}): Promise<CurrentRing> {
  const a = account.toLowerCase();
  const cached = anchors.get(a);
  if (cached && !opts.fresh && deps.now() - cached.at < ANCHOR_TTL_MS) return resolve(a, cached.ref);

  let read: string | null;
  try {
    read = anchorToRingRef(await deps.readAnchor(a));
  } catch (e) {
    if (!cached) return { status: "unavailable", reason: `anchor unreadable: ${rpcReason(e)}` };
    console.warn(`[keyring] ${a}: anchor unreadable, using the ring last seen`);
    return resolve(a, cached.ref);
  }
  // Never step back behind a ring already seen: a lagging replica can answer with an
  // older entry, and an older generation is keys a removed passkey still holds.
  if (cached?.ref && read !== cached.ref) {
    const before = await resolve(a, cached.ref);
    const now = read === null ? null : await resolve(a, read);
    if (before.status === "ring" && (now === null || (now.status === "ring" && now.ring.gen < before.ring.gen))) {
      console.error(`[keyring] ${a}: chain read is behind the ring already seen (${cached.ref}) - keeping it`);
      anchors.set(a, { ref: cached.ref, at: deps.now() });
      return before;
    }
  }
  anchors.set(a, { ref: read, at: deps.now() });
  return resolve(a, read);
}

async function resolve(account: string, ref: string | null): Promise<CurrentRing> {
  if (ref === null) return { status: "none" };
  try {
    return { status: "ring", ref, ring: await ringAt(ref, account) };
  } catch (e) {
    return { status: "unavailable", reason: `ring ${ref} unreadable: ${(e as Error)?.message ?? String(e)}` };
  }
}
