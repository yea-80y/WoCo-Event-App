/**
 * Client-owned Single-Owner-Chunk (SOC) write/read (Phase A of
 * CLIENT_FEED_SIGNER_HANDOVER.md).
 *
 * The client OWNS the SOC signing key and builds + signs the chunk locally with
 * bee-js `makeSingleOwnerChunk`; the server holds the postage batch and merely
 * stamps + uploads the pre-signed chunk (`POST /api/swarm/soc`). Writes are
 * authenticated (the server re-verifies the signature recovers to the claimed
 * owner before stamping). Reads go through the unauthenticated server endpoint,
 * which resolves the chunk by its COMPUTED address (Etherna-safe — never /feeds).
 *
 * The payload is carried INLINE in the SOC (never a ref-style SOC), so the
 * envelope resolves on Etherna's Beehive fork too.
 */

import { countProbe, countGatewayMissStatus } from "./probe-stats.js";
import { Bee, PrivateKey, Bytes, Span, Identifier, Reference } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan, SOC_MAX_PAYLOAD_SIZE, type SocReadOutcome } from "@woco/shared";
import { authPost, get } from "../api/client.js";

// `makeSingleOwnerChunk` does no I/O — but this URL is NOT inert. `probeSoc`'s
// gateway-first step calls `makeSOCReader(owner).download(identifier)`, which is
// `downloadSingleOwnerChunk` → `chunkAPI.download` → a network GET /chunks against
// THIS host (verified against the installed bee-js@11). Writes go through our API;
// reads do not.
//
// This host is hard-coded, which is the client-side half of #156: a read source
// should be pluggable, so a browser bee node or a light client can be tried FIRST
// and any operator's gateway can slot in without a code change.
let _bee: Bee | null = null;
function bee(): Bee {
  if (!_bee) _bee = new Bee("https://gateway.woco-net.com");
  return _bee;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export interface SocWriteResult {
  /** Lowercased owner address (no 0x). */
  owner: string;
  /** SOC identifier (hex, no 0x). */
  identifier: string;
  /** The SOC's own Swarm address keccak256(identifier||owner) (hex, no 0x). */
  address: string;
}

/**
 * Sign a SOC with `signerPrivKey` over `{ identifier, payload }` and have the
 * server stamp + upload it. `identifier` must be 32 bytes; `payload` ≤ 4096 bytes.
 * `gatewayUrl` routes the stamp to the matching batch (Etherna user batch when
 * the Etherna gateway was picked) — same signal as the /bytes rail; omitted →
 * WoCo platform batch. Throws if not authenticated or the upload fails.
 */
export async function signAndUploadSoc(args: {
  signerPrivKey: string;
  identifier: Uint8Array;
  payload: Uint8Array;
  gatewayUrl?: string;
}): Promise<SocWriteResult> {
  const { signerPrivKey, identifier, payload, gatewayUrl } = args;
  if (identifier.length !== 32) throw new Error("SOC identifier must be 32 bytes");
  if (payload.length < 1 || payload.length > SOC_MAX_PAYLOAD_SIZE) {
    throw new Error(`SOC payload must be 1..${SOC_MAX_PAYLOAD_SIZE} bytes`);
  }

  const signer = new PrivateKey(signerPrivKey.startsWith("0x") ? signerPrivKey : `0x${signerPrivKey}`);
  const span = encodeSpan(payload.length);
  const cacAddress = calculateCacAddress(span, payload);
  const soc = bee().makeSingleOwnerChunk(
    new Reference(cacAddress),
    Span.fromBigInt(BigInt(payload.length)),
    new Bytes(payload),
    new Identifier(identifier),
    signer,
  );

  const res = await authPost<SocWriteResult>("/api/swarm/soc", {
    owner: soc.owner.toHex(),
    identifier: soc.identifier.toHex(),
    signature: soc.signature.toHex(),
    span: bytesToHex(span),
    payload: bytesToHex(payload),
    ...(gatewayUrl ? { gatewayUrl } : {}),
  });
  if (!res.ok || !res.data) throw new Error(res.error || "SOC upload failed");
  return res.data;
}

/**
 * Probe a SOC by owner + identifier. Returns `found` with the raw payload bytes,
 * `absent` when a source DEFINITIVELY answered "no such chunk", or `unavailable`
 * when no source could answer.
 *
 * Keeping `absent` and `unavailable` apart is the whole point of this function.
 * `safeJson` converts a 403 / 5xx / Cloudflare error page into a resolved
 * `{ ok: false }` rather than a throw, so a failed-but-completed response used to
 * be indistinguishable from an empty one — and a caller then wrote that
 * indistinguishable answer somewhere durable (#138: a wrong Kernel address cached
 * for the life of the device; #154: a content-feed write deduped against a version
 * the probe merely failed to see). A client-side network EXCEPTION still throws
 * out of here, which is loud and safe.
 *
 * GATEWAY-FIRST, server fallback. The read source is UNTRUSTED by design: a SOC
 * is self-authenticating — `makeSOCReader(owner).download(identifier)` resolves
 * the chunk at `keccak(identifier‖owner)` and rejects unless the recovered signer
 * equals `owner`, so no gateway (hostile or not) can serve a chunk that verifies
 * for this (owner, identifier) unless the real owner signed it. The payload is
 * additionally HPKE-sealed, and the ultimate authority is the on-chain owner
 * check. So multiple read sources add availability/censorship-resistance with
 * ZERO added trust. The gateway path needs the SOC address whitelisted (done
 * server-side at write time); the server fallback covers a whitelist lag and is
 * availability-only. No auth required on either path.
 */
export async function probeSoc(
  ownerAddress: string,
  identifier: Uint8Array,
  opts: { thorough?: boolean } = {},
): Promise<SocReadOutcome> {
  if (identifier.length !== 32) throw new Error("SOC identifier must be 32 bytes");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();

  // 1. Gateway-first: self-verifying SOC read straight from our Bee gateway
  //    (same instance used for signing; makeSOCReader.download does GET /chunks).
  let gatewayReason = "gateway read failed";
  try {
    const soc = await bee().makeSOCReader(`0x${owner}`).download(identifier);
    countProbe("gatewayHit");
    return { status: "found", bytes: soc.payload.toUint8Array() };
  } catch (err) {
    // Status FIRST, so the miss can be bucketed by cause. `gatewayMiss` alone
    // bundles a whitelist 403, a genuine 404 and a bee 5xx into one number, and
    // those three call for opposite fixes — see `GatewayMissStatuses`.
    const status = (err as { status?: number; response?: { status?: number } })?.status
      ?? (err as { response?: { status?: number } })?.response?.status;
    countProbe("gatewayMiss");
    countGatewayMissStatus(status);
    // A gateway 404 means the bee node already ran a full network search and
    // found nothing — asking the server would repeat that exact search against
    // the SAME node (version probes make this the hot path). Only fall through
    // on 403 (whitelist lag), transient errors, or anything non-definitive.
    //
    // EXCEPT `thorough` reads (the WRITE-path version probe): an Etherna-stamped
    // chunk written seconds ago can 404 here while its push is still settling,
    // yet the server fallback reads it from Etherna's own store. Trusting the
    // 404 would make the version resolver stop one short and re-write an
    // EXISTING immutable SOC — Bee dedupes silently and the edit is LOST
    // (landmine 2, ETHERNA_USER_CONTENT_HANDOVER.md). Writes are rare, so the
    // extra server round-trip is confined to where it is correctness-critical.
    if (status === 404 && !opts.thorough) return { status: "absent" };
    gatewayReason = `gateway HTTP ${status ?? "?"}`;
  }

  // 2. Server fallback (availability only).
  const res = await get<{ payloadB64: string }>(`/api/swarm/soc/${owner}/${bytesToHex(identifier)}`);
  countProbe(res.ok && res.data ? "serverHit" : "serverMiss");
  if (res.ok && res.data) {
    const bin = atob(res.data.payloadB64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { status: "found", bytes: out };
  }
  // A server 404 is the closest thing to a verdict this stack has — the server's
  // bee reported not-found — so we treat it as one. Know what it rests on, though:
  // `readSocPayload` ALSO maps bee's 500 "read chunk failed" to not-found, and its
  // Etherna backstop returns null when Etherna is merely unreachable (bad token,
  // timeout, 5xx). Either can dress a "couldn't ask" as a verdict (#156).
  //
  // So this is a NARROWER channel than the one it replaced — any completed-but-
  // failed HTTP response — not a closed one. A caller that caches off `absent`
  // inherits the remainder (#138). Do not restate this as "absent means absent".
  if (res.status === 404) return { status: "absent" };
  return {
    status: "unavailable",
    reason: `${gatewayReason}; server HTTP ${res.status ?? "?"}${res.error ? `: ${res.error}` : ""}`,
  };
}
