/**
 * Reading a single-owner chunk (SOC): our gateway first, then our server, and
 * the same signature check on whatever either returns.
 *
 * Split from `client-soc.ts` (#658). That module signs and uploads, which needs
 * the authenticated API client and through it the Svelte auth store - a runes
 * module the node test runner cannot load. Reading needs neither, so it lives
 * here, where the feed readers and their tests can reach it. `client-soc.ts`
 * re-exports `probeSoc`.
 *
 * Both reads go over plain `fetch` (not bee-js, whose axios client a node test
 * cannot fake), so the whole read path is one interface and one trust check.
 */

import { countProbe, countGatewayMissStatus } from "./probe-stats.js";
import { isOurGateDenial } from "./gate-denial.js";
import { verifyServedSoc } from "./soc-verify.js";
import { WOCO_GATEWAY_URL } from "./gateways.js";
import { calculateSocAddress, splitStoredSoc, type SocReadOutcome } from "@woco/shared";
import { get } from "../api/http.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

type GatewayRead =
  | { kind: "found"; payload: Uint8Array }
  | { kind: "miss"; status?: number; ourGateDenied: boolean; reason: string };

/**
 * Our gateway's copy of the SOC at `keccak(identifier‖owner)`, verified here.
 *
 * A chunk that fails verification is a MISS with no status, never a verdict:
 * it proves only that this source served something else, so the probe asks the
 * server. That is what the bee-js reader did too - it threw, without a status.
 *
 * `verifyServedSoc` also requires span = payload length, which bee-js never
 * checked on this path. The set that rule rejects is empty for real data: every
 * writer puts the payload inline in a single SOC (`signAndUploadSoc` in
 * client-soc.ts; the server relay's `uploadSignedSoc`, soc-upload.ts), a feed too
 * big for one chunk writes each page as its own SOC (`writeContentFeed`), and the
 * server read path already required it (soc-read.ts).
 */
async function readFromGateway(owner: string, identifier: Uint8Array): Promise<GatewayRead> {
  // The bee-js reader threw on a malformed owner, so the probe asked the server,
  // which refuses it (400) and the probe answered `unavailable`. Same here: never
  // throw out of the probe, and never probe an address built from bad hex.
  if (!/^[0-9a-f]{40}$/.test(owner)) {
    return { kind: "miss", ourGateDenied: false, reason: "owner is not a 20-byte address" };
  }
  try {
    const address = bytesToHex(calculateSocAddress(identifier, hexToBytes(owner)));
    // The Accept bee-js sent, so the gateway sees the same request it always has.
    const res = await fetch(`${WOCO_GATEWAY_URL}/chunks/${address}`, {
      headers: { accept: "application/json, text/plain, */*" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        kind: "miss",
        status: res.status,
        // The gate's header is readable over fetch; bee-js surfaced only the body.
        ourGateDenied: res.status === 403 && isOurGateDenial({ response: { headers: res.headers, data: body } }),
        reason: `gateway HTTP ${res.status}`,
      };
    }
    const parts = splitStoredSoc(new Uint8Array(await res.arrayBuffer()));
    if (!parts) return { kind: "miss", ourGateDenied: false, reason: "gateway chunk is not a SOC" };
    const v = verifyServedSoc(
      {
        owner,
        identifier: bytesToHex(parts.identifier),
        signature: bytesToHex(parts.signature),
        span: bytesToHex(parts.span),
        payload: parts.payload,
      },
      { owner, identifier },
    );
    if (!v.ok) return { kind: "miss", ourGateDenied: false, reason: `gateway chunk failed verification: ${v.reason}` };
    return { kind: "found", payload: parts.payload };
  } catch (e) {
    return { kind: "miss", ourGateDenied: false, reason: `gateway unreachable: ${(e as Error)?.message ?? String(e)}` };
  }
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
 * is self-authenticating, and BOTH sources are held to one check here,
 * `verifyServedSoc` - the chunk at `keccak(identifier‖owner)` counts only if it
 * carries this identifier, its span matches its payload, and its signature
 * recovers to `owner` - so no gateway or server (hostile or not) can serve a
 * chunk that verifies for this (owner, identifier) unless the real owner signed
 * it. A response that is not this owner's chunk for this identifier is never
 * `found`. Multiple read sources therefore add availability/censorship-
 * resistance with zero added trust. The gateway path needs the SOC address
 * whitelisted (done server-side at write time); the server fallback covers a
 * whitelist lag and a just-written Etherna-stamped chunk. No auth on either path.
 *
 * `gatewayUrl` names where the feed is stamped. It is forwarded to the server so an
 * Etherna-stamped feed's read asks Etherna too (and answers `unavailable`, not
 * absent, when Etherna cannot be asked). Every content-feed read passes its
 * family's route (`FeedRoute`, lib/swarm/gateways.ts), display reads included;
 * it matters only when this probe falls through to the server.
 */
export async function probeSoc(
  ownerAddress: string,
  identifier: Uint8Array,
  opts: { thorough?: boolean; gatewayUrl?: string } = {},
): Promise<SocReadOutcome> {
  if (identifier.length !== 32) throw new Error("SOC identifier must be 32 bytes");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();

  // 1. Gateway-first: self-verifying SOC read straight from our Bee gateway.
  const gateway = await readFromGateway(owner, identifier);
  if (gateway.kind === "found") {
    countProbe("gatewayHit");
    return { status: "found", bytes: gateway.payload };
  }
  // Status FIRST, so the miss can be bucketed by cause. `gatewayMiss` alone
  // bundles a whitelist 403, a genuine 404 and a bee 5xx into one number, and
  // those three call for opposite fixes — see `GatewayMissStatuses`.
  const status = gateway.status;
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
  // A TAGGED 403 is our own gate saying it has never been told about this
  // address — and since every write whitelists before uploading, that is a
  // verdict, not a failure to ask. Trusting it removes a ~2-3s server round
  // trip from every absent probe, which on the version-scan hot path was the
  // single largest cost in a cold read (measured 2026-08-20).
  //
  // NOT on `thorough` reads. Those resolve the address a WRITE will target,
  // where a false absent re-writes an existing immutable SOC and the edit is
  // silently lost — so they keep asking the server no matter who refused.
  // Callers whose result feeds a read-modify-write pass `thorough` for the
  // same reason (see `readBandedContentFeed`).
  if (status === 403 && !opts.thorough && gateway.ourGateDenied) return { status: "absent" };
  const gatewayReason = gateway.reason;

  // 2. Server fallback — availability only, and VERIFIED (#156).
  const idHex = bytesToHex(identifier);
  const qs = opts.gatewayUrl ? `?gatewayUrl=${encodeURIComponent(opts.gatewayUrl)}` : "";
  const res = await get<{ owner: string; identifier: string; signature: string; span: string; payloadB64: string }>(
    `/api/swarm/soc/${owner}/${idHex}${qs}`,
  );
  if (res.ok && res.data) {
    const d = res.data;
    if (typeof d.signature !== "string" || typeof d.span !== "string" || typeof d.payloadB64 !== "string") {
      // An origin that will not show its work is not a source.
      countProbe("serverMiss");
      return { status: "unavailable", reason: "server returned a SOC without signature/span (cannot verify)" };
    }
    const bin = atob(d.payloadB64);
    const payload = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) payload[i] = bin.charCodeAt(i);
    const v = verifyServedSoc(
      { owner: d.owner ?? owner, identifier: d.identifier ?? idHex, signature: d.signature, span: d.span, payload },
      { owner, identifier },
    );
    if (!v.ok) {
      console.warn(`[swarm] server-served SOC failed verification (${v.reason}) — treating as unavailable`);
      countProbe("serverMiss");
      return { status: "unavailable", reason: `server SOC failed verification: ${v.reason}` };
    }
    countProbe("serverHit");
    return { status: "found", bytes: payload };
  }
  countProbe("serverMiss");
  // A server 404 is now a real verdict: the server answers 404 ONLY when every
  // source with negative authority ran its search and found nothing, and 503
  // (`code: "unavailable"`) whenever anybody could not be asked — including the
  // bee 500 / Etherna-unreachable cases that used to be dressed as not-found.
  // A caller that caches off `absent` still inherits the remaining trust in the
  // bee's own search (#138); nothing here changes that.
  if (res.status === 404) return { status: "absent" };
  return {
    status: "unavailable",
    reason: `${gatewayReason}; server HTTP ${res.status ?? "?"}${res.error ? `: ${res.error}` : ""}`,
  };
}
