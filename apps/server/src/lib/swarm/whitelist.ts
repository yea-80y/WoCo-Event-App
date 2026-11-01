import { PROXY_URL, UPLOAD_SECRET } from "../../config/swarm.js";
import { readCappedJson } from "../http/read-capped.js";

/**
 * Ask the WoCo gateway proxy to allow public reads of these Swarm hashes.
 *
 * The proxy 403s unwhitelisted hashes, so anything rendered through it — event
 * images, object artwork, deployed-site assets, ticket cards — must be whitelisted
 * before it's referenced. Falsy entries are dropped. No-op when the proxy/secret
 * aren't configured (local dev). Throws on a non-OK response so the caller
 * decides fatal vs. fire-and-forget (most callers `.catch` it as non-critical).
 */
export async function whitelistHashes(hashes: string[]): Promise<void> {
  const list = hashes.filter(Boolean);
  if (list.length === 0) return;
  // THROW rather than no-op when the proxy is configured but the secret is not.
  // This used to return silently, which in production means every write is
  // published unwhitelisted — and since a client may now read a whitelist
  // refusal as "this chunk does not exist", one misconfigured deploy would make
  // all new data read as ABSENT platform-wide, silently. A missing PROXY_URL is
  // still a no-op: that is local dev with no proxy at all.
  if (!PROXY_URL) return;
  if (!UPLOAD_SECRET) {
    throw new Error(
      "UPLOAD_SECRET is not set but PROXY_URL is — refusing to skip whitelisting. " +
      "Unwhitelisted chunks read as ABSENT to clients, not as errors.",
    );
  }
  const resp = await fetch(`${PROXY_URL}/admin/whitelist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-upload-secret": UPLOAD_SECRET },
    body: JSON.stringify({ hashes: list }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`whitelist responded ${resp.status}`);
}

/** The proxy's admin calls need the secret whenever a proxy is configured; null = no proxy (local dev). */
function adminSecret(): string | null {
  if (!PROXY_URL) return null;
  if (!UPLOAD_SECRET) throw new Error("UPLOAD_SECRET is not set but PROXY_URL is");
  return UPLOAD_SECRET;
}

/** Stop public reads of one hash through the proxy. Idempotent: an absent hash is a no-op there. */
export async function unwhitelistHash(hash: string): Promise<void> {
  const secret = adminSecret();
  if (secret === null) return;
  const resp = await fetch(`${PROXY_URL}/admin/whitelist/${hash.toLowerCase()}`, {
    method: "DELETE",
    headers: { "x-upload-secret": secret },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`whitelist delete responded ${resp.status}`);
}

/** Every hash the proxy serves. null = no proxy configured. */
export async function listWhitelist(): Promise<Set<string> | null> {
  const secret = adminSecret();
  if (secret === null) return null;
  const resp = await fetch(`${PROXY_URL}/admin/whitelist`, {
    headers: { "x-upload-secret": secret },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`whitelist list responded ${resp.status}`);
  const { hashes } = await readCappedJson<{ hashes?: unknown }>(resp, WHITELIST_LIST_MAX_BYTES, "whitelist list");
  if (!Array.isArray(hashes)) throw new Error("whitelist list: no hashes array");
  return new Set(hashes.filter((h): h is string => typeof h === "string").map((h) => h.toLowerCase()));
}

/** ~67 bytes a hash: room for ~500k entries, against ~18k on 2026-10-31. */
const WHITELIST_LIST_MAX_BYTES = 32 * 1024 * 1024;
