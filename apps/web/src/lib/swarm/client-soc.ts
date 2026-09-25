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
import { authPost } from "../api/client.js";

// Only `makeSingleOwnerChunk` uses this instance, and it does no I/O: uploads go
// through our API, and reads live in probe-soc.ts over plain fetch.
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
 * it names Etherna) — same signal as the /bytes rail. Content-feed callers always
 * pass their family's route (`FeedRoute`, lib/swarm/gateways.ts); left out, the
 * server stamps on the WoCo platform batch. Throws if not authenticated or the
 * upload fails.
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

// Reading lives in probe-soc.ts (#658): it needs no auth, and must load where the
// auth store cannot. Re-exported so existing importers keep working.
export { probeSoc } from "./probe-soc.js";
