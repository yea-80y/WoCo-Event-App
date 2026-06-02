/**
 * Stripe redirect-URL resolution — shared by the events checkout and the shop
 * checkout. Both need to send the buyer back to the page they came from after
 * Stripe, without opening an open-redirect hole.
 *
 * Validation: localhost is always trusted (any port). Other hosts must appear
 * in ALLOWED_HOSTS exactly. Paths are preserved because Swarm-served frontends
 * live at /bzz/{hash}/ where the origin alone 404s.
 */

/**
 * Validate a client-supplied return URL and return it (minus query/hash/trailing
 * slash) if its host is in ALLOWED_HOSTS. Preserves the path.
 */
export function validateReturnUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const allowed = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  try {
    const u = new URL(raw);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (!isLocal && !allowed.some((h) => u.host === h)) return null;
    const path = u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the frontend base URL for redirects, preferring Referer (path-keeping,
 * for Swarm /bzz/ sites) then Origin then FRONTEND_URL then ALLOWED_HOSTS[0].
 */
export function getFrontendUrl(c?: { req: { header: (name: string) => string | undefined } }): string {
  const allowed = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  const trust = (raw: string | undefined, keepPath: boolean): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const host = u.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1";
      if (!isLocal && !allowed.some((h) => u.host === h)) return null;
      if (!keepPath) return `${u.protocol}//${u.host}`;
      const path = u.pathname.replace(/\/$/, "");
      return `${u.protocol}//${u.host}${path}`;
    } catch {
      return null;
    }
  };

  const referer = c?.req.header("referer");
  const fromReferer = trust(referer, true);
  if (fromReferer) return fromReferer;

  const origin = c?.req.header("origin");
  const fromOrigin = trust(origin, false);
  if (fromOrigin) return fromOrigin;

  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;

  if (allowed[0]) {
    const host = allowed[0];
    const proto = host.startsWith("localhost") ? "http" : "https";
    console.warn(
      `[stripe] No trusted Origin/Referer header — falling back to ALLOWED_HOSTS[0]=${host}. ` +
      `referer=${referer ?? "<none>"} origin=${origin ?? "<none>"}`,
    );
    return `${proto}://${host}`;
  }
  return "http://localhost:5173";
}

/**
 * If the resolved base is a gateway /bzz/{hash} collection URL (an older
 * deployed frontend), redirect success to the canonical app instead.
 */
export function canonicalSuccessUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.hostname === "gateway.woco-net.com" && u.pathname.startsWith("/bzz/")) {
      return (process.env.FRONTEND_URL || "https://woco.eth.limo").replace(/\/$/, "");
    }
  } catch {
    return baseUrl;
  }
  return baseUrl;
}
