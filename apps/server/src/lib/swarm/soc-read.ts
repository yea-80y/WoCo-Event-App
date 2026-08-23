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
 * Adding an operator's gateway, or a user's own bee, is one more entry in
 * `sourcesFor`, not a new branch.
 */

import { Signature } from "@ethersphere/bee-js";
import {
  calculateCacAddress,
  calculateSocAddress,
  encodeSpan,
  socSignDigest,
  splitStoredSoc,
  SOC_IDENTIFIER_SIZE,
} from "@woco/shared";
import { BEE_URL } from "../../config/swarm.js";
import { BEE_CALL_TIMEOUT_MS } from "./upload-queue.js";
import { whitelistHashes } from "./whitelist.js";
import { ensureEthernaToken, getCachedEthernaToken } from "../etherna/auth.js";
import { registerEthernaOffer } from "../etherna/upload.js";
import { isEthernaGateway } from "../etherna/batch-router.js";

const ETHERNA_GW = process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io";
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
 */
export function aggregateSocReads(
  answers: Array<{ source: SocSource; read: RawSocRead }>,
): { status: "found"; from: string; raw: Uint8Array } | { status: "absent" } | { status: "unavailable"; reason: string } {
  for (const a of answers) if (a.read.status === "found") return { status: "found", from: a.source.name, raw: a.read.raw };
  const unreachable = answers.filter((a) => a.read.status === "unavailable");
  if (unreachable.length > 0) {
    return {
      status: "unavailable",
      reason: unreachable.map((a) => `${a.source.name}: ${(a.read as { reason: string }).reason}`).join("; "),
    };
  }
  const verdicts = answers.filter((a) => a.source.negativeAuthority === "verdict");
  if (verdicts.length > 0 && verdicts.every((a) => a.read.status === "absent")) return { status: "absent" };
  return { status: "unavailable", reason: "no source with negative authority answered" };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchRaw(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: Uint8Array }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, body };
}

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
      return { status: "unavailable", reason: `bee HTTP ${r.status}` };
    } catch (e) {
      return { status: "unavailable", reason: `bee unreachable: ${(e as Error)?.message ?? String(e)}` };
    }
  },
};

/**
 * Etherna's gateway, bearer-authenticated (bypasses the anonymous offer gate). A
 * full node too, so its 404 is a verdict about the network as it sees it; but it
 * is only ASKED for Etherna-stamped feeds (see `sourcesFor`).
 */
export const ethernaSource: SocSource = {
  name: "etherna",
  negativeAuthority: "verdict",
  read: async (address) => {
    try {
      await ensureEthernaToken();
    } catch (e) {
      return { status: "unavailable", reason: `etherna token: ${(e as Error)?.message ?? String(e)}` };
    }
    const token = getCachedEthernaToken();
    if (!token) return { status: "unavailable", reason: "etherna token unavailable" };
    try {
      const r = await fetchRaw(`${ETHERNA_GW}/chunks/${address}`, { headers: { Authorization: `Bearer ${token}` } }, ETHERNA_READ_TIMEOUT_MS);
      if (r.status === 200) return { status: "found", raw: r.body };
      if (r.status === 404) return { status: "absent" };
      return { status: "unavailable", reason: `etherna HTTP ${r.status}` };
    } catch (e) {
      return { status: "unavailable", reason: `etherna unreachable: ${(e as Error)?.message ?? String(e)}` };
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
  const sources: SocSource[] = [wocoBeeSource];
  if (gatewayUrl && isEthernaGateway(gatewayUrl)) sources.push(ethernaSource);
  return sources;
}

/**
 * Bookkeeping the old reader did on a hit, kept: a bee-served chunk proves it
 * is publicly readable, so (re-)whitelist it on the proxy; an Etherna-served one
 * gets its anonymous-read offer (re-)registered. Both fire-and-forget.
 */
const healed = new Set<string>();
function healOnFound(source: string, address: string): void {
  if (healed.has(`${source}:${address}`)) return;
  healed.add(`${source}:${address}`);
  if (healed.size > 10_000) healed.clear();
  if (source === "wocoBee") whitelistHashes([address]).catch(() => undefined);
  if (source === "etherna") registerEthernaOffer(address).catch(() => undefined);
}

/**
 * Read + verify a SOC by owner + identifier across the configured sources.
 * Throws `Error & { status: 400 }` on malformed owner/identifier; never throws
 * for a source fault — that is `unavailable`.
 */
export async function readVerifiedSoc(
  ownerHex: string,
  identifierHex: string,
  opts: { gatewayUrl?: string; sources?: SocSource[] } = {},
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
  const sources = opts.sources ?? sourcesFor(opts.gatewayUrl);

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

  const agg = aggregateSocReads(answers);
  if (agg.status !== "found") return agg;
  const parts = splitStoredSoc(agg.raw)!;
  healOnFound(agg.from, address);
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
