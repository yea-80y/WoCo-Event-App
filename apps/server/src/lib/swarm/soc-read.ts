/**
 * Verified, source-listed SOC read for the client's server fallback (#156).
 *
 * THE TWO DEFECTS THIS REPLACES. `GET /api/swarm/soc/:owner/:identifier` used
 * to return a bare payload the client took on trust — the one read path in the
 * stack with no signature check, reached exactly when a hostile or broken origin
 * could create the condition — and it minted its 404 from a reader whose `null`
 * meant "absent OR bee 500 OR Etherna unreachable OR bad token OR timeout". The
 * client treats a server 404 as a verdict and caches off it (#138), so both
 * halves were security properties dressed as availability niceties.
 *
 * NOW. Every source returns the tri-state; a `found` is the raw STORED chunk,
 * which is re-verified here (identifier matches, span matches the payload, the
 * signature recovers to the owner) and returned WHOLE so the client can verify
 * it again — the server is a transport, not a trust root. Aggregation:
 *   any verified found            → found
 *   any source unreachable        → unavailable  (never a 404)
 *   every verdict source absent   → absent       (the only real negative)
 *   nothing authoritative spoke   → unavailable
 *
 * SOURCES. Our bee is the verdict source: a 404 from it is the end of a full
 * network search (verified on the deployed node 2026-08-23: `404 {"code":404,
 * "message":"chunk not found"}` after ~2 s, twice). Anything else from it —
 * including the 500 "read chunk failed" the old reader mapped to not-found — is
 * a retrieval fault, not an answer. Etherna is consulted ONLY when the caller
 * says the feed is Etherna-stamped (`gatewayUrl`): it exists for the seconds
 * between an Etherna-stamped write and its arrival on the public net, and the
 * price of asking is that an Etherna outage makes THIS read unavailable — which
 * on the write path means "refuse to write", the honest answer for a feed whose
 * head may sit in Etherna's store. WoCo-stamped feeds never pay that price.
 * With the Etherna failover on (#912) an outage costs only the addresses that
 * really may sit there: this server is Etherna's only writer, so the relay
 * ledger lists them, and our bee's 404 decides every other address.
 * Adding an operator's gateway, or a user's own bee, is one more entry in
 * `sourcesFor`, not a new branch.
 *
 * ONE READER FOR BOTH (#657). The server's own feed scans (soc-upload.ts) read
 * through here too, routed by the caller's FAMILY from the shared table instead
 * of by a request's gateway. They used to read through a bee-js reader with an
 * Etherna fallback that ran for every feed and returned "absent" whenever
 * Etherna could not answer - so a scan of an Etherna-stamped feed during an
 * Etherna blip stopped at the previous version and called it clean.
 */

import { Signature } from "@ethersphere/bee-js";
import {
  FEED_FAMILIES,
  FEED_FAMILY_STORES,
  calculateCacAddress,
  calculateSocAddress,
  encodeSpan,
  socSignDigest,
  splitStoredSoc,
  SOC_IDENTIFIER_SIZE,
  type FeedFamily,
  type FeedStore,
} from "@woco/shared";
import { BEE_URL } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS } from "./upload-queue.js";
import { whitelistHashes } from "./whitelist.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { registerEthernaOffer } from "../etherna/upload.js";
import { isEthernaGateway } from "../etherna/batch-router.js";
import { ETHERNA_FETCH_BASE } from "../etherna/gateway.js";
import { ethernaBreakerHealth, ethernaPaused, noteEthernaFailure } from "../etherna/breaker.js";
import { relayLedgerClearsAbsent } from "../etherna/relay-ledger.js";
import { SWARM_CHUNK_MAX_BYTES, readCapped } from "../http/read-capped.js";

const ETHERNA_GW = ETHERNA_FETCH_BASE;
const ETHERNA_READ_TIMEOUT_MS = 8_000;

export type RawSocRead =
  | { status: "found"; raw: Uint8Array }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export interface SocSource {
  name: string;
  /**
   * "verdict": this source ran a complete retrieval, so its miss means the chunk
   * is not on the network. "hint": its miss proves nothing (a light client, a
   * browser node, a store that only knows what was pushed to it) — it can only
   * ever contribute a `found`.
   */
  negativeAuthority: "verdict" | "hint";
  /**
   * Everything this source may hold that the other verdict sources cannot see
   * yet was sent to it by this server and is listed in the relay ledger (#912).
   * When it cannot be asked, an address the ledger does not list is decided by
   * the others. Etherna only: nothing but this server writes there.
   */
  listedInRelayLedger?: boolean;
  read: (socAddressHex: string) => Promise<RawSocRead>;
}

/** A SOC as stored — the fields a reader needs to verify it independently. */
export interface VerifiedSoc {
  /** Lowercased owner address (no 0x). */
  owner: string;
  /** hex, no 0x */
  identifier: string;
  signature: string;
  span: string;
  payload: Uint8Array;
  /** Which source answered. */
  source: string;
}

export type VerifiedSocRead =
  | { status: "found"; soc: VerifiedSoc }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

const HEX_RE = /^[0-9a-fA-F]+$/;
function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !HEX_RE.test(clean)) throw new Error("invalid hex");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw new Error(`expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  return bytes;
}
function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Is `raw` a well-formed SOC for (owner, identifier)? Pure. The same three
 * checks the write gate runs before stamping, applied to bytes we were handed.
 */
export function verifyStoredSoc(
  raw: Uint8Array,
  ownerHex: string,
  identifierHex: string,
): { ok: true; parts: ReturnType<typeof splitStoredSoc> & object } | { ok: false; reason: string } {
  const parts = splitStoredSoc(raw);
  if (!parts) return { ok: false, reason: "too short to be a SOC" };
  const { identifier, signature, span, payload } = parts;
  if (bytesToHex(identifier) !== identifierHex.toLowerCase()) return { ok: false, reason: "identifier mismatch" };
  if (bytesToHex(span) !== bytesToHex(encodeSpan(payload.length))) return { ok: false, reason: "span does not match payload" };
  let recovered: string;
  try {
    const digest = socSignDigest(identifier, calculateCacAddress(span, payload));
    recovered = new Signature(signature).recoverPublicKey(digest).address().toHex().toLowerCase().replace(/^0x/, "");
  } catch {
    return { ok: false, reason: "signature malformed" };
  }
  if (recovered !== ownerHex.toLowerCase()) return { ok: false, reason: "signature does not recover to owner" };
  return { ok: true, parts };
}

/**
 * The aggregate rule, pure over already-fetched answers. Exported for tests.
 * `verified` must be true only for a `found` whose bytes passed `verifyStoredSoc`;
 * a found that FAILED verification is reported by the caller as that source
 * being `unavailable` (it answered with something that is not this chunk).
 *
 * `ledgerClears` (#912): the relay ledger lists nothing at this address, so a
 * `listedInRelayLedger` source that could not be asked holds nothing the other
 * verdict sources cannot see - their absent stands. Never enough on its own: at
 * least one other verdict source must have searched.
 */
export function aggregateSocReads(
  answers: Array<{ source: SocSource; read: RawSocRead }>,
  opts: { ledgerClears?: boolean } = {},
): { status: "found"; from: string; raw: Uint8Array } | { status: "absent" } | { status: "unavailable"; reason: string } {
  for (const a of answers) if (a.read.status === "found") return { status: "found", from: a.source.name, raw: a.read.raw };
  const unreachable = answers.filter((a) => a.read.status === "unavailable");
  const reasons = () => unreachable.map((a) => `${a.source.name}: ${(a.read as { reason: string }).reason}`).join("; ");
  const excused = opts.ledgerClears === true && unreachable.every((a) => a.source.listedInRelayLedger === true);
  if (unreachable.length > 0 && !excused) return { status: "unavailable", reason: reasons() };
  const verdicts = answers.filter((a) => a.source.negativeAuthority === "verdict" && a.read.status !== "unavailable");
  if (verdicts.length > 0 && verdicts.every((a) => a.read.status === "absent")) return { status: "absent" };
  return { status: "unavailable", reason: unreachable.length > 0 ? reasons() : "no source with negative authority answered" };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchRaw(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: Uint8Array }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  // A found chunk is one chunk at most (Etherna is a third party). Any other
  // status is judged on the status alone: its body (a proxy's HTML 404 page)
  // must not turn an `absent` verdict into a read failure.
  if (r.status !== 200) {
    await r.body?.cancel().catch(() => {});
    return { status: r.status, body: new Uint8Array(0) };
  }
  const body = await readCapped(r, SWARM_CHUNK_MAX_BYTES, "chunk read");
  return { status: r.status, body };
}

const beeHttpReason = (status: number) => `bee HTTP ${status}`;

/** Our bee — a full node; its 404 ends a network search. */
export const wocoBeeSource: SocSource = {
  name: "wocoBee",
  negativeAuthority: "verdict",
  read: async (address) => {
    try {
      const r = await fetchRaw(`${BEE_URL}/chunks/${address}`, {}, BEE_CALL_TIMEOUT_MS);
      if (r.status === 200) return { status: "found", raw: r.body };
      if (r.status === 404) return { status: "absent" };
      // 500 "read chunk failed", 503, 429 — retrieval faults, not answers.
      return { status: "unavailable", reason: beeHttpReason(r.status) };
    } catch (e) {
      return { status: "unavailable", reason: `bee unreachable: ${(e as Error)?.message ?? String(e)}` };
    }
  },
};

/**
 * The read failed ONLY because our bee answered 500 "read chunk failed" - every
 * other source asked said absent, or none was. On bee 2.8 that is what a chunk
 * nobody has written reads as once every peer is on bee's one-minute skip list
 * for it (`storage-busy.ts`, #943); it is also any other retrieval fault. Either
 * way it stays `unavailable`: this only lets a refusal say "try again in a minute".
 */
export function isOnlyBeeChunk500(read: VerifiedSocRead): read is Extract<VerifiedSocRead, { status: "unavailable" }> {
  return read.status === "unavailable" && read.reason === `${wocoBeeSource.name}: ${beeHttpReason(500)}`;
}

// The breaker lives in lib/etherna/breaker.ts (#912), shared with the writes;
// re-exported so its existing importers keep working.
export { ETHERNA_BREAKER_MS, ETHERNA_SLOW_MS, __resetEthernaBreaker } from "../etherna/breaker.js";

/** Can this server ask Etherna at all? Without the flag and a key, no. */
export function ethernaReadConfigured(): boolean {
  return process.env.ETHERNA_ENABLED === "true" && !!process.env.ETHERNA_API_KEY;
}

/**
 * `/api/health` `ethernaReads`. RED when a family is routed to Etherna and this
 * server cannot ask it: every read of those families then ends `unavailable` -
 * owner edits refused, every event read an uncached scan, the indexer all gaps -
 * and nothing else says why. The breaker is reported, not alarmed on: an Etherna
 * outage is Etherna's, and the postage section watches its batch.
 */
export function ethernaReadsHealth(): Record<string, unknown> {
  const families = FEED_FAMILIES.filter((f) => FEED_FAMILY_STORES[f] === "etherna");
  const configured = ethernaReadConfigured();
  return {
    ok: families.length === 0 || configured,
    configured,
    families,
    breaker: ethernaBreakerHealth(),
  };
}

/**
 * Etherna's gateway, bearer-authenticated (bypasses the anonymous offer gate). A
 * full node too, so its 404 is a verdict about the network as it sees it; but it
 * is only ASKED for Etherna-stamped feeds (see `sourcesFor`).
 */
export const ethernaSource: SocSource = {
  name: "etherna",
  negativeAuthority: "verdict",
  listedInRelayLedger: true,
  read: async (address) => {
    const paused = ethernaPaused();
    if (paused !== null) return { status: "unavailable", reason: `etherna paused after: ${paused}` };
    const started = performance.now();
    const failed = (reason: string): RawSocRead => {
      noteEthernaFailure(reason, started);
      return { status: "unavailable", reason };
    };
    try {
      await ensureEthernaToken();
    } catch (e) {
      return failed(`etherna token: ${(e as Error)?.message ?? String(e)}`);
    }
    const token = getCachedEthernaToken();
    if (!token) return { status: "unavailable", reason: "etherna token unavailable" };
    try {
      const r = await fetchRaw(`${ETHERNA_GW}/chunks/${address}`, { headers: { Authorization: `Bearer ${token}` } }, ETHERNA_READ_TIMEOUT_MS);
      if (r.status === 200) return { status: "found", raw: r.body };
      if (r.status === 404) return { status: "absent" };
      return failed(`etherna HTTP ${r.status}`);
    } catch (e) {
      return failed(`etherna unreachable: ${(e as Error)?.message ?? String(e)}`);
    }
  },
};

/**
 * Which sources a read consults. Our bee always. Etherna only when the caller
 * says the feed is Etherna-stamped — the write-path probe forwards the same
 * `gatewayUrl` it routes the stamp with. A gateway we do not recognise adds
 * nothing (no hidden branch for a third host); plugging one in is a new entry
 * here.
 */
export function sourcesFor(gatewayUrl?: string): SocSource[] {
  return sourcesForStore(gatewayUrl && isEthernaGateway(gatewayUrl) ? "etherna" : "woco");
}

/** The sources for a store: our bee always, Etherna too for an Etherna store. */
export function sourcesForStore(store: FeedStore): SocSource[] {
  return store === "etherna" ? [wocoBeeSource, ethernaSource] : [wocoBeeSource];
}

/** The sources for a family, from the shared table - the server's own scans. */
export function sourcesForFamily(family: FeedFamily): SocSource[] {
  return sourcesForStore(FEED_FAMILY_STORES[family]);
}

/**
 * Bookkeeping the old reader did on a hit, kept: a bee-served chunk proves it
 * is publicly readable, so (re-)whitelist it on the proxy; an Etherna-served one
 * gets its anonymous-read offer (re-)registered. Both fire-and-forget.
 */
const healed = new Set<string>();
function healOnFound(source: string, address: string): void {
  if (healed.has(`${source}:${address}`)) return;
  markHealed(source, address);
  if (source === "wocoBee") whitelistHashes([address]).catch(() => undefined);
  if (source === "etherna") registerEthernaOffer(address).catch(() => undefined);
}

/** The upload path whitelisted (or offered) this chunk itself, so a read of it
 *  need not repeat the call. */
export function markHealed(source: string, address: string): void {
  healed.add(`${source}:${address}`);
  if (healed.size > 10_000) healed.clear();
}

/**
 * Read + verify a SOC by owner + identifier across the configured sources.
 * Throws `Error & { status: 400 }` on malformed owner/identifier; never throws
 * for a source fault — that is `unavailable`.
 */
export async function readVerifiedSoc(
  ownerHex: string,
  identifierHex: string,
  /** Which sources to ask: explicit `sources` (tests), else the caller's `family`
   *  (server scans), else the request's `gatewayUrl` (the client fallback).
   *  `heal: false` skips the whitelist/offer bookkeeping on a hit: the feed
   *  layer's own index checks would otherwise add every platform feed update
   *  to the gateway whitelist, one file rewrite each. */
  opts: { gatewayUrl?: string; family?: FeedFamily; sources?: SocSource[]; heal?: boolean } = {},
): Promise<VerifiedSocRead> {
  let owner: string, identifier: string;
  try {
    owner = bytesToHex(hexToBytes(ownerHex, 20));
    identifier = bytesToHex(hexToBytes(identifierHex, SOC_IDENTIFIER_SIZE));
  } catch {
    const err = new Error("Invalid owner or identifier") as Error & { status: number };
    err.status = 400;
    throw err;
  }
  const address = bytesToHex(calculateSocAddress(hexToBytes(identifier), hexToBytes(owner)));
  const sources = opts.sources ?? (opts.family ? sourcesForFamily(opts.family) : sourcesFor(opts.gatewayUrl));

  // Sequential, in order: the first source is the cheap, authoritative one, and
  // a found there spares the others a request.
  const answers: Array<{ source: SocSource; read: RawSocRead }> = [];
  for (const source of sources) {
    let read = await source.read(address);
    if (read.status === "found") {
      const v = verifyStoredSoc(read.raw, owner, identifier);
      if (!v.ok) {
        // Answered with bytes that are not this chunk — a hostile or broken
        // source. It did not say "absent", so it must not count toward one.
        console.warn(`[swarm] ${source.name} served an unverifiable SOC for ${address}: ${v.reason}`);
        read = { status: "unavailable", reason: `${source.name} served bytes that failed verification (${v.reason})` };
      }
    }
    answers.push({ source, read });
    if (read.status === "found") break;
  }

  const ledgerAsked = answers.some((a) => a.read.status === "unavailable" && a.source.listedInRelayLedger);
  const agg = aggregateSocReads(answers, { ledgerClears: ledgerAsked && relayLedgerClearsAbsent(address) });
  if (agg.status !== "found") return agg;
  const parts = splitStoredSoc(agg.raw)!;
  if (opts.heal !== false) healOnFound(agg.from, address);
  return {
    status: "found",
    soc: {
      owner,
      identifier,
      signature: bytesToHex(parts.signature),
      span: bytesToHex(parts.span),
      payload: parts.payload,
      source: agg.from,
    },
  };
}
