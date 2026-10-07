/**
 * The link that reopens this page in a real browser from a social app's
 * built-in one (#812). Lazy: only the in-app notice loads it.
 */
import type { InAppApp, InAppBrowser } from "./in-app-browser.js";
import { ESCAPE_FAILED_PARAM, ESCAPE_ROUTE_PARAM, isCarriableRoute } from "./in-app-route.js";

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

export type EscapeLink =
  /** Chrome by package; falls back to this page with the failed flag. */
  | { kind: "chrome"; href: string }
  /** Whatever browser the device opens by default (no package named). */
  | { kind: "default-browser"; href: string }
  | { kind: "safari"; href: string }
  /** Instagram's own "open in the default browser" hand-off. */
  | { kind: "instagram"; href: string };

/** Null when the page's route may not travel in a query (see `isCarriableRoute`). */
function intentFor(page: URL, opts: { chrome: boolean }): string | null {
  if (page.hash && !isCarriableRoute(page.hash)) return null;
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
 * Messenger and Snapchat on iOS refuse or swallow the Safari hand-off; a
 * generic Android web view is unmeasured, so it gets the steps too.
 */
export function escapeLink(found: InAppBrowser, page: URL, opts: { chromeFailed?: boolean } = {}): EscapeLink | null {
  if (page.protocol !== "https:") return null;
  if (found.os === "android") {
    // LinkedIn breaks intents; a generic web view's handling of them was never
    // measured (one that does not hand them on shows an error page).
    if (found.app === "linkedin" || found.app === "webview") return null;
    const href = intentFor(page, { chrome: !opts.chromeFailed });
    if (!href) return null;
    return opts.chromeFailed ? { kind: "default-browser", href } : { kind: "chrome", href };
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

