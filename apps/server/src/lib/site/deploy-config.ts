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
 * This is NOT sufficient on its own — see `siteConfigScript`, which is what the
 * deploy actually emits. Escaping keeps organiser text inside the string context;
 * it does nothing about the semantics of the surrounding object literal.
 */
export function jsonForInlineScript(value: unknown): string {
  // stringify returns undefined for undefined / function / symbol input.
  return escapeForInlineScript(JSON.stringify(value) ?? "null");
}

/**
 * The escaping step alone, for callers that already hold the exact source text.
 *
 * Kept separate because conflating it with serialisation is an easy and silent
 * mistake: passing an already-serialised string to {@link jsonForInlineScript}
 * stringifies it a second time, and the page then parses its way back to a STRING
 * rather than the object. Nothing throws — `window.SITE_CONFIG` is simply the
 * wrong type, on an immutable artifact.
 */
export function escapeForInlineScript(source: string): string {
  return source.replace(INLINE_SCRIPT_UNSAFE, (ch) => INLINE_SCRIPT_ESCAPES[ch]);
}

/**
 * The `<script>` element the deploy injects, assigning `window.SITE_CONFIG`.
 *
 * The payload is emitted as a STRING passed to `JSON.parse`, not as a bare object
 * literal, and that difference is load-bearing rather than stylistic.
 *
 * An object literal is evaluated by the engine, and in an object initialiser the
 * key `__proto__` SETS THE PROTOTYPE instead of creating an own property.
 * `JSON.parse` has no such rule — it creates an own property like any other. The
 * request body is parsed JSON and `body.site` is used verbatim, so an organiser
 * can put `__proto__` anywhere in it; TypeScript types do not validate at runtime.
 * Escaping cannot reach this, because nothing is escaping: the key is structural,
 * not text.
 *
 * It also makes the round-trip test mean what it claims. The test asserts
 * `JSON.parse(jsonForInlineScript(x))` equals `x` — which only models the real
 * consumer once the real consumer is also `JSON.parse`.
 *
 * `<script type="application/json">` would NOT have been an alternative here, for
 * the record: a script element's content is tokenised in script-data state
 * whatever its type, so `</script>` still terminates it and `<` still has to be
 * escaped. It would have downgraded a missed escape from "script runs" to "parse
 * error" — worth having, but it is not the control, and it would have needed the
 * deployed bundle to change first.
 *
 * Escaping still applies, on the outside: the JSON text is wrapped as a JS string
 * literal (which handles quotes and backslashes) and the result is escaped for the
 * HTML context (which handles `<`).
 */
export function siteConfigScript(config: unknown): string {
  // Three distinct steps, each doing one job:
  //   1. the JSON text the page will parse,
  //   2. wrapped as a JS string literal — this is what handles quotes and
  //      backslashes, so the argument to JSON.parse cannot be broken out of,
  //   3. escaped for the HTML context — this is what handles `<`.
  const json = JSON.stringify(config) ?? "null";
  const literal = JSON.stringify(json);
  return `<script>window.SITE_CONFIG=JSON.parse(${escapeForInlineScript(literal)});</script>`;
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

/**
 * Escape a value for an HTML ATTRIBUTE, quotes included.
 *
 * The deploy builds `<meta … content="${...}">` and `<link … href="${...}">` out
 * of organiser-authored theme fields. Omitting `"` — which one of the three
 * copies of this helper in the server did — leaves every one of them open to
 * attribute injection, which is a single `>` away from opening a new tag.
 */
export function escapeHtmlAttribute(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Splice `snippet` in immediately before the document's `</head>`.
 *
 * The replacement is a FUNCTION, not a string, and that is the entire point:
 * `String.replace` expands `$$`, `$&`, `` $` `` and `$'` inside a string
 * replacement. The snippets here carry organiser free text, so a brand name of
 * `` $` `` spliced the whole preceding document into the payload — which in the
 * real template drags a `</script>` in and stops `window.SITE_CONFIG` ever being
 * assigned. A function replacement is used verbatim.
 */
export function injectBeforeHeadClose(html: string, snippet: string): string {
  return html.replace("</head>", () => `${snippet}\n  </head>`);
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
 * the developer running it, so it cannot be pointed at anyone else — but production
 * has no dev flow to serve, so it fails closed there rather than resting on that
 * reasoning holding.
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
 * rather than compared, so there is no near-miss left to match. `sanitisePublicApiUrl`
 * is NOT sufficient here: it admits any https host, which is exactly the value an
 * must not be trusted here.
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
      gatewayUrl: originOf(input.gatewayUrl) ?? stripTrailingSlash(input.gatewayUrl),
      wocoAppUrl: originOf(input.wocoAppUrl) ?? stripTrailingSlash(input.wocoAppUrl),
    },
  };
}
