/**
 * A link an organiser typed into their site, made safe to render. Sites are served
 * under `<label>.woco.eth.limo`, and in browsers whose Public Suffix List predates
 * 2026-09-01 any script there can ask for the visitor's woco.eth.limo passkey - so a
 * `javascript:` (or `data:`, `vbscript:`) link would be the organiser's own code on
 * that origin. Only in-site routes and ordinary web, mail and phone links survive;
 * anything else renders as no link at all.
 *
 * Parsed with the URL parser rather than matched as text, so `java\tscript:` and
 * leading spaces read exactly as the browser would read them; the browser then gets
 * the parser's own serialisation, never the raw string.
 */
const ALLOWED_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:"]);

export function safeHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.startsWith("#/")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return ALLOWED_SCHEMES.has(url.protocol) ? url.href : null;
}

/** A Swarm reference (64 hex chars) or null - it is interpolated into a CSS `url()`. */
export function safeSwarmRef(raw: string | null | undefined): string | null {
  return typeof raw === "string" && /^[0-9a-f]{64}$/i.test(raw) ? raw : null;
}
