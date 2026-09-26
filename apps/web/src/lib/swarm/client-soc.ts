/**
 * Client-owned Single-Owner-Chunk (SOC) write/read (Phase A of
 * CLIENT_FEED_SIGNER_HANDOVER.md).
 *
 * The client OWNS the SOC signing key and builds + signs the chunk locally
 * (`signSoc`, soc-sign.ts); the server holds the postage batch and merely
 * stamps + uploads the pre-signed chunk (`POST /api/swarm/soc`). Writes are
 * authenticated (the server re-verifies the signature recovers to the claimed
 * owner before stamping). Reads go through the unauthenticated server endpoint,
 * which resolves the chunk by its COMPUTED address (Etherna-safe — never /feeds).
 *
 * The payload is carried INLINE in the SOC (never a ref-style SOC), so the
 * envelope resolves on Etherna's Beehive fork too.
 */

import { authPost } from "../api/client.js";
import { signSoc, type SignedSocBody } from "./soc-sign.js";

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
  const { gatewayUrl, ...chunk } = args;
  return postSignedSoc({ ...signSoc(chunk), ...(gatewayUrl ? { gatewayUrl } : {}) });
}

/** Have the server stamp + upload a SOC already signed (`signSoc`, soc-sign.ts). */
export async function postSignedSoc(body: SignedSocBody & { gatewayUrl?: string }): Promise<SocWriteResult> {
  const res = await authPost<SocWriteResult>("/api/swarm/soc", body);
  if (!res.ok || !res.data) throw new Error(res.error || "SOC upload failed");
  return res.data;
}

// Reading lives in probe-soc.ts (#658): it needs no auth, and must load where the
// auth store cannot. Re-exported so existing importers keep working.
export { probeSoc } from "./probe-soc.js";
