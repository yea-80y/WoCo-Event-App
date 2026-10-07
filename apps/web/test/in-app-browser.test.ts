/**
 * Social apps' built-in browsers and the way out of them (#812).
 * User agents are the shapes those apps send (markers per research 2026-10-07).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectInAppBrowser } from "../src/lib/browser/in-app-browser.js";
import {
  isCarriableRoute,
  restoreEscapedRoute,
  ESCAPE_FAILED_PARAM,
  ESCAPE_ROUTE_PARAM,
} from "../src/lib/browser/in-app-route.js";
import { escapeLink } from "../src/lib/browser/in-app-escape.js";

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_WV =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36";

const UAS: Array<[string, string, string, string]> = [
  ["Facebook iOS", `${IOS} [FBAN/FBIOS;FBAV/470.0.0.43.105;FBBV/1;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5]`, "facebook", "ios"],
  ["Facebook Android", `${ANDROID_WV} [FB_IAB/FB4A;FBAV/478.0.0.43.86;]`, "facebook", "android"],
  ["Instagram iOS", `${IOS} Instagram 340.0.2.18.81 (iPhone15,2; iOS 17_5; en_GB; en-GB; scale=3.00; 1179x2556; 621234567)`, "instagram", "ios"],
  ["Instagram Android (also carries FB markers)", `${ANDROID_WV} [FB_IAB/FB4A;FBAV/478.0;] Instagram 340.0.0.22.109 Android (34/14; 420dpi)`, "instagram", "android"],
  ["Messenger iOS", `${IOS} [FBAN/MessengerForiOS;FBAV/470.0;FBBV/1]`, "messenger", "ios"],
  ["Messenger Android", `${ANDROID_WV} [FB_IAB/Orca-Android;FBAV/478.0;]`, "messenger", "android"],
  ["Threads iOS", `${IOS} Barcelona 340.0.0.18.81 (iPhone15,2; iOS 17_5)`, "threads", "ios"],
  ["LinkedIn iOS", `${IOS} [LinkedInApp]/9.29.1`, "linkedin", "ios"],
  ["LinkedIn Android", `${ANDROID_WV} [LinkedInApp]/4.1.9`, "linkedin", "android"],
  ["TikTok iOS", `${IOS} musical_ly_34.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/GB`, "tiktok", "ios"],
  ["TikTok Android", `${ANDROID_WV} trill_340102 JsSdk/1.0 NetType/WIFI BytedanceWebview/d8a21c6`, "tiktok", "android"],
  ["Snapchat iOS", `${IOS} Snapchat/12.95.0.37 (like Safari/8617.2.4.10.8, panda)`, "snapchat", "ios"],
  ["LINE iOS", `${IOS} Safari Line/14.11.0`, "line", "ios"],
  ["WeChat Android", `${ANDROID_WV} MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64`, "wechat", "android"],
  ["X iOS web view", `${IOS} Twitter for iPhone/10.50`, "x", "ios"],
  ["any other Android app's web view", ANDROID_WV, "webview", "android"],
];

for (const [name, ua, app, os] of UAS) {
  test(`detects ${name}`, () => {
    assert.deepEqual(detectInAppBrowser(ua), { app, os });
  });
}

test("real browsers (and Custom Tabs / Safari views, which look like them) are never flagged", () => {
  for (const ua of [
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
    `${IOS.replace("Mobile/15E148", "Version/17.5 Mobile/15E148 Safari/604.1")}`,
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  ]) {
    assert.equal(detectInAppBrowser(ua, { publicKeyCredential: true }), null, ua);
  }
});

test("Telegram copies a real browser's user agent; its injected global gives it away", () => {
  const chrome = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(detectInAppBrowser(chrome, { telegramProxy: true }), { app: "telegram", os: "android" });
});

test("an Android browser without WebAuthn is a web view even without the wv token", () => {
  const ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";
  assert.deepEqual(detectInAppBrowser(ua, { publicKeyCredential: false }), { app: "webview", os: "android" });
  assert.equal(detectInAppBrowser(ua, { publicKeyCredential: true }), null);
});

test("an iPad (desktop user agent, touch screen) inside Facebook is iOS", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]";
  assert.deepEqual(detectInAppBrowser(ua, { touchMac: true }), { app: "facebook", os: "ios" });
});

// --- the way out ---------------------------------------------------------------

const PAGE = new URL("https://woco.eth.limo/?ref=fb#/event/abc123");

test("Android: Chrome by package, same host and path, route carried in the query, fallback flagged", () => {
  const link = escapeLink({ app: "facebook", os: "android" }, PAGE);
  assert.equal(link?.kind, "chrome");
  const href = link!.href;
  assert.ok(href.startsWith("intent://woco.eth.limo/?ref=fb&"), "same origin, never a gateway");
  assert.ok(href.includes(`${ESCAPE_ROUTE_PARAM}=%23%2Fevent%2Fabc123`), "the #/route survives the intent");
  assert.ok(href.includes("#Intent;scheme=https;package=com.android.chrome;"));
  const fallback = decodeURIComponent(href.match(/S\.browser_fallback_url=([^;]+);/)![1]);
  assert.equal(fallback, `https://woco.eth.limo/?ref=fb&${ESCAPE_FAILED_PARAM}=1#/event/abc123`);
  assert.ok(href.endsWith(";end"));
});

test("Android after Chrome failed: the device's default browser, no package named", () => {
  const link = escapeLink({ app: "facebook", os: "android" }, PAGE, { chromeFailed: true });
  assert.equal(link?.kind, "default-browser");
  assert.ok(!link!.href.includes("package="));
  assert.ok(link!.href.includes("action=android.intent.action.VIEW;"));
});

test("a gateway page keeps its own path - the escape never changes where the passkey lives", () => {
  const gw = new URL("https://gateway.woco-net.com/bzz/abcd/#/creator");
  assert.ok(escapeLink({ app: "webview", os: "android" }, gw)!.href.startsWith("intent://gateway.woco-net.com/bzz/abcd/?"));
});

test("iOS: Safari with the whole URL, fragment included", () => {
  assert.deepEqual(escapeLink({ app: "facebook", os: "ios" }, PAGE), {
    kind: "safari",
    href: "x-safari-https://woco.eth.limo/?ref=fb#/event/abc123",
  });
});

test("Instagram on iOS uses its own hand-off to the default browser", () => {
  const link = escapeLink({ app: "instagram", os: "ios" }, PAGE);
  assert.equal(link?.kind, "instagram");
  assert.equal(link!.href, `instagram://extbrowser/?url=${encodeURIComponent(PAGE.href)}`);
});

test("apps where no link is known to work get the manual steps only", () => {
  assert.equal(escapeLink({ app: "linkedin", os: "android" }, PAGE), null);
  for (const app of ["tiktok", "messenger", "snapchat"] as const) {
    assert.equal(escapeLink({ app, os: "ios" }, PAGE), null, app);
  }
  assert.equal(escapeLink({ app: "facebook", os: "other" }, PAGE), null);
  assert.equal(escapeLink({ app: "facebook", os: "ios" }, new URL("http://localhost:5173/#/x")), null, "never off https");
});

// --- the route comes back ------------------------------------------------------

test("the carried route is put back as the fragment and the parameter removed", () => {
  let replaced = "";
  restoreEscapedRoute({ href: `https://woco.eth.limo/?ref=fb&${ESCAPE_ROUTE_PARAM}=%23%2Fevent%2Fabc123` }, (u) => (replaced = u));
  assert.equal(replaced, "https://woco.eth.limo/?ref=fb#/event/abc123");
});

// --- only routes that hold nothing private travel in a query --------------------

test("public routes may travel in the query", () => {
  for (const ok of [
    "#/",
    "#/event/abc123",
    "#/event/abc-123_X/purchased",
    "#/ref/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    "#/ref/theirvenue",
    "#/discover",
    "#/tickets",
    "#/creator",
    "#/creator/events/new",
    "#/legal/privacy",
    "#/profile/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  ]) {
    assert.equal(isCarriableRoute(ok), true, ok);
  }
});

test("a route with a query, or any shape not on the list, never travels", () => {
  for (const bad of [
    "#/signup?gt=SECRET_GATE_TOKEN",
    "#/creator/audience?announce=ev1",
    "#/event/abc?x=1",
    "#/link",
    "#/recover",
    "#/soon/thing",
    "#/coaster/0x" + "a".repeat(64),
    "#/event/a b",
    "#/../../etc",
  ]) {
    assert.equal(isCarriableRoute(bad), false, bad);
  }
});

test("Android: a page whose route may not travel gets no intent - only the manual steps", () => {
  const secret = new URL("https://woco.eth.limo/#/signup?gt=SECRET_GATE_TOKEN");
  assert.equal(escapeLink({ app: "facebook", os: "android" }, secret), null);
  assert.equal(escapeLink({ app: "facebook", os: "android" }, secret, { chromeFailed: true }), null);
});

test("iOS keeps the fragment client-side, so any route may go to Safari", () => {
  const secret = new URL("https://woco.eth.limo/#/signup?gt=SECRET_GATE_TOKEN");
  assert.equal(escapeLink({ app: "facebook", os: "ios" }, secret)?.href, `x-safari-${secret.href}`);
});

test("only a carriable #/route is put back; anything else is dropped, never applied", () => {
  for (const bad of ["javascript:alert(1)", "#notaroute", "%23%2F evil", "https://elsewhere.example/", "#/signup?gt=x"]) {
    let replaced = "";
    restoreEscapedRoute({ href: `https://woco.eth.limo/?${ESCAPE_ROUTE_PARAM}=${encodeURIComponent(bad)}` }, (u) => (replaced = u));
    assert.equal(replaced, "https://woco.eth.limo/", bad);
  }
});

test("a page without the parameter is left alone", () => {
  let called = false;
  restoreEscapedRoute({ href: "https://woco.eth.limo/#/creator" }, () => (called = true));
  assert.equal(called, false);
});

// --- wiring ------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the router restores the route BEFORE its first read of the hash", () => {
  const router = read("../src/lib/router/router.svelte.ts");
  const restore = router.indexOf("restoreEscapedRoute(window.location,");
  const first = router.indexOf("  update();\n}", restore);
  assert.ok(restore > 0 && first > restore);
});

test("the sign-in sheet shows the way out above every sign-in option, loaded only when needed", () => {
  const modal = read("../src/lib/components/auth/LoginModal.svelte");
  const notice = modal.indexOf('{#await import("./InAppBrowserNotice.svelte")');
  const passkey = modal.indexOf("<PasskeyLogin", notice);
  assert.ok(notice > 0 && passkey > notice);
  assert.ok(!/^\s*import InAppBrowserNotice/m.test(modal), "never in the eager bundle");
  assert.ok(!/^\s*import \{[^}]*\} from "\.\.\/\.\.\/browser\/in-app-browser\.js"/m.test(modal), "detection is loaded, not imported");
  assert.ok(modal.includes('void import("../../browser/in-app-browser.js")'));
});

test("only the small route carrier is eager; detection and the link builder are not", () => {
  const route = read("../src/lib/browser/in-app-route.ts");
  assert.ok(!/from "\.\/in-app-(?:browser|escape)\.js"/.test(route.replace(/import type[^;]+;/g, "")));
  const router = read("../src/lib/router/router.svelte.ts");
  assert.ok(router.includes('import { restoreEscapedRoute } from "../browser/in-app-route.js";'));
  assert.ok(!router.includes("in-app-browser.js") && !router.includes("in-app-escape.js"));
});
