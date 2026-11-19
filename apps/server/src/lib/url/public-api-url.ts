/**
 * Sanitises a client-supplied API URL before it lands in public Swarm data
 * (directory entries, deployed site SITE_CONFIG, etc.).
 *
 * Any private / loopback / non-https value gets replaced with the server's own
 * PUBLIC_API_BASE — the server is the authority on its own public identity,
 * and a client (especially a dev frontend) can never be trusted to know it.
 *
 * Without this, a developer running `npm run dev` against the production bee
 * (via SSH tunnel) will write `http://localhost:3001` into the public events
 * directory; visitors then hit Chrome's Local Network Access permission gate
 * trying to reach a loopback address from an HTTPS origin.
 */
const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith(".local")) return true;
  return false;
}

/** Whether `url` is this server's own public API (`PUBLIC_API_BASE`), by origin. False when that is not set. */
export function isOwnPublicApiUrl(url: string): boolean {
  const base = (process.env.PUBLIC_API_BASE || "").trim();
  if (!base) return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Returns a public-safe API URL or undefined.
 *
 * - Empty/missing input → server's PUBLIC_API_BASE (or undefined if unset).
 * - Private / loopback / .local hostname → server's PUBLIC_API_BASE.
 * - Non-https scheme → server's PUBLIC_API_BASE.
 * - Otherwise → trimmed, trailing-slash-stripped input.
 */
export function sanitisePublicApiUrl(raw: string | undefined | null): string | undefined {
  const publicBase = (process.env.PUBLIC_API_BASE || "").trim().replace(/\/$/, "") || undefined;

  const trimmed = (raw ?? "").trim().replace(/\/$/, "");
  if (!trimmed) return publicBase;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return publicBase;
  }

  if (parsed.protocol !== "https:") return publicBase;
  if (isPrivateHost(parsed.hostname)) return publicBase;

  return trimmed;
}
