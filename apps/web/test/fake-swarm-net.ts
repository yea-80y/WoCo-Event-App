/**
 * A faked network for running the REAL feed readers (and, through a transport
 * seam, the real signer and writer) under node (#658, #689).
 *
 * Only `fetch` is replaced, answering as our gateway (`GET /chunks/{address}`)
 * and our server (`GET /api/swarm/soc/{owner}/{id}?gatewayUrl=`) would. Chunks
 * are genuine signed SOCs, so the signature check runs on both sources.
 *
 * The server model is `readVerifiedSoc`'s (apps/server/src/lib/swarm/soc-read.ts):
 * our bee always, Etherna only when the request names it; any found wins, then
 * any unanswered, else absent. The transport models `uploadSignedSoc`: an
 * Etherna `gatewayUrl` stamps into Etherna's store, anything else into our bee's. An
 * Etherna-stamped chunk reaches our bee only when a test says so (`propagate`),
 * which measured minutes in production (2026-09-22).
 */

import { Bee, Bytes, Identifier, PrivateKey, Reference, Span } from "@ethersphere/bee-js";
import { calculateCacAddress, calculateSocAddress, encodeSpan } from "@woco/shared";
import { ETHERNA_GATEWAY_URL } from "../src/lib/swarm/gateways.js";
import { verifyServedSoc } from "../src/lib/swarm/soc-verify.js";
import type { SignedSocBody } from "../src/lib/swarm/soc-sign.js";

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const bee = new Bee("http://127.0.0.1:9"); // makeSingleOwnerChunk only - no I/O

export const OWNER_PRIV = `0x${"11".repeat(32)}`;
export const OWNER_KEY = new PrivateKey(OWNER_PRIV);
export const OTHER_KEY = new PrivateKey(`0x${"22".repeat(32)}`);
export const OWNER = OWNER_KEY.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();

export interface StoredSoc { address: string; raw: Uint8Array; identifier: Uint8Array; signature: Uint8Array; span: Uint8Array; payload: Uint8Array }

/** A SOC as a bee stores it: identifier ‖ signature ‖ span ‖ payload, holding
 *  `value` as JSON. `signer` defaults to the owner; another key forges a chunk
 *  at the owner's address. */
export function soc(identifier: Uint8Array, value: unknown, signer = OWNER_KEY): StoredSoc {
  return socBytes(identifier, new TextEncoder().encode(JSON.stringify(value)), signer);
}

/** The same, holding raw bytes. */
export function socBytes(identifier: Uint8Array, payload: Uint8Array, signer = OWNER_KEY): StoredSoc {
  const span = encodeSpan(payload.length);
  const chunk = bee.makeSingleOwnerChunk(
    new Reference(calculateCacAddress(span, payload)),
    Span.fromBigInt(BigInt(payload.length)),
    new Bytes(payload),
    new Identifier(identifier),
    signer,
  );
  const signature = chunk.signature.toUint8Array();
  const raw = new Uint8Array([...identifier, ...signature, ...span, ...payload]);
  return { address: hex(calculateSocAddress(identifier, unhex(OWNER))), raw, identifier, signature, span, payload };
}

export interface Net {
  ourBee: Map<string, StoredSoc>;
  etherna: Map<string, StoredSoc>;
  /** Etherna unreachable; a function is asked once per server request that
   *  consults Etherna, with that request's 0-based index among them. */
  ethernaDown?: boolean | ((nth: number) => boolean);
  /** Override what our gateway answers for an address. */
  gateway?: (address: string) => Response | "throw" | undefined;
}

const isEtherna = (gatewayUrl: string | undefined) =>
  !!gatewayUrl && new URL(gatewayUrl).host.endsWith(new URL(ETHERNA_GATEWAY_URL).host);

export let requests: string[] = [];
const realFetch = globalThis.fetch;
const realStorage = (globalThis as { localStorage?: unknown }).localStorage;

export function install(net: Net) {
  let ethernaAsks = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);

    const g = url.match(/^https:\/\/gateway\.woco-net\.com\/chunks\/([0-9a-f]{64})$/);
    if (g) {
      const override = net.gateway?.(g[1]);
      if (override === "throw") throw new TypeError("network error");
      if (override) return override;
      const hit = net.ourBee.get(g[1]);
      return hit ? new Response(hit.raw) : new Response("Not Found", { status: 404 });
    }

    const any = url.match(/^\/api\/swarm\/soc\/([^/?]+)\/([^/?]+)/);
    if (any && !/^[0-9a-f]{40}$/.test(any[1])) return Response.json({ ok: false, error: "Invalid owner" }, { status: 400 });
    const s = url.match(/^\/api\/swarm\/soc\/([0-9a-f]{40})\/([0-9a-f]{64})(?:\?gatewayUrl=([^&]+))?$/);
    if (s) {
      const address = hex(calculateSocAddress(unhex(s[2]), unhex(s[1])));
      const askEtherna = isEtherna(s[3] ? decodeURIComponent(s[3]) : undefined);
      const bee = net.ourBee.get(address);
      // The server asks our bee first and Etherna only on a miss (soc-read.ts).
      const down = !bee && askEtherna
        && (typeof net.ethernaDown === "function" ? net.ethernaDown(ethernaAsks++) : !!net.ethernaDown);
      const found = bee ?? (askEtherna && !down ? net.etherna.get(address) : undefined);
      if (found) {
        return Response.json({
          ok: true,
          data: {
            owner: s[1],
            identifier: hex(found.identifier),
            signature: hex(found.signature),
            span: hex(found.span),
            payloadB64: Buffer.from(found.payload).toString("base64"),
          },
        });
      }
      if (down) return Response.json({ ok: false, code: "unavailable" }, { status: 503 });
      return Response.json({ ok: false, code: "absent" }, { status: 404 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

/** Etherna's pushes have reached our bee. */
export function propagate(net: Net) {
  for (const [address, chunk] of net.etherna) net.ourBee.set(address, chunk);
}

export interface Sent { gatewayUrl: string; address: string }

/**
 * A transport with `postSignedSoc`'s shape: takes the chunk the REAL signer
 * produced, refuses it unless it verifies (as the server does before stamping),
 * and stamps it where the server would - Etherna's store for an Etherna
 * gateway, our bee's otherwise. A write at an address already stored keeps the
 * old chunk, as Bee does. Records every send.
 */
export function transport(net: Net, log: Sent[] = []) {
  const send = async (body: SignedSocBody & { gatewayUrl: string }) => {
    const owner = body.owner.replace(/^0x/, "").toLowerCase();
    const identifier = unhex(body.identifier.replace(/^0x/, ""));
    const signature = unhex(body.signature.replace(/^0x/, ""));
    const span = unhex(body.span);
    const payload = unhex(body.payload);
    const v = verifyServedSoc({ owner, identifier: body.identifier, signature: body.signature, span: body.span, payload }, { owner, identifier });
    if (!v.ok) throw new Error(`the server would refuse this chunk: ${v.reason}`);
    const chunk: StoredSoc = {
      address: hex(calculateSocAddress(identifier, unhex(owner))),
      raw: new Uint8Array([...identifier, ...signature, ...span, ...payload]),
      identifier, signature, span, payload,
    };
    const store = isEtherna(body.gatewayUrl) ? net.etherna : net.ourBee;
    if (!store.has(chunk.address)) store.set(chunk.address, chunk);
    log.push({ gatewayUrl: body.gatewayUrl, address: chunk.address });
    return { owner, identifier: hex(identifier), address: chunk.address };
  };
  return { transport: send, log };
}

export const serverRequests = () => requests.filter((u) => u.startsWith("/api/swarm/soc/"));
export const gatewayParam = (u: string) => new URL(u, "http://x").searchParams.get("gatewayUrl");

/** For `beforeEach`: a clean request log and an empty localStorage. */
export function resetNet() {
  requests = [];
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/** For `afterEach`. */
export function restoreNet() {
  globalThis.fetch = realFetch;
  (globalThis as { localStorage?: unknown }).localStorage = realStorage;
}

/** Clear the request log mid-test. */
export function clearRequests() {
  requests = [];
}
