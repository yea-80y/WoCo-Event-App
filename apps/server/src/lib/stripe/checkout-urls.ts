/**
 * Where Stripe sends a buyer after checkout (#567).
 *
 * The embed widget names the organiser page the buyer is on (`pageUrl`), and
 * both success and cancel return there with a `woco=` marker in that page's own
 * query. A WoCo-built site sends `siteId` + `returnUrl` and gets its event route
 * back. The main app sends neither and keeps the platform pages.
 *
 * A page is an acceptable destination when it is a well-formed https URL (http
 * only on localhost), with no host list: the redirect is issued by Stripe, not by
 * a WoCo origin, and whoever creates a session could as easily host the widget on
 * the page they name, so a list would gate nothing. ALLOWED_HOSTS stays out of
 * this on purpose — it is also the session-delegation host guard.
 */

import { canonicalSuccessUrl } from "./return-url.js";

const SESSION_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";
const MAX_URL_LENGTH = 2048;
const MARKER_PARAMS = new Set(["woco", "stripe", "session_id"]);

/** The parsed URL, or null unless it is https (or http on localhost) with no credentials. */
export function acceptablePageUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password) return null;
  return u;
}

/** A raw `a=1&b=2` query without our return markers, every other pair left byte-for-byte. */
function dropMarkers(query: string): string {
  return query
    .split("&")
    .filter((pair) => pair !== "" && !MARKER_PARAMS.has(pair.split("=")[0]))
    .join("&");
}

function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}

/**
 * `href` split at the hash, with markers from an earlier return removed from the
 * query and from the hash route's query — so a retry replaces them, never stacks.
 */
function cleanParts(href: string): { base: string; hash: string } {
  const hashAt = href.indexOf("#");
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const rawHash = hashAt === -1 ? "" : href.slice(hashAt);
  const q = beforeHash.indexOf("?");
  const base = q === -1 ? beforeHash : withQuery(beforeHash.slice(0, q), dropMarkers(beforeHash.slice(q + 1)));
  const hq = rawHash.indexOf("?");
  const hash = hq === -1 ? rawHash : withQuery(rawHash.slice(0, hq), dropMarkers(rawHash.slice(hq + 1)));
  return { base, hash };
}

function appendPair(url: string, pair: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${pair}`;
}

export interface CheckoutUrlInputs {
  eventId: string;
  /** Validated deployed-site id, when checkout started on a WoCo-built site. */
  siteId?: string;
  /** The site or app page the client is on, without hash and query. */
  returnUrl?: unknown;
  /** The full page URL an app or site client sent for Cancel. */
  cancelUrl?: unknown;
  /** The organiser page hosting the embed widget. */
  pageUrl?: unknown;
  /**
   * The request's WoCo frontend base (validateReturnUrl ?? getFrontendUrl).
   * Lazy because resolving it logs when it falls back, which is noise for an
   * embed checkout that never uses it.
   */
  frontendUrl: () => string;
}

export function checkoutRedirectUrls(i: CheckoutUrlInputs): { successUrl: string; cancelUrl: string } {
  const event = encodeURIComponent(i.eventId);

  const page = acceptablePageUrl(i.pageUrl);
  if (page) {
    // The marker goes in the page's own query, ahead of any hash, where the
    // widget reads it from `location.search` without disturbing the page's route.
    const { base, hash } = cleanParts(page.href);
    return {
      successUrl: `${appendPair(base, `woco=success&session_id=${SESSION_PLACEHOLDER}`)}${hash}`,
      cancelUrl: `${appendPair(base, "woco=cancelled")}${hash}`,
    };
  }

  const site = i.siteId ? acceptablePageUrl(i.returnUrl) : null;
  const base = site
    ? `${site.origin}${site.pathname.replace(/\/$/, "")}`
    : i.siteId
      ? i.frontendUrl()
      : canonicalSuccessUrl(i.frontendUrl());
  const successUrl = i.siteId
    ? `${base}/#/events/${event}?stripe=success&session_id=${SESSION_PLACEHOLDER}`
    : `${base}/#/event/${event}/purchased?stripe=success&session_id=${SESSION_PLACEHOLDER}`;

  const back = acceptablePageUrl(i.cancelUrl);
  if (!back) return { successUrl, cancelUrl: `${base}/#/event/${event}?stripe=cancelled` };
  // The WoCo app routes in the hash, so its marker goes where the hash router reads it.
  const { base: backBase, hash } = cleanParts(back.href);
  const cancelUrl = hash
    ? `${backBase}${hash}${hash.includes("?") ? "&" : "?"}stripe=cancelled`
    : appendPair(backBase, "stripe=cancelled");
  return { successUrl, cancelUrl };
}
