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

import { Bee, PrivateKey, Bytes, Span, Identifier, Reference } from "@ethersphere/bee-js";
import { calculateCacAddress, encodeSpan, SOC_MAX_PAYLOAD_SIZE } from "@woco/shared";
import { authPost, get } from "../api/client.js";

// makeSingleOwnerChunk does no I/O; the URL is only used if a Bee method ever
// hits the network (it doesn't here). Reads/writes go through our API.
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
 * Read a SOC's inline payload by owner + identifier. Returns the raw payload
 * bytes, or null if the chunk doesn't exist.
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
export async function readSoc(ownerAddress: string, identifier: Uint8Array): Promise<Uint8Array | null> {
  if (identifier.length !== 32) throw new Error("SOC identifier must be 32 bytes");
  const owner = (ownerAddress.startsWith("0x") ? ownerAddress.slice(2) : ownerAddress).toLowerCase();

  // 1. Gateway-first: self-verifying SOC read straight from our Bee gateway
  //    (same instance used for signing; makeSOCReader.download does GET /chunks).
  try {
    const soc = await bee().makeSOCReader(`0x${owner}`).download(identifier);
    return soc.payload.toUint8Array();
  } catch {
    // 403 (not yet whitelisted), 404, or transient — fall through to the server.
  }

  // 2. Server fallback (availability only).
  const res = await get<{ payloadB64: string }>(`/api/swarm/soc/${owner}/${bytesToHex(identifier)}`);
  if (!res.ok || !res.data) return null;
  const bin = atob(res.data.payloadB64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
