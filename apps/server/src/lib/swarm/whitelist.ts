import { PROXY_URL, UPLOAD_SECRET } from "../../config/swarm.js";

/**
 * Ask the WoCo gateway proxy to allow public reads of these Swarm hashes.
 *
 * The proxy 403s unwhitelisted hashes, so anything rendered through it — event
 * images, POD artwork, deployed-site assets, ticket cards — must be whitelisted
 * before it's referenced. Falsy entries are dropped. No-op when the proxy/secret
 * aren't configured (local dev). Throws on a non-OK response so the caller
 * decides fatal vs. fire-and-forget (most callers `.catch` it as non-critical).
 */
export async function whitelistHashes(hashes: string[]): Promise<void> {
  const list = hashes.filter(Boolean);
  if (list.length === 0 || !PROXY_URL || !UPLOAD_SECRET) return;
  const resp = await fetch(`${PROXY_URL}/admin/whitelist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-upload-secret": UPLOAD_SECRET },
    body: JSON.stringify({ hashes: list }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`whitelist responded ${resp.status}`);
}
