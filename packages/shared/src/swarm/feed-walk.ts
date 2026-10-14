/**
 * The newest update of a sequence feed, found WITHOUT Bee's feed lookup.
 *
 * Bee's sequence finder (`pkg/feeds/sequence`, v2.6 through master) gives each probe
 * a hardcoded 1 s and reads a slow probe as "absent", so a node that has to fetch the
 * updates can answer an OLDER index, or 404 (ethersphere/bee#5251). Measured
 * 2026-10-14: woco.eth.limo handed a phone index 224 while 241 was current.
 *
 * Here the caller starts from an index it already holds and probes forward by
 * computed SOC address. A hit counts only once its signature recovers to the feed
 * owner, so any source may serve one; a miss, a timeout or a refusal never moves the
 * answer. A slow, lossy or hostile source can delay an upgrade, never cause a
 * downgrade.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { calculateCacAddress, calculateSocAddress, encodeSpan, splitStoredSoc } from "./soc.js";

/** One update of the feed: its index and the 64-hex reference it points at. */
export interface FeedPoint {
  index: number;
  ref: string;
  /** Seconds since epoch, from the v1 payload. */
  timestamp: number;
}

/**
 * What one source said about one chunk address. `absent` is that source's claim
 * only; `unknown` covers timeouts, refusals and errors. The walk treats both as
 * "no hit", so neither can lower an answer.
 */
export type ChunkRead = { kind: "found"; bytes: Uint8Array } | { kind: "absent" } | { kind: "unknown"; reason: string };

/** Reads raw stored chunk bytes (`GET /chunks/{address}`) from one source. */
export type ChunkSource = (addressHex: string, signal: AbortSignal) => Promise<ChunkRead>;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PERSONAL_PREFIX = utf8ToBytes("\x19Ethereum Signed Message:\n32");
/** v1 feed payload: 8-byte big-endian timestamp, then a 32-byte reference. */
const V1_PAYLOAD_SIZE = 40;
/** Bee's own probe shape: base+1, +2, +4 ... +128 per round. */
const ROUND_OFFSETS = [1, 2, 4, 8, 16, 32, 64, 128];

const strip0x = (h: string) => h.replace(/^0x/i, "").toLowerCase();

function uint64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The SOC identifier of update `index`: keccak256(topic || uint64be(index)). */
export function feedUpdateIdentifier(topicHex: string, index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("index must be a non-negative integer");
  const topic = strip0x(topicHex);
  if (!HEX64.test(topic)) throw new Error("topic must be 32 bytes of hex");
  return keccak_256(concatBytes(hexToBytes(topic), uint64be(index)));
}

/** Where update `index` is stored: keccak256(identifier || owner), as hex. */
export function feedUpdateAddress(ownerHex: string, topicHex: string, index: number): string {
  const owner = strip0x(ownerHex);
  if (!HEX40.test(owner)) throw new Error("owner must be a 20-byte address");
  return bytesToHex(calculateSocAddress(feedUpdateIdentifier(topicHex, index), hexToBytes(owner)));
}

/**
 * The update at `index` if `raw` is exactly that SOC, signed by `owner`, carrying a
 * v1 payload; otherwise null. The signature is Bee's: personal-sign over
 * keccak256(identifier || cacAddress), which is what bee-js `Signature` recovers.
 */
export function verifyFeedUpdate(
  raw: Uint8Array,
  expected: { owner: string; topic: string; index: number },
): FeedPoint | null {
  try {
    const parts = splitStoredSoc(raw);
    if (!parts) return null;
    const identifier = feedUpdateIdentifier(expected.topic, expected.index);
    if (bytesToHex(parts.identifier) !== bytesToHex(identifier)) return null;
    if (bytesToHex(parts.span) !== bytesToHex(encodeSpan(parts.payload.length))) return null;
    if (parts.payload.length !== V1_PAYLOAD_SIZE) return null;

    const v = parts.signature[64]!;
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery !== 0 && recovery !== 1) return null;
    const compact = new Uint8Array(65);
    compact[0] = recovery;
    compact.set(parts.signature.subarray(0, 64), 1);
    const inner = keccak_256(concatBytes(identifier, calculateCacAddress(parts.span, parts.payload)));
    const digest = keccak_256(concatBytes(PERSONAL_PREFIX, inner));
    const pub = secp256k1.Signature.fromBytes(compact, "recovered").recoverPublicKey(digest).toBytes(false);
    const signer = bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
    if (signer !== strip0x(expected.owner)) return null;

    const ts = parts.payload.subarray(0, 8);
    let timestamp = 0;
    for (const b of ts) timestamp = timestamp * 256 + b;
    return { index: expected.index, ref: bytesToHex(parts.payload.subarray(8, 40)), timestamp };
  } catch {
    return null;
  }
}

/** An AbortSignal that fires on `ms` or when `outer` does (AbortSignal.any is too new for older Safari). */
function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void; abort: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const onOuter = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
    abort: () => ctl.abort(),
  };
}

export interface WalkOptions {
  owner: string;
  topic: string;
  /** The highest index the caller already holds. Only indices above it are probed. */
  fromIndex: number;
  /** Asked in parallel for every probe; the first verified hit wins. */
  sources: ChunkSource[];
  /** Per probe, per source. A probe that runs out is `unknown`, never absent. */
  probeTimeoutMs: number;
  signal?: AbortSignal;
  /** Each time the walk moves forward, with the newest verified update so far. */
  onAdvance?: (point: FeedPoint) => void;
  /** Upper bound on rounds; each round can advance up to 128 indices. */
  maxRounds?: number;
}

async function probe(opts: WalkOptions, index: number): Promise<FeedPoint | null> {
  const address = feedUpdateAddress(opts.owner, opts.topic, index);
  // The first verified hit settles the probe; the other sources are cancelled.
  const settled = timeoutSignal(opts.probeTimeoutMs, opts.signal);
  const attempts = opts.sources.map(async (source) => {
    const t = timeoutSignal(opts.probeTimeoutMs, settled.signal);
    try {
      const read = await source(address, t.signal);
      if (read.kind !== "found") throw new Error(read.kind);
      const point = verifyFeedUpdate(read.bytes, { owner: opts.owner, topic: opts.topic, index });
      if (!point) throw new Error("unverified");
      return point;
    } finally {
      t.done();
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  } finally {
    settled.done();
    settled.abort();
  }
}

/**
 * The newest verified update above `fromIndex`, or null when no source showed one.
 * Gaps are fine: a hit at +4 with +1..+3 missing still moves the walk to +4.
 */
export async function walkFeedForward(opts: WalkOptions): Promise<FeedPoint | null> {
  let best: FeedPoint | null = null;
  let base = opts.fromIndex;
  const maxRounds = opts.maxRounds ?? 8;
  for (let round = 0; round < maxRounds; round++) {
    if (opts.signal?.aborted) break;
    const hits = await Promise.all(ROUND_OFFSETS.map((o) => probe(opts, base + o)));
    let top: FeedPoint | null = null;
    for (const h of hits) if (h && (!top || h.index > top.index)) top = h;
    if (!top) break;
    best = top;
    base = top.index;
    opts.onAdvance?.(top);
  }
  return best;
}

/**
 * A `ChunkSource` over a Bee-shaped HTTP API (`{baseUrl}/chunks/{address}`): our
 * gateway, or the Bee node a page was served from. 404 is that source's absence
 * claim; anything else that is not a 200 - including our gateway's whitelist
 * refusal, which is data-plane state - is unknown.
 */
export function httpChunkSource(baseUrl: string, fetchImpl: typeof fetch = fetch): ChunkSource {
  const root = baseUrl.replace(/\/+$/, "");
  return async (address, signal) => {
    try {
      const res = await fetchImpl(`${root}/chunks/${address}`, { signal });
      if (res.status === 404) return { kind: "absent" };
      if (!res.ok) return { kind: "unknown", reason: `HTTP ${res.status}` };
      return { kind: "found", bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch (e) {
      return { kind: "unknown", reason: (e as Error)?.name === "AbortError" ? "timeout" : "network" };
    }
  };
}
