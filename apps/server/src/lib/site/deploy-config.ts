/**
 * The `window.SITE_CONFIG` payload a deploy bakes into a site's HTML, and the
 * guards that stand between the deployer's request body and every visitor's
 * browser.
 *
 * Shared by BOTH deploy routes — `routes/sites.ts` (multi-page builder sites) and
 * `routes/site.ts` (single-event standalone sites) — because they had the same
 * defect and must not drift apart while fixing it (#180, #193).
 *
 * All of it exists for one reason: the deploy body is authored by the ORGANISER,
 * and the output is an immutable, publicly-addressed Swarm collection. Whatever
 * lands in that HTML is what every visitor executes, permanently — there is no
 * patching a published site, only deploying a new one.
 */

/** Canonical WoCo gateway — mirrors apps/web/src/lib/swarm/gateways.ts. */
const WOCO_GATEWAY_URL = "https://gateway.woco-net.com";
/** Where the WoCo app lives when the operator has not said otherwise. */
const DEFAULT_APP_URL = "https://woco.eth.limo";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Line and paragraph separator, built from their code points rather than written
 * as literals.
 *
 * As literals they are invisible in an editor, and an earlier draft of this file
 * had both silently replaced with ordinary SPACES in transit. That turned the
 * table below into "rewrite every space as U+2028", which would have corrupted
 * the text of every deployed site — immutably, since a published site cannot be
 * patched. Nothing about it was visible on the page; the test suite is what
 * caught it, which is why `site-deploy-config.test.ts` builds these characters
 * the same way.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const INLINE_SCRIPT_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  [LINE_SEPARATOR]: "\\u2028",
  [PARAGRAPH_SEPARATOR]: "\\u2029",
};

/**
 * Derived from the table's own keys so the two can never drift apart. Safe as a
 * character class because every key is a single character and none of them is
 * `]`, `^` or `-`.
 */
const INLINE_SCRIPT_UNSAFE = new RegExp(`[${Object.keys(INLINE_SCRIPT_ESCAPES).join("")}]`, "g");

/**
 * Serialise a value for interpolation into an inline `<script>` body.
 *
 * `JSON.stringify` escapes for JSON, not for HTML: it leaves `<` and `>` intact,
 * so a string containing `</script>` closes the tag early and everything after it
 * is parsed as HTML. The config carries organiser-authored free text (page titles,
 * nav labels, section copy, the event id), so bare stringify let any organiser
 * bake arbitrary JS into a deployed site.
 *
 * `<` is a valid escape inside a JSON string literal and parses back to the
 * original character, so no consumer sees a different value. U+2028/U+2029 are
 * legal in JSON strings but terminate a line in JS source; they break the
 * statement rather than smuggle into it, and are escaped for the same reason.
 *
 * A `<script type="application/json">` block would remove the executable context
 * altogether, but its reader lives in the deployed bundle, so it could not take
 * effect until every organiser re-published. Escaping is correct on its own and
 * needs no runtime change.
 */
export function jsonForInlineScript(value: unknown): string {
  const json = JSON.stringify(value);
  // stringify returns undefined for undefined / function / symbol input.
  return (json ?? "null").replace(INLINE_SCRIPT_UNSAFE, (ch) => INLINE_SCRIPT_ESCAPES[ch]);
}

/**
 * Bounded format guard for an id that reaches a deployed page or a feed topic.
 *
 * The charset is what makes injection impossible — no `<`, `>`, quote or slash
 * can survive it — so this holds even if the escaping above is ever bypassed.
 * Deliberately wider than any id we mint (`crypto.randomUUID()` for events,
 * ULID-ish for sites) so legacy and on-chain `0x…` ids still pass.
 */
export function isSafeIdParam(raw: string): boolean {
  return /^[0-9a-zA-Z_-]{8,100}$/.test(raw);
}

function stripTrailingSlash(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** `scheme://host[:port]` of a URL, or null if it will not parse. */
function originOf(raw: string): string | null {
  try {
    return new URL(stripTrailingSlash(raw)).origin;
  } catch {
    return null;
  }
}

/**
 * A loopback URL, and only outside production. It is unreachable to anyone but
 * the developer running it, so it cannot be aimed at a victim — but production
 * has no dev flow to serve, so it fails closed there rather than resting on that
 * reasoning holding.
 */
function devLoopbackAllowed(raw: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(raw.trim()).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/**
 * True when `raw`'s origin EXACTLY equals one of `allowed`.
 *
 * Exact, never suffix matching: `new URL(x).host.endsWith("gateway.woco-net.com")`
 * — the shape used for batch routing — also accepts `evilgateway.woco-net.com`,
 * which is a host anyone can register.
 */
function originAllowed(raw: string, allowed: string[]): boolean {
  const origin = originOf(raw);
  if (!origin) return false;
  return allowed.some((a) => originOf(a) === origin);
}

/** Gateways a site may be deployed to and read its content back through. */
export function allowedGatewayUrls(): string[] {
  const etherna = stripTrailingSlash(process.env.ETHERNA_GATEWAY_URL || "https://gateway.etherna.io");
  return [WOCO_GATEWAY_URL, etherna];
}

/**
 * The gateway is where the deployed page fetches feeds and images from, and it is
 * the routing signal for which postage batch pays for the deploy.
 */
export function isAllowedGatewayUrl(raw: string): boolean {
  return originAllowed(raw, allowedGatewayUrls()) || devLoopbackAllowed(raw);
}

/** App origins a deployed site may link out to. */
export function allowedAppUrls(): string[] {
  const frontend = stripTrailingSlash(process.env.FRONTEND_URL || "");
  return frontend ? [frontend, DEFAULT_APP_URL] : [DEFAULT_APP_URL];
}

/**
 * `wocoAppUrl` is interpolated straight into `href` attributes by the runtime
 * (`MultiSiteApp.svelte`, `ContactFormSection.svelte`), so a `javascript:` URL is
 * script execution on the site's own origin.
 */
export function isAllowedAppUrl(raw: string): boolean {
  return originAllowed(raw, allowedAppUrls()) || devLoopbackAllowed(raw);
}

/**
 * The API base a deployed site may be pointed at, or null if the server cannot
 * establish one.
 *
 * This value becomes the base for EVERY authenticated request the site makes
 * (`apps/web/src/lib/api/client.ts`), so a host of the organiser's choosing would
 * receive visitors' `X-Session-Delegation` and `X-Session-Sig` headers.
 *
 * The server is the authority on its own public identity — see
 * `lib/url/public-api-url.ts`. When it knows it, the client's claim is DISCARDED
 * rather than compared, so no near-miss is left to exploit. `sanitisePublicApiUrl`
 * is NOT sufficient here: it admits any https host, which is exactly the value an
 * attacker would supply.
 */
export function resolveDeployApiUrl(raw: string): string | null {
  const publicApiBase = stripTrailingSlash(process.env.PUBLIC_API_BASE || "");
  if (publicApiBase) return publicApiBase;
  return devLoopbackAllowed(raw) ? stripTrailingSlash(raw) : null;
}

export interface DeployUrls {
  apiUrl: string;
  gatewayUrl: string;
  wocoAppUrl: string;
}

export type DeployUrlResolution =
  | { ok: true; urls: DeployUrls }
  | { ok: false; error: string };

/**
 * Validate all three URLs a multi-page site deploy may set in SITE_CONFIG.
 *
 * Fails closed: an unrecognised value is an error, never a silent substitution,
 * so a misconfigured deploy is visible rather than quietly pointed elsewhere.
 */
export function resolveDeployUrls(input: {
  apiUrl: string;
  gatewayUrl: string;
  wocoAppUrl: string;
}): DeployUrlResolution {
  const apiUrl = resolveDeployApiUrl(input.apiUrl);
  if (!apiUrl) {
    return {
      ok: false,
      error: "Server cannot resolve its own public API base — set PUBLIC_API_BASE before deploying sites",
    };
  }

  if (!isAllowedGatewayUrl(input.gatewayUrl)) {
    return { ok: false, error: `gatewayUrl must be one of: ${allowedGatewayUrls().join(", ")}` };
  }

  if (!isAllowedAppUrl(input.wocoAppUrl)) {
    return { ok: false, error: `wocoAppUrl must be one of: ${allowedAppUrls().join(", ")}` };
  }

  return {
    ok: true,
    urls: {
      apiUrl,
      gatewayUrl: stripTrailingSlash(input.gatewayUrl),
      wocoAppUrl: stripTrailingSlash(input.wocoAppUrl),
    },
  };
}
