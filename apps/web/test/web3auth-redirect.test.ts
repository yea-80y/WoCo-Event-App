/**
 * Web3Auth redirect mode on iPhone/iPad (web3auth-redirect.ts): which devices get
 * it, what the boot does with a URL that carries a result, and that the URL the
 * finish builds at is read by the SDK's OWN parser exactly as intended. The SDK
 * facts the design rests on are pinned from the installed source, so an upgrade
 * that moves one fails here first.
 *
 * MUTATIONS (each went red, then restored): the iOS switch defaulting on;
 * standalone check dropped; iPad touch
 * check dropped; marker TTL check dropped; marker not consumed; a stray result
 * kept in the URL; result keys left in the query; hash-route guard dropped (an
 * app route read as a result); b64Params re-encoded as plain base64; the finish
 * result put back in the query.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  web3AuthUxModeFor,
  IOS_REDIRECT_SIGN_IN,
  writeRedirectMarker,
  captureRedirectReturn,
  readRedirectResult,
  urlForFinish,
  urlAfterFinish,
  installWeb3AuthRedirectCapture,
  takePendingWeb3AuthRedirect,
  takeStrayWeb3AuthRedirect,
  REDIRECT_MARKER_KEY,
  REDIRECT_MARKER_TTL_MS,
  STRAY_REDIRECT_NOTICE,
} = await import("../src/lib/auth/web3auth-redirect.ts");
const { AUTH_NOTICE_KEY } = await import("../src/lib/auth/auth-notice.ts");

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

test("mode: the pop-up everywhere while the iOS redirect switch is off (owner 2026-10-12) - iPhones included", () => {
  assert.equal(IOS_REDIRECT_SIGN_IN, false, "the switch is off");
  const m = (userAgent: string, maxTouchPoints = 0, standalone = false) =>
    web3AuthUxModeFor({ userAgent, maxTouchPoints, standalone });
  for (const [ua, touch] of [[IPHONE_SAFARI, 5], [IPHONE_CHROME, 5], [MAC_SAFARI, 5], [MAC_SAFARI, 0], [ANDROID_CHROME, 5]] as const) {
    assert.equal(m(ua, touch), "popup", ua);
  }
});

test("mode with the switch ON: redirect on iPhone (any iOS browser) and iPad-as-Mac; pop-up on desktop, Android and home-screen apps", () => {
  const m = (userAgent: string, maxTouchPoints = 0, standalone = false) =>
    web3AuthUxModeFor({ userAgent, maxTouchPoints, standalone }, true);
  assert.equal(m(IPHONE_SAFARI, 5), "redirect");
  assert.equal(m(IPHONE_CHROME, 5), "redirect", "every iOS browser is WebKit");
  assert.equal(m(MAC_SAFARI, 5), "redirect", "iPadOS Safari reports a Mac; touch says iPad");
  assert.equal(m(MAC_SAFARI, 0), "popup", "a real Mac keeps the pop-up");
  assert.equal(m(ANDROID_CHROME, 5), "popup");
  assert.equal(m(IPHONE_SAFARI, 5, true), "popup", "a home-screen app's navigation leaves the app");
});

/** sessionStorage, in memory. */
function tab(entries: Record<string, string> = {}) {
  const m = new Map(Object.entries(entries));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const NOW = 1_800_000_000_000;

test("marker: the route a sign-in starts from, never anything but an app route", () => {
  const s = tab();
  writeRedirectMarker(s, "#/event/abc?x=1", NOW);
  assert.deepEqual(JSON.parse(s.map.get(REDIRECT_MARKER_KEY)!), { v: 1, at: NOW, route: "#/event/abc?x=1" });
  writeRedirectMarker(s, "#b64Params=zzz", NOW);
  assert.equal(JSON.parse(s.map.get(REDIRECT_MARKER_KEY)!).route, "#/");
});

test("capture: this tab's return is held, its marker spent, and the URL goes straight to the route", () => {
  const s = tab();
  writeRedirectMarker(s, "#/event/abc", NOW);
  const result = { sessionId: "aa".repeat(32), sessionNamespace: "" };
  const out = captureRedirectReturn(
    { pathname: "/bzz/feed/", search: "", hash: `#b64Params=${b64url(result)}` },
    s,
    NOW + 60_000,
  );
  assert.equal(out.kind, "finish");
  if (out.kind !== "finish") return;
  assert.equal(out.url, "/bzz/feed/#/event/abc", "no result left in the address bar");
  assert.deepEqual(out.pending.params, result);
  assert.deepEqual(out.pending.notes, ["r.b64", "r.sid"]);
  assert.equal(out.pending.route, "#/event/abc");
  assert.equal(s.map.has(REDIRECT_MARKER_KEY), false, "single use: a reload of this URL finds no marker");
});

test("capture: plain result keys in the query are all removed, the app's own query and route kept", () => {
  const s = tab();
  writeRedirectMarker(s, "#/tickets", NOW);
  const out = captureRedirectReturn(
    {
      pathname: "/",
      search: "?woco-escape=1&nonce=n1&loginParams=%7B%22login_hint%22%3A%22a%40b.c%22%7D&accessToken=t&state=s",
      hash: "#/tickets",
    },
    s,
    NOW,
  );
  assert.equal(out.kind, "finish");
  if (out.kind !== "finish") return;
  assert.equal(out.url, "/?woco-escape=1#/tickets", "the email (login_hint) and the token never stay in the URL");
  assert.deepEqual(out.pending.notes, ["r.nonce", "r.lp"], "loginParams present, as a string - its value never in a note");
});

test("capture: no marker, a stale one, or another shape = stray - stripped, never finished", () => {
  const hash = `#b64Params=${b64url({ sessionId: "bb" })}`;
  const loc = { pathname: "/", search: "", hash };
  assert.deepEqual(captureRedirectReturn(loc, tab(), NOW), { kind: "stray", url: "/#/" });
  const old = tab();
  writeRedirectMarker(old, "#/event/x", NOW - REDIRECT_MARKER_TTL_MS - 1);
  assert.equal(captureRedirectReturn(loc, old, NOW).kind, "stray", "older than the SDK keeps a result");
  const future = tab();
  writeRedirectMarker(future, "#/event/x", NOW + 1);
  assert.equal(captureRedirectReturn(loc, future, NOW).kind, "stray");
  assert.equal(captureRedirectReturn(loc, tab({ [REDIRECT_MARKER_KEY]: "{not json" }), NOW).kind, "stray");
});

test("capture: an app route is never read as a result, whatever its own query says", () => {
  const s = tab();
  writeRedirectMarker(s, "#/x", NOW);
  for (const hash of ["", "#", "#/", "#/event/x?error=1&nonce=2", "#/signup?gt=tok"]) {
    assert.equal(readRedirectResult("", hash), null, hash);
    assert.deepEqual(captureRedirectReturn({ pathname: "/", search: "", hash }, s, NOW), { kind: "none" });
  }
  assert.ok(s.map.has(REDIRECT_MARKER_KEY), "an ordinary load leaves a pending sign-in's marker alone");
  assert.equal(readRedirectResult("?woco-open=%23%2Ftickets", ""), null);
});

test("capture: loginParams that came as something other than a string is named by its type only", () => {
  const b = (o: unknown) => `#b64Params=${Buffer.from(JSON.stringify(o)).toString("base64url")}`;
  assert.deepEqual(readRedirectResult("", b({ nonce: "n", loginParams: { login_hint: "a@b.c" } }))?.notes, ["r.b64", "r.nonce", "r.lp-object"]);
  assert.deepEqual(readRedirectResult("", b({ nonce: "n", loginParams: null }))?.notes, ["r.b64", "r.nonce", "r.lp-null"]);
  assert.deepEqual(readRedirectResult("", b({ nonce: "n" }))?.notes, ["r.b64", "r.nonce"]);
});

test("capture: an error result and an unreadable b64Params are carried as notes", () => {
  assert.deepEqual(readRedirectResult("", "#error=user_cancelled&state=s")?.notes, ["r.err"]);
  assert.deepEqual(readRedirectResult("?b64Params=%%%", "")?.notes, ["r.b64", "r.bad"]);
});

test("the finish URL is read by the SDK's OWN parser as the result, and its clean-up removes it", async () => {
  const { getHashQueryParams } = await import("@web3auth/auth");
  const pending = {
    params: { nonce: "n-1", loginParams: JSON.stringify({ login_hint: "a@b.c" }), sessionNamespace: "sapphire", "é": "ü", tilde: "~~~???>>>~~" },
    notes: [],
    route: "#/event/abc",
  };
  const url = urlForFinish("/bzz/feed/", "?woco-escape=1", pending);
  const parsed = new URL(url, "https://x");
  assert.equal(parsed.search, "?woco-escape=1", "the result is never in the query (a query rides out as Referer)");
  const encoded = new URLSearchParams(parsed.hash.slice(1)).get("b64Params")!;
  assert.ok(Buffer.from(JSON.stringify(pending.params)).toString("base64").match(/[+/]/), "the data does exercise + and /");
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "base64url: nothing a query would rewrite");
  let replaced = "";
  const u = new URL(url, "https://woco.eth.limo");
  (globalThis as Record<string, unknown>).window = {
    location: { search: u.search, hash: u.hash, origin: u.origin, pathname: u.pathname },
    history: { state: null, replaceState: (_s: unknown, _t: string, href: string) => (replaced = href) },
  };
  try {
    const params = getHashQueryParams(true);
    for (const [k, v] of Object.entries(pending.params)) assert.equal(params[k], v, k);
    const cleaned = new URL(replaced);
    assert.equal(cleaned.hash, "", "the SDK deletes what it read");
    assert.equal(cleaned.searchParams.get("woco-escape"), "1");
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
  assert.equal(urlAfterFinish("/bzz/feed/", "?woco-escape=1&b64Params=x", "#/event/abc"), "/bzz/feed/?woco-escape=1#/event/abc");
});

test("install: replaces the URL once, hands the return to auth.init once, and a stray opens the sheet on a notice", () => {
  const s = tab();
  writeRedirectMarker(s, "#/creator", NOW);
  const urls: string[] = [];
  const win = (hash: string, storage: ReturnType<typeof tab>) => ({
    location: { href: `https://gateway.woco-net.com/${hash}`, pathname: "/", search: "", hash },
    history: { state: null, replaceState: (_s: unknown, _t: string, u?: string | URL | null) => void urls.push(String(u)) },
    sessionStorage: storage as unknown as Storage,
  });
  installWeb3AuthRedirectCapture(win(`#b64Params=${b64url({ sessionId: "cc" })}`, s), NOW);
  assert.deepEqual(urls, ["https://gateway.woco-net.com/#/creator"], "absolute, from the page's own URL (#604)");
  assert.equal(takePendingWeb3AuthRedirect()?.route, "#/creator");
  assert.equal(takePendingWeb3AuthRedirect(), null, "once");
  assert.equal(takeStrayWeb3AuthRedirect(), false);

  const t = tab();
  installWeb3AuthRedirectCapture(win(`#b64Params=${b64url({ sessionId: "cc" })}`, t), NOW);
  assert.equal(takePendingWeb3AuthRedirect(), null);
  assert.equal(takeStrayWeb3AuthRedirect(), true);
  assert.equal(t.map.get(AUTH_NOTICE_KEY), STRAY_REDIRECT_NOTICE);
  assert.ok(!STRAY_REDIRECT_NOTICE.includes("—"), "copy uses ' - ', never an em dash");
});

// --- the SDK facts this design rests on (installed @web3auth/* source) ----------

const src = (rel: string) => readFileSync(new URL(`../node_modules/${rel}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

test("SDK: the default email/Google path navigates THIS tab in redirect mode, and a redirect-mode init connects a result", () => {
  const c = flat(src("@web3auth/no-modal/dist/lib.esm/connectors/auth-connector/authConnector.js"));
  assert.match(c, /if \(this\.authOptions\.uxMode === UX_MODE\.REDIRECT\) return verifierWindow\.redirect\(this\.authOptions\.replaceUrlOnRedirect\);/);
  assert.match(c, /const isRedirectResult = this\.authOptions\.uxMode === UX_MODE\.REDIRECT;/);
  assert.match(c, /replaceUrlOnRedirect: isRedirectResult,/);
  assert.match(c, /if \(sessionId && \(options\.autoConnect \|\| isRedirectResult\)\) \{ this\.rehydrated = true; await this\.connect\(/);
  assert.match(c, /if \(\(_coreOptions\$uiConfig = coreOptions\.uiConfig\) !== null && _coreOptions\$uiConfig !== void 0 && _coreOptions\$uiConfig\.uxMode\) connectorSettings\.uxMode = coreOptions\.uiConfig\.uxMode;/);
  const popup = flat(src("@web3auth/auth/dist/lib.esm/core/PopupHandler.js"));
  assert.match(popup, /redirect\(locationReplaceOnRedirect\) \{ if \(locationReplaceOnRedirect\) \{ window\.location\.replace\(this\.url\);/);
});

test("SDK: Auth.init reads the result from the URL (sessionId, nonce, error) and keeps its session under auth_store[_ns]:session_id", () => {
  const a = flat(src("@web3auth/auth/dist/lib.esm/core/auth.js"));
  assert.match(a, /const params = getHashQueryParams\(this\.options\.replaceUrlOnRedirect\);/);
  assert.match(a, /_defineProperty\(this, "_storageBaseKey", "auth_store"\);/);
  assert.match(a, /const storageKey = this\.options\.sessionKey \|\| \(this\.options\.sessionNamespace \? `\$\{this\._storageBaseKey\}_\$\{this\.options\.sessionNamespace\}` : this\._storageBaseKey\);/);
  assert.match(a, /if \(params\.error\) \{ this\.dappState = params\.state; throw LoginError\.loginFailed\(params\.error\); \}/);
  assert.match(a, /if \(params\.sessionId\) \{ await this\.sessionManager\.setTokens\(/);
  assert.match(a, /if \(params\.nonce\) \{ await this\.authProviderPromise; await this\.postLoginInitiatedMessage\(JSON\.parse\(params\.loginParams\), params\.nonce\);/);
  const m = flat(src("@toruslabs/session-manager/dist/lib.esm/auth/AuthSessionManager.js"));
  assert.match(m, /return `\$\{this\.storageKeyPrefix\}:\$\{STORAGE_KEYS\.SESSION_ID\}`;/);
  assert.match(flat(src("@toruslabs/session-manager/dist/lib.esm/auth/types.js")), /SESSION_ID: "session_id"/);
  const u = flat(src("@web3auth/auth/dist/lib.esm/core/utils.js"));
  assert.match(u, /hashUrlParams\.delete\("b64Params"\);/);
});

test("SDK: a result published before the page loaded is fetched on connect (the frame path a nonce result takes)", () => {
  const p = flat(src("@toruslabs/secure-pub-sub/dist/lib.esm/SecurePubSub.js"));
  assert.match(p, /currentSocketConnection\.once\("connect", \(\) => \{ log\.debug\("connected with socket"\); currentSocketConnection\.emit\("v2:check_auth_status", topicPubKey,/);
});

test("SDK: the modal's connect() settles only on CONNECTED, ERRORED or its own close - never while the tab navigates away", () => {
  const m = flat(src("@web3auth/modal/dist/lib.esm/packages/modal/src/modalManager.js"));
  const body = m.slice(m.indexOf("async connect() {"), m.indexOf("async connect() {") + 3000);
  assert.match(body, /return reject\(new Error\("User closed the modal"\)\);/);
  assert.equal(body.match(/resolve\(/g)?.length, 1, "one resolve: on completion (CONNECTED / consent)");
});
