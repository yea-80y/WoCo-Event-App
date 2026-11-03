/**
 * Rendering a single-event page (#1032 slice 5): the same pure functions for the
 * browser's build and the server's admitting rebuild, as `render.ts` is for
 * websites. Moved verbatim from apps/server (lib/site/deploy-config.ts,
 * routes/site.ts); `test/fixtures/event-page-render-vectors.json` holds the
 * server's output from before the move.
 *
 * The page head carries the event's title and image (icon + share preview) baked
 * in at publish, for crawlers that run no script. Their inputs are the organiser's
 * own event fields, so they are parsed strictly (`parseEventPageHead`) and every
 * one is attribute-escaped.
 */

import { escapeHtmlAttribute, injectBeforeHeadClose, siteConfigScript } from "./render.js";

/** An event page's index document in the runtime (`apps/web/dist-site`). */
export const EVENT_PAGE_INDEX_DOCUMENT = "site.html";
/** The longest event title a page head takes. */
export const EVENT_PAGE_TITLE_MAX = 200;
/** Chat crawlers ignore relative URLs, so the share fallback is the app's own copy. */
const DEFAULT_APP_URL = "https://woco.eth.limo";

/** What the head is rendered from: the event's title and image, as the event holds them. */
export interface EventPageHead {
  title?: string;
  imageHash?: string;
}

/** The `window.SITE_CONFIG` an event page carries. Key order is part of the bytes. */
export interface EventPageConfig {
  apiUrl: string;
  gatewayUrl: string;
  contentGatewayUrl: string;
  eventId: string;
  eventSigner: string;
}

export function eventPageDeployConfig(c: EventPageConfig): EventPageConfig {
  return { apiUrl: c.apiUrl, gatewayUrl: c.gatewayUrl, contentGatewayUrl: c.contentGatewayUrl, eventId: c.eventId, eventSigner: c.eventSigner };
}

/**
 * A head a browser sends with its build, or null. Strict and non-normalising: a
 * title of 1-200 characters (whitespace is trimmed by the render, never here), an
 * image reference absent or 64 LOWERCASE hex and not all zero. Nothing else.
 */
export function parseEventPageHead(v: unknown): { title: string; imageHash?: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "title" && k !== "imageHash") return null;
  if (typeof o.title !== "string" || o.title.length < 1 || o.title.length > EVENT_PAGE_TITLE_MAX) return null;
  if (o.imageHash === undefined) return { title: o.title };
  if (typeof o.imageHash !== "string" || !/^[0-9a-f]{64}$/.test(o.imageHash) || /^0+$/.test(o.imageHash)) return null;
  return { title: o.title, imageHash: o.imageHash };
}

function stripTrailingSlash(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** The runtime template's own `<title>` (site.html says "Event"). */
const TEMPLATE_TITLE = /<title>[^<]*<\/title>/i;

/**
 * The title, icon + share tags baked into a single-event page. The event's own image
 * when it has one, WoCo's logo (bundled in dist-site) otherwise - the same rule
 * `deployHeadLines` (render.ts) applies to a site's logo. Any icon link the
 * template carries is dropped first, so the event's is the only one a browser
 * or the iOS home screen can pick. The `<title>` is written here, not only by the
 * runtime, because crawlers that run no script read the HTML as served (#70).
 */
export function withEventPageHead(
  html: string,
  event: EventPageHead | null,
  contentGatewayUrl: string,
): string {
  const ref = event?.imageHash ?? "";
  const image = escapeHtmlAttribute(
    /^[0-9a-f]{64}$/i.test(ref) && !/^0+$/.test(ref) ? `${stripTrailingSlash(contentGatewayUrl)}/bytes/${ref}` : "./logo.png",
  );
  const share = image === "./logo.png" ? `${DEFAULT_APP_URL}/logo.png` : image;
  const title = escapeHtmlAttribute(event?.title?.trim() ?? "");
  const lines = [
    `  <link rel="manifest" href="./manifest.json">`,
    `  <link rel="icon" href="${image}">`,
    `  <link rel="apple-touch-icon" href="${image}">`,
    `  <meta property="og:type" content="website">`,
    title ? `  <meta property="og:title" content="${title}">` : "",
    `  <meta property="og:image" content="${share}">`,
    `  <meta name="twitter:card" content="summary_large_image">`,
    title ? `  <meta name="twitter:title" content="${title}">` : "",
    `  <meta name="twitter:image" content="${share}">`,
  ].filter(Boolean).join("\n");
  const stripped = html.replace(/\s*<link\b[^>]*\brel=["']?(?:shortcut )?icon["']?[^>]*>/gi, "");
  // A replacer FUNCTION: a string would read `$&` or `` $` `` in the title as a pattern.
  const titled = !title
    ? stripped
    : TEMPLATE_TITLE.test(stripped)
      ? stripped.replace(TEMPLATE_TITLE, () => `<title>${title}</title>`)
      : injectBeforeHeadClose(stripped, `  <title>${title}</title>`);
  return injectBeforeHeadClose(titled, lines);
}

/** An event page's HTML: the runtime's template, the config script, then the head. */
export function renderEventPageHtml(input: { template: string; config: EventPageConfig; head: EventPageHead | null }): string {
  const withConfig = injectBeforeHeadClose(input.template, `  ${siteConfigScript(input.config)}`);
  return withEventPageHead(withConfig, input.head, input.config.contentGatewayUrl);
}

/** WoCo's own colours (apps/web/public/manifest.json): a page's install surface. */
const EVENT_PAGE_THEME = "#0B0B09";

/**
 * The PWA web manifest an event page carries as `manifest.json`, rendered per page
 * like a website's (#1032 slice 5): the release's own manifest.json is the APP's
 * and is never linked from a page. Icons are the runtime's (released under icons/).
 */
export function eventPagePwaManifest(head: EventPageHead | null): Record<string, unknown> {
  const name = head?.title?.trim() || "Event";
  return {
    name,
    short_name: name,
    start_url: `./${EVENT_PAGE_INDEX_DOCUMENT}`,
    display: "standalone",
    background_color: EVENT_PAGE_THEME,
    theme_color: EVENT_PAGE_THEME,
    icons: [
      { src: "./icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "./icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
