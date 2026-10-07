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
 * the detection table is tested rather than eyeballed. Lazy: the sign-in sheet
 * loads it when it first opens. The link builder lives in `in-app-escape.ts`
 * (loaded only inside such a browser); the route carrier the router needs
 * before its first read lives in `in-app-route.ts` (eager, small).
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
