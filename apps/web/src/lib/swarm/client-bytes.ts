/**
 * Client → server bytes-stamp rail. The client builds content (woco.ticket.v1
 * editions bodies + the page-0 meta blob) and the server lends postage to upload
 * it to Swarm /bytes (`POST /api/swarm/bytes`). Trust-minimised: the content is
 * CONTENT-ADDRESSED — the returned ref IS the hash of the bytes, and the organiser
 * commits that ref inside a carrier-signed editions SOC, so the server can't
 * substitute different content without breaking the ref. The server routes the
 * upload to the SAME batch the event content used (Etherna when the builder picked
 * the Etherna gateway — the builder IS the event creator), so editions bodies land
 * beside the event's pods/image.
 */

import { authPost } from "../api/client.js";

function bytesToB64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

/**
 * Stamp + upload content-addressed bytes via the server. Returns the Swarm ref
 * (hex, no 0x). `gatewayUrl` routes the batch (Etherna vs WoCo); omit to use WoCo.
 */
export async function stampBytes(
  data: Uint8Array,
  opts: { gatewayUrl?: string } = {},
): Promise<string> {
  const res = await authPost<{ ref: string }>("/api/swarm/bytes", {
    dataB64: bytesToB64(data),
    ...(opts.gatewayUrl ? { gatewayUrl: opts.gatewayUrl } : {}),
  });
  if (!res.ok || !res.data?.ref) throw new Error(res.error || "bytes stamp failed");
  return res.data.ref;
}
