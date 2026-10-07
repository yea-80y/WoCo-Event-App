/**
 * Social apps' built-in browsers (Facebook, Instagram, LinkedIn, TikTok...) are
 * embedded web views: passkeys do not work in them (Android WebView ships
 * WebAuthn off unless the app opts in; an iOS WKWebView only reaches passkeys
 * for the app's own domains), and Google refuses its sign-in inside them
 * ("disallowed_useragent"). Someone who taps a WoCo link in one of those apps
 * can therefore not sign in at all. This finds those browsers and builds the
 * link that reopens the SAME page in a real browser (research 2026-10-07; #812).
 *
 * Same origin on purpose: a passkey belongs to the host it was made on, so the
 * escape keeps `location.host` and never swaps in a gateway (#605).
 *
 * Dependency-free and pure (the caller passes the user agent and page URL) so
 * the detection table is tested rather than eyeballed.
 */

export type InAppApp =
  | "facebook"
  | "instagram"
  | "threads"
  | "messenger"
  | "linkedin"
  | "tiktok"
  | "snapchat"
  | "telegram"
  | "line"
  | "wechat"
  | "x"
  | "webview";

export type InAppBrowser = { app: InAppApp; os: "android" | "ios" | "other" };

/** Names a person recognises; null = "this app" (a generic Android web view). */
export const IN_APP_NAMES: Record<InAppApp, string | null> = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  messenger: "Messenger",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  snapchat: "Snapchat",
  telegram: "Telegram",
  line: "LINE",
  wechat: "WeChat",
  x: "X",
  webview: null,
};

// Order matters: Messenger and Instagram builds can also carry Facebook's markers.
const MARKERS: ReadonlyArray<[InAppApp, RegExp]> = [
  ["instagram", /\bInstagram\b/],
  ["threads", /\bBarcelona\b/],
  ["messenger", /FBAN\/Messenger|MessengerForiOS|Orca-Android|MessengerLite/],
  ["facebook", /FBAN\/|FBAV\/|FB_IAB\/|\bFB4A\b|\bFBIOS\b/],
  ["linkedin", /LinkedInApp/],
  ["tiktok", /musical_ly|BytedanceWebview|\btrill_\d/],
  ["snapchat", /Snapchat\//],
  ["line", /\bLine\/\d/],
  ["wechat", /MicroMessenger/],
  ["x", /\bTwitter\b/],
];

export function detectInAppBrowser(
  userAgent: string,
  hints: {
    /** Telegram's in-app browser copies Safari's / Chrome's user agent; this global gives it away. */
    telegramProxy?: boolean;
    /** `"PublicKeyCredential" in window`. An Android web view without it can never do passkeys. */
    publicKeyCredential?: boolean;
    /** iPadOS reports a desktop Mac; a touch screen says otherwise. */
    touchMac?: boolean;
  } = {},
): InAppBrowser | null {
  const os = /Android/i.test(userAgent)
    ? "android"
    : /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && hints.touchMac)
      ? "ios"
      : "other";
  for (const [app, marker] of MARKERS) {
    if (marker.test(userAgent)) return { app, os };
  }
  if (hints.telegramProxy) return { app: "telegram", os };
  // Any other Android app's web view: the "; wv)" token, or no WebAuthn at all.
  if (os === "android" && (/;\s*wv\)/.test(userAgent) || hints.publicKeyCredential === false)) {
    return { app: "webview", os };
  }
  return null;
}

/** Query parameter that carries the `#/route` across an Android intent, which
 *  cannot hold a fragment (`#Intent;...` takes its place). */
export const ESCAPE_ROUTE_PARAM = "woco-open";
/** Set on the fallback page an Android intent loads when Chrome is not there. */
export const ESCAPE_FAILED_PARAM = "woco-escape";

export type EscapeLink =
  /** Chrome by package; falls back to this page with the failed flag. */
  | { kind: "chrome"; href: string }
  /** Whatever browser the device opens by default (no package named). */
  | { kind: "default-browser"; href: string }
  | { kind: "safari"; href: string }
  /** Instagram's own "open in the default browser" hand-off. */
  | { kind: "instagram"; href: string };

function intentFor(page: URL, opts: { chrome: boolean }): string {
  const target = new URL(page.href);
  target.searchParams.delete(ESCAPE_FAILED_PARAM);
  if (target.hash) target.searchParams.set(ESCAPE_ROUTE_PARAM, target.hash);
  target.hash = "";
  const fallback = new URL(page.href);
  fallback.searchParams.set(ESCAPE_FAILED_PARAM, "1");
  const extras = opts.chrome
    ? `package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(fallback.href)};`
    : "action=android.intent.action.VIEW;";
  return `intent://${target.host}${target.pathname}${target.search}#Intent;scheme=https;${extras}end`;
}

/**
 * The link that reopens `page` in a real browser, or null where no link is
 * known to work from that app (the screen then shows the manual steps only).
 * Measured per app (2026-10-07): LinkedIn on Android breaks intents; TikTok,
 * Messenger and Snapchat on iOS refuse or swallow the Safari hand-off.
 */
export function escapeLink(found: InAppBrowser, page: URL, opts: { chromeFailed?: boolean } = {}): EscapeLink | null {
  if (page.protocol !== "https:") return null;
  if (found.os === "android") {
    if (found.app === "linkedin") return null;
    return opts.chromeFailed
      ? { kind: "default-browser", href: intentFor(page, { chrome: false }) }
      : { kind: "chrome", href: intentFor(page, { chrome: true }) };
  }
  if (found.os === "ios") {
    if (found.app === "instagram") {
      return { kind: "instagram", href: `instagram://extbrowser/?url=${encodeURIComponent(page.href)}` };
    }
    if (found.app === "tiktok" || found.app === "messenger" || found.app === "snapchat") return null;
    return { kind: "safari", href: `x-safari-${page.href}` };
  }
  return null;
}

/**
 * Put back the `#/route` an Android intent carried in the query, before the
 * router first reads the hash. Only a `#/...` route is accepted; the parameter
 * is always removed so a shared link never carries it on.
 */
export function restoreEscapedRoute(loc: Pick<Location, "href">, replace: (url: string) => void): void {
  let url: URL;
  try {
    url = new URL(loc.href);
  } catch {
    return;
  }
  const carried = url.searchParams.get(ESCAPE_ROUTE_PARAM);
  if (carried === null) return;
  url.searchParams.delete(ESCAPE_ROUTE_PARAM);
  if (/^#\/[^\s]*$/.test(carried) && !url.hash) url.hash = carried;
  replace(url.href);
}
