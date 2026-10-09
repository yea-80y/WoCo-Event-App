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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { KERNEL_CHAIN_ID } from "@woco/shared";
import { KEY_RING_ANCHOR_ABI, KEY_RING_ANCHOR_ADDRESS, anchorToRingRef } from "@woco/shared/keyring/anchor";
import { MAX_KEY_RING_BYTES, parseKeyRing, type KeyRing } from "@woco/shared/keyring/ring";
import { BytesTreeMismatchError, readBytesTree } from "@woco/shared/swarm/bytes-tree";
import { writeJsonAtomic } from "../marketing/persist.js";
import { getChainRpcUrl } from "../chain/event-contract.js";
import { ethernaSource, wocoBeeSource } from "../swarm/soc-read.js";

export { MAX_KEY_RING_BYTES };
export const ANCHOR_TTL_MS = 30_000;
const RING_CACHE_MAX = 1_000;
const ANCHOR_CACHE_MAX = 10_000;
/** A ring whose chunks could not be found is tried again after this - never on every read. */
const MISSING_RING_RETRY_MS = 60_000;
const HIGH_WATER_FILE = join(process.cwd(), ".data", "keyring-high-water.json");

/** The highest generation this server has seen per account, and a ring of it. */
type HighWater = Record<string, { gen: number; ref: string }>;

export type CurrentRing =
  | { status: "none" }
  | { status: "ring"; ref: string; ring: KeyRing }
  | { status: "unavailable"; reason: string };

export interface CurrentRingDeps {
  /** `ringOf(account)` as bytes32 hex. Throws when the chain cannot answer. */
  readAnchor(account: string): Promise<string>;
  /** A chunk as `GET /chunks/{address}` returns it. Throws when no source has it. */
  fetchChunk(address: string): Promise<Uint8Array>;
  /** The anchor's runtime code, for the health probe. Throws when the chain cannot answer. */
  readAnchorCode(): Promise<string | undefined>;
  now(): number;
  /** The persisted high-water marks; "unreadable" when the file exists but cannot be used. */
  loadHighWater(): HighWater | "unreadable";
  saveHighWater(v: HighWater): boolean;
}

function loadHighWaterFile(): HighWater | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(HIGH_WATER_FILE, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? {} : "unreadable";
  }
  try {
    const v = JSON.parse(raw) as { v?: unknown; accounts?: unknown };
    if (v.v !== 1 || !v.accounts || typeof v.accounts !== "object") return "unreadable";
    const out: HighWater = {};
    for (const [a, hw] of Object.entries(v.accounts as Record<string, { gen?: unknown; ref?: unknown }>)) {
      if (!/^0x[0-9a-f]{40}$/.test(a) || !Number.isSafeInteger(hw?.gen) || typeof hw?.ref !== "string" || !/^[0-9a-f]{64}$/.test(hw.ref)) {
        return "unreadable";
      }
      out[a] = { gen: hw.gen as number, ref: hw.ref };
    }
    return out;
  } catch {
    return "unreadable";
  }
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
  readAnchorCode: () => client().getCode({ address: KEY_RING_ANCHOR_ADDRESS as Address }),
  now: () => Date.now(),
  loadHighWater: loadHighWaterFile,
  saveHighWater: (v) => writeJsonAtomic(HIGH_WATER_FILE, { v: 1, accounts: v }, "keyring-high-water"),
};

let deps: CurrentRingDeps = liveDeps;
const anchors = new Map<string, { ref: string | null; at: number }>();
const rings = new Map<string, KeyRing>();
// Refs that did not give a ring: a content-addressed ref that fails to verify or parse
// never will (kept for good); chunks not found may arrive, so those wait a minute.
// Either way an account cannot make its event reads refetch a bad ring every time.
const badRings = new Map<string, { reason: string; until: number }>();
let highWater: Map<string, { gen: number; ref: string }> | null = null;
let highWaterUnreadable = false;

/** Tests only: swap the chain and Swarm reads, and forget everything cached. The
 *  high-water marks live in memory unless the test passes its own. */
export function _setCurrentRingDepsForTests(d: Partial<CurrentRingDeps> | null): void {
  let mem: HighWater = {};
  const memory: Pick<CurrentRingDeps, "loadHighWater" | "saveHighWater"> = {
    loadHighWater: () => ({ ...mem }),
    saveHighWater: (v) => ((mem = { ...v }), true),
  };
  deps = d ? { ...liveDeps, ...memory, ...d } : liveDeps;
  anchors.clear();
  rings.clear();
  badRings.clear();
  highWater = null;
  highWaterUnreadable = false;
}

function boundedSet<V>(m: Map<string, V>, k: string, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

async function ringAt(ref: string, account: string): Promise<KeyRing> {
  let ring = rings.get(ref);
  if (!ring) {
    const bad = badRings.get(ref);
    if (bad && deps.now() < bad.until) throw new Error(bad.reason);
    let bytes: Uint8Array;
    try {
      bytes = await readBytesTree(ref, deps.fetchChunk, MAX_KEY_RING_BYTES);
    } catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      const until = e instanceof BytesTreeMismatchError ? Infinity : deps.now() + MISSING_RING_RETRY_MS;
      boundedSet(badRings, ref, { reason, until }, RING_CACHE_MAX);
      throw e;
    }
    try {
      ring = parseKeyRing(bytes);
    } catch (e) {
      boundedSet(badRings, ref, { reason: (e as Error)?.message ?? String(e), until: Infinity }, RING_CACHE_MAX);
      throw e;
    }
    boundedSet(rings, ref, ring, RING_CACHE_MAX);
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
 * device telling us it just moved. `strict`: an unreadable chain is unavailable even
 * with a ring seen before - for an answer that says what the chain says NOW.
 */
export async function currentRing(account: string, opts: { fresh?: boolean; strict?: boolean } = {}): Promise<CurrentRing> {
  const a = account.toLowerCase();
  return holdHighWater(a, await readCurrent(a, opts));
}

function highWaterMarks(): Map<string, { gen: number; ref: string }> {
  if (highWater) return highWater;
  const loaded = deps.loadHighWater();
  highWaterUnreadable = loaded === "unreadable";
  if (highWaterUnreadable) {
    console.error(
      "[keyring] ALARM: keyring-high-water.json exists but cannot be read - it will NOT be written until it is " +
        "repaired or restored and the server restarted; until then a lagging chain read after a restart is not caught",
    );
  }
  highWater = new Map(Object.entries(loaded === "unreadable" ? {} : loaded));
  return highWater;
}

/**
 * Never below the highest generation this server has EVER seen for the account, across
 * restarts (the in-memory rule in `readCurrent` covers a running process only): a
 * lagging replica answering an older ring would hand the money path keys a removed
 * passkey still holds. Versions within a generation share its keys, so the mark is the
 * generation.
 */
async function holdHighWater(a: string, r: CurrentRing): Promise<CurrentRing> {
  if (r.status === "unavailable") return r;
  const marks = highWaterMarks();
  const hw = marks.get(a);
  if (hw && (r.status === "none" || r.ring.gen < hw.gen)) {
    console.error(`[keyring] ${a}: chain read is behind generation ${hw.gen} already seen - keeping it`);
    const held = await resolve(a, hw.ref);
    if (held.status !== "ring") return { status: "unavailable", reason: `generation ${hw.gen} seen before is unreadable` };
    boundedSet(anchors, a, { ref: hw.ref, at: deps.now() }, ANCHOR_CACHE_MAX);
    return held;
  }
  if (r.status === "ring" && (!hw || r.ring.gen > hw.gen)) {
    marks.set(a, { gen: r.ring.gen, ref: r.ref });
    if (!highWaterUnreadable && !deps.saveHighWater(Object.fromEntries(marks))) {
      console.error(`[keyring] ${a}: generation ${r.ring.gen} not made durable - held in memory only`);
    }
  }
  return r;
}

async function readCurrent(a: string, opts: { fresh?: boolean; strict?: boolean }): Promise<CurrentRing> {
  const cached = anchors.get(a);
  if (cached && !opts.fresh && deps.now() - cached.at < ANCHOR_TTL_MS) return resolve(a, cached.ref);

  let read: string | null;
  try {
    read = anchorToRingRef(await deps.readAnchor(a));
  } catch (e) {
    if (!cached || opts.strict) return { status: "unavailable", reason: `anchor unreadable: ${rpcReason(e)}` };
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
      boundedSet(anchors, a, { ref: cached.ref, at: deps.now() }, ANCHOR_CACHE_MAX);
      return before;
    }
  }
  boundedSet(anchors, a, { ref: read, at: deps.now() }, ANCHOR_CACHE_MAX);
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

// ---------------------------------------------------------------------------
// Health: the anchor must exist. Without it every ring read fails, and since an
// unreadable ring is never taken for "no ring", every recorded event stops being
// read - so a server deployed ahead of the contract is a red alarm, not a quiet outage.
// ---------------------------------------------------------------------------

let anchorCheck: { ok: boolean | null; checkedAt: string | null; reason?: string } = { ok: null, checkedAt: null };

export async function refreshKeyRingAnchor(): Promise<void> {
  const checkedAt = new Date(deps.now()).toISOString();
  try {
    const code = await deps.readAnchorCode();
    anchorCheck = code && code !== "0x"
      ? { ok: true, checkedAt }
      : { ok: false, checkedAt, reason: "no contract at the key-ring anchor: every organiser-signed event is unreadable until it is deployed" };
  } catch (e) {
    // A failed read says nothing about the contract: keep the last verdict, note why.
    anchorCheck = { ...anchorCheck, checkedAt, reason: `anchor code unreadable: ${rpcReason(e)}` };
    if (anchorCheck.ok === null) anchorCheck = { ok: null, checkedAt, reason: anchorCheck.reason };
  }
}

export function keyRingHealth(): { ok: boolean | null; anchor: string; chainId: number; checkedAt: string | null; reason?: string } {
  highWaterMarks();
  if (highWaterUnreadable) {
    return { anchor: KEY_RING_ANCHOR_ADDRESS, chainId: KERNEL_CHAIN_ID, ok: false, checkedAt: anchorCheck.checkedAt, reason: "keyring-high-water.json is unreadable - restore it" };
  }
  return { anchor: KEY_RING_ANCHOR_ADDRESS, chainId: KERNEL_CHAIN_ID, ...anchorCheck };
}

