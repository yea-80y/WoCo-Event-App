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

import { ETHERNA_GATEWAY_URL, WOCO_GATEWAY_URL } from "@woco/shared";

/** Where the WoCo app lives when the operator has not said otherwise. */
const DEFAULT_APP_URL = "https://woco.eth.limo";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

// The HTML/script escaping and the site render moved to packages/shared
// (src/site/render.ts, #1032 slice 2) so the browser's publish and this server
// render the same bytes. Re-exported here for the deploy routes and their tests.
export {
  jsonForInlineScript,
  escapeForInlineScript,
  siteConfigScript,
  escapeHtmlAttribute,
  injectBeforeHeadClose,
} from "@woco/shared";

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

/**
 * `scheme://host[:port]` of a URL, or null if it will not parse.
 *
 * Exported because BOTH deploy routes have to bake the canonical form, not the
 * submitted one. Forwarding the submitted bytes after validating the parsed value
 * is the defect this file already fixed once; `routes/site.ts` was left on the
 * submitted form and kept baking a trailing slash, an odd-case host or an explicit
 * :443 into a page that cannot be edited afterwards.
 */
export function canonicalOrigin(raw: string): string | null {
  try {
    return new URL(stripTrailingSlash(raw)).origin;
  } catch {
    return null;
  }
}

/**
 * A loopback URL, and only when the environment explicitly says development or
 * test. It is unreachable to anyone but the developer running it, so it cannot be
 * pointed at anyone else — but nothing outside a declared dev environment has a
 * dev flow to serve, so everything else fails closed.
 */
function devLoopbackAllowed(raw: string): boolean {
  // Allowed only when the environment says DEVELOPMENT, never merely when it
  // fails to say production. An unset NODE_ENV is how loopback ends up permitted
  // in production — the default has to be the safe one, not the convenient one.
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") return false;
  // Bare-origin too: this branch bypasses originAllowed, so without it a
  // loopback URL would be the way round the path check.
  if (!isBareOrigin(raw)) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(raw.trim()).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/**
 * True when `raw` is a BARE origin — no path, query or fragment.
 *
 * Origin equality alone is not enough, because these values are not only
 * compared, they are CARRIED: `${gatewayUrl}/bytes/${ref}` lands in an `href`
 * and `${wocoAppUrl}/#/legal/privacy` in another. A value whose origin is
 * allowed but whose path is `/"><script>…</script>` passes an origin check and
 * still breaks out of the attribute. Everything after the origin is discarded
 * information for these three fields, so requiring its absence costs nothing.
 */
function isBareOrigin(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * True when `raw` is a bare origin that EXACTLY equals one of `allowed`.
 *
 * Exact, never suffix matching: `new URL(x).host.endsWith("gateway.woco-net.com")`
 * — the shape used for batch routing — also matches `evilgateway.woco-net.com`.
 * That particular name sits inside a domain WoCo owns, so it is not registrable
 * by an outsider; the reason to require exact equality is that nothing should
 * depend on that being true of every future entry in the list.
 */
function originAllowed(raw: string, allowed: string[]): boolean {
  if (!isBareOrigin(raw)) return false;
  const origin = canonicalOrigin(raw);
  if (!origin) return false;
  return allowed.some((a) => canonicalOrigin(a) === origin);
}

/** Gateways a site may be deployed to and read its content back through. */
export function allowedGatewayUrls(): string[] {
  // The canonical host, not the server's fetch base: a deployed page fetches from
  // here in a browser, and the client only ever offers the canonical one (#657).
  return [WOCO_GATEWAY_URL, ETHERNA_GATEWAY_URL];
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
 * rather than compared, so there is no near-miss left to match. `sanitisePublicApiUrl`
 * is NOT sufficient here: it rejects only private and non-https hosts, so it
 * admits any https host at all — which is precisely the value that must not be
 * trusted on this path.
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

  // Forward the PARSED origin, never the submitted bytes. Validating a string and
  // then carrying it forward is what let a crafted path ride an allowed origin the
  // first time; any differential between this parser and a downstream consumer
  // reopens that. `originOf` cannot be null here — originAllowed already parsed
  // both, and the loopback branch is parsed by devLoopbackAllowed — but the
  // fallback keeps the type honest rather than asserting.
  return {
    ok: true,
    urls: {
      apiUrl,
      gatewayUrl: canonicalOrigin(input.gatewayUrl) ?? stripTrailingSlash(input.gatewayUrl),
      wocoAppUrl: canonicalOrigin(input.wocoAppUrl) ?? stripTrailingSlash(input.wocoAppUrl),
    },
  };
}
