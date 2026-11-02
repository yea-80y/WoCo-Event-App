/**
 * Rendering a deployed site's HTML and manifest (#1032 slice 2): the same pure
 * functions for the server's deploy today and the browser's publish later, so the
 * two can never drift - and so the server can re-render what a client sends and
 * admit it only when the bytes match (the origin rule in #1032).
 *
 * Moved verbatim from apps/server (lib/site/deploy-config.ts, routes/sites.ts);
 * `test/fixtures/site-render-vectors.json` holds the server's output from before
 * the move. The deploy body is authored by the ORGANISER and the output is an
 * immutable, publicly addressed collection, so every escape below is load-bearing.
 */

import type { Site } from "./types.js";

/**
 * Line and paragraph separator, built from their code points rather than written
 * as literals: as literals they are invisible in an editor, and an earlier draft
 * had both silently replaced with ordinary SPACES in transit, which would have
 * rewritten every space of every deployed site as U+2028.
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

/** Derived from the table's own keys so the two can never drift apart. */
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
  return source.replace(INLINE_SCRIPT_UNSAFE, (ch) => INLINE_SCRIPT_ESCAPES[ch]!);
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

/** The SEO + PWA head tags baked into a deployed site. Every interpolation is escaped. */
export function deployHeadLines(site: Site, gatewayUrl: string): string {
  const desc = site.theme.siteDescription?.trim() ?? "";
  const brandNameEsc = escapeHtmlAttribute(site.theme.brandName?.trim() || "WoCo Site");
  const descEsc = escapeHtmlAttribute(desc);
  const logoRef = site.theme.logoSwarmRef;
  // Organiser logo when set; WoCo brand image (always bundled in the collection) otherwise.
  const thumbnailUrl = escapeHtmlAttribute(
    logoRef && !/^0+$/.test(logoRef) ? `${gatewayUrl}/bytes/${logoRef}` : "./logo.png",
  );
  const themeColorEsc = escapeHtmlAttribute(site.theme.palette.accent ?? "");

  return [
    `  <link rel="manifest" href="./manifest.json">`,
    thumbnailUrl ? `  <link rel="icon" href="${thumbnailUrl}">` : "",
    `  <meta name="theme-color" content="${themeColorEsc}">`,
    desc ? `  <meta name="description" content="${descEsc}">` : "",
    `  <meta property="og:type" content="website">`,
    `  <meta property="og:title" content="${brandNameEsc}">`,
    desc ? `  <meta property="og:description" content="${descEsc}">` : "",
    thumbnailUrl ? `  <meta property="og:image" content="${thumbnailUrl}">` : "",
    `  <meta name="twitter:card" content="${thumbnailUrl ? "summary_large_image" : "summary"}">`,
    `  <meta name="twitter:title" content="${brandNameEsc}">`,
    desc ? `  <meta name="twitter:description" content="${descEsc}">` : "",
    thumbnailUrl ? `  <meta name="twitter:image" content="${thumbnailUrl}">` : "",
  ].filter(Boolean).join("\n");
}

/** The PWA web manifest a deployed site carries as `manifest.json`. */
export function sitePwaManifest(site: Site): Record<string, unknown> {
  return {
    name: site.theme.brandName,
    short_name: site.theme.brandName,
    start_url: "./multi-site.html",
    display: "standalone",
    background_color: site.theme.palette.bg,
    theme_color: site.theme.palette.accent,
    icons: [
      { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

/**
 * A deployed site's HTML: the runtime's template with the `window.SITE_CONFIG`
 * script, then the SEO/PWA head tags, spliced in before `</head>`. `config` is the
 * whole injected object (`site`, `gatewayUrl`, `apiUrl`, `wocoAppUrl`, and
 * `contentGatewayUrl` for Etherna-hosted sites).
 */
export function renderSiteHtml(input: { template: string; config: unknown; site: Site; gatewayUrl: string }): string {
  const withConfig = injectBeforeHeadClose(input.template, `  ${siteConfigScript(input.config)}`);
  return injectBeforeHeadClose(withConfig, deployHeadLines(input.site, input.gatewayUrl));
}
