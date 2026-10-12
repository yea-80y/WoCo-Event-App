/**
 * Web3Auth REDIRECT-mode sign-in on iPhone and iPad (owner decision 2026-10-12).
 *
 * Why: in pop-up mode the email code is typed in a second Safari tab while the
 * person reads it in Mail; iOS suspends WoCo's tab, and the hidden auth frame in
 * it that has to receive the result fails (`W3A-connect-WalletLoginError.5111`,
 * two iPhones, v10 and v11). In redirect mode the same tab goes to Web3Auth and
 * comes back with the result in its URL; the SDK finishes it on load
 * (`@web3auth/auth` `Auth.init` -> `getHashQueryParams`, no-modal
 * `authConnector.init` -> `connect()` when `uxMode === REDIRECT`). Desktop and
 * Android keep the pop-up (+ #843's wait). Nothing here is a key input: the mode
 * is transport, and `web3auth-key-inputs.test.ts` pins both option sets whole.
 *
 * This module is EAGER (the router runs `installWeb3AuthRedirectCapture` before
 * its first read of the hash), so it imports nothing and stays small.
 *
 * The return is trusted as THIS tab's explicit sign-in only with the per-tab
 * marker written right before the navigation (sessionStorage: a link opened in a
 * new tab, or by anyone else, has none). Without it the result is stripped from
 * the URL before any SDK instance can read it - on every platform, since
 * `Auth.init` consumes a result in ANY mode (a crafted link was a login-CSRF
 * nuisance before this, bounded by #182/#183).
 */

import { AUTH_NOTICE_KEY } from "./auth-notice.js";

export type Web3AuthUxMode = "popup" | "redirect";

/** The page facts the mode is chosen from. */
export type UxModeEnv = {
  userAgent: string;
  maxTouchPoints: number;
  /** A home-screen app (`display-mode: standalone` / `navigator.standalone`). */
  standalone: boolean;
};

/**
 * Redirect on an iPhone or iPad (iPadOS Safari reports a desktop Mac, so a
 * Mac user agent with a touch screen is an iPad). Every iOS browser is WebKit, so
 * Chrome or Firefox there gets it too. NOT in a home-screen app: a cross-origin
 * navigation from one opens iOS's in-app sheet and the return can land outside
 * the app, with no marker - the pop-up stays there (reviewer MUST, 2026-10-12).
 */
export function web3AuthUxModeFor(env: UxModeEnv): Web3AuthUxMode {
  if (env.standalone) return "popup";
  const ua = env.userAgent;
  // Every other iOS device's user agent says "CPU iPhone OS".
  const ios = /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  return ios ? "redirect" : "popup";
}

/** This page's mode. */
export function browserWeb3AuthUxMode(): Web3AuthUxMode {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "popup";
  let standalone = (navigator as { standalone?: boolean }).standalone === true;
  try {
    standalone ||= window.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    /* no matchMedia: treat as a browser tab */
  }
  return web3AuthUxModeFor({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone });
}

// --- the per-tab marker ---------------------------------------------------------

export const REDIRECT_MARKER_KEY = "woco:w3a-redirect";
/** Clocked from the click, before the email is even typed: the same ceiling as a
 *  pop-up sign-in's wait (web3auth-signin-wait.ts, 15 min). The SDK keeps a
 *  result for 600 s from the moment Web3Auth publishes it. */
export const REDIRECT_MARKER_TTL_MS = 15 * 60_000;

type Marker = { v: 1; at: number; route: string };

/** Only an app route is carried back (`#/...`); anything else returns home. */
function routeOf(hash: string): string {
  return hash.startsWith("#/") ? hash : "#/";
}

/** Written right before `connect()` on a redirect-mode instance. */
export function writeRedirectMarker(storage: Pick<Storage, "setItem">, hash: string, now: number): void {
  const marker: Marker = { v: 1, at: now, route: routeOf(hash) };
  storage.setItem(REDIRECT_MARKER_KEY, JSON.stringify(marker));
}

export function clearRedirectMarker(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(REDIRECT_MARKER_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The marker if it is this shape and fresh; anything else reads as none. */
function readMarker(storage: Pick<Storage, "getItem">, now: number): Marker | null {
  let raw: string | null;
  try {
    raw = storage.getItem(REDIRECT_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<Marker>;
    if (m.v !== 1 || typeof m.at !== "number" || typeof m.route !== "string") return null;
    if (now < m.at || now - m.at > REDIRECT_MARKER_TTL_MS) return null;
    return { v: 1, at: m.at, route: routeOf(m.route) };
  } catch {
    return null;
  }
}

// --- the result in the URL ------------------------------------------------------

/**
 * Every parameter a Web3Auth redirect result can carry (`Auth.init`): the keys
 * that mark one, and the rest it brings along. All of them are removed from the
 * address bar - `sessionId`, the tokens and `loginParams` (it holds the email as
 * `login_hint`) would otherwise stay in it and in history, because the SDK's own
 * clean-up deletes only `error`, `state`, `b64Params` and `sessionNamespace`.
 */
const MARKING_KEYS = ["b64Params", "sessionId", "nonce", "error"] as const;
const RESULT_KEYS = new Set<string>([
  ...MARKING_KEYS,
  "accessToken",
  "refreshToken",
  "idToken",
  "loginParams",
  "state",
  "sessionNamespace",
  "appState",
]);

export type RedirectResult = {
  /** Plain keys and the decoded `b64Params`, merged the way `getHashQueryParams` merges them. */
  params: Record<string, string>;
  /** Key NAMES only, for the failure code (`r.sid`, `r.nonce`, ...): never a value. */
  notes: string[];
};

function base64UrlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function utf8ToBase64Url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read the result from one part of the URL; `null` when it has none. */
function resultIn(part: URLSearchParams): RedirectResult | null {
  if (!MARKING_KEYS.some((k) => part.has(k))) return null;
  const params: Record<string, string> = {};
  const notes: string[] = [];
  part.forEach((value, key) => {
    if (RESULT_KEYS.has(key) && key !== "b64Params") params[key] = value;
  });
  const b64 = part.get("b64Params");
  if (b64 !== null) {
    notes.push("r.b64");
    try {
      const decoded = JSON.parse(base64UrlToUtf8(b64)) as unknown;
      if (typeof decoded !== "object" || decoded === null) throw new Error("not an object");
      for (const [k, v] of Object.entries(decoded)) {
        if (typeof v === "string") params[k] = v;
      }
    } catch {
      notes.push("r.bad");
    }
  }
  if ("sessionId" in params) notes.push("r.sid");
  if ("nonce" in params) notes.push("r.nonce");
  if ("sessionNamespace" in params && params.sessionNamespace) notes.push("r.ns");
  if ("error" in params) notes.push("r.err");
  return { params, notes };
}

/** The app's hash route, or a Web3Auth result written in the fragment. */
function hashParams(hash: string): URLSearchParams | null {
  if (!hash || hash === "#" || hash.startsWith("#/")) return null;
  return new URLSearchParams(hash.slice(1));
}

/** A result in the query or the fragment (the query first, as the SDK merges). */
export function readRedirectResult(search: string, hash: string): RedirectResult | null {
  const q = resultIn(new URLSearchParams(search));
  const h = hashParams(hash);
  const fromHash = h ? resultIn(h) : null;
  if (!q && !fromHash) return null;
  return {
    params: { ...(q?.params ?? {}), ...(fromHash?.params ?? {}) },
    notes: [...new Set([...(q?.notes ?? []), ...(fromHash?.notes ?? [])])],
  };
}

/** `search` without any result parameter (the app's own, e.g. #812's, are kept). */
function searchWithoutResult(search: string): string {
  const p = new URLSearchParams(search);
  for (const k of [...p.keys()]) if (RESULT_KEYS.has(k)) p.delete(k);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export type PendingRedirect = RedirectResult & {
  /** The `#/route` the sign-in started from. */
  route: string;
};

export type CaptureOutcome =
  /** No result in the URL. */
  | { kind: "none" }
  /** This tab's own return: finished by `auth.init()`. */
  | { kind: "finish"; pending: PendingRedirect; url: string }
  /** A result without this tab's fresh marker: stripped, never finished. */
  | { kind: "stray"; url: string };

/**
 * What the boot does with the URL it was loaded at. Pure: the caller replaces the
 * URL with `url`. A finish moves the person straight to the route they started
 * from - the result is held in memory, out of the address bar - so the hash
 * router never sees the result and paints the right screen first.
 */
export function captureRedirectReturn(
  loc: { pathname: string; search: string; hash: string },
  storage: Pick<Storage, "getItem" | "removeItem">,
  now: number,
): CaptureOutcome {
  const result = readRedirectResult(loc.search, loc.hash);
  if (!result) return { kind: "none" };
  const marker = readMarker(storage, now);
  // Single use: a second load of the same URL (reload, Back) finds no marker.
  clearRedirectMarker(storage);
  const search = searchWithoutResult(loc.search);
  // A result written in the fragment replaced the route; a route that is still
  // there (the result came in the query) is kept.
  const keptHash = loc.hash.startsWith("#/") ? loc.hash : "";
  if (!marker) return { kind: "stray", url: `${loc.pathname}${search}${keptHash || "#/"}` };
  const route = keptHash || marker.route;
  return { kind: "finish", pending: { ...result, route }, url: `${loc.pathname}${search}${route}` };
}

/**
 * The URL the finishing SDK instance is built at: the result re-encoded as ONE
 * `#b64Params=` (which the SDK deletes after reading it). In the FRAGMENT, where
 * Web3Auth itself delivers it: a fragment is never sent anywhere, while a query
 * rides out as the `Referer` of every request the build makes (the SDK chunk's
 * own download included) - and this one holds the session tokens and the email
 * (`loginParams.login_hint`). The route is put back right after the build.
 */
export function urlForFinish(pathname: string, search: string, pending: PendingRedirect): string {
  return `${pathname}${searchWithoutResult(search)}#b64Params=${utf8ToBase64Url(JSON.stringify(pending.params))}`;
}

/** The clean URL after a finish, success or not: no result, the route. */
export function urlAfterFinish(pathname: string, search: string, route: string): string {
  return `${pathname}${searchWithoutResult(search)}${route}`;
}

// --- the boot hand-off ----------------------------------------------------------

let _pending: PendingRedirect | null = null;
let _stray = false;

export const STRAY_REDIRECT_NOTICE =
  "That sign-in didn't come back to this tab, or took too long - please sign in again.";

/**
 * Run once by the router before it first reads the hash. Holds a trusted return
 * for `auth.init()` (`takePendingWeb3AuthRedirect`), strips anything else.
 */
export function installWeb3AuthRedirectCapture(
  win: { location: Pick<Location, "href" | "pathname" | "search" | "hash">; history: Pick<History, "replaceState" | "state">; sessionStorage?: Storage },
  now: number = Date.now(),
): CaptureOutcome {
  let storage: Pick<Storage, "getItem" | "removeItem" | "setItem">;
  try {
    storage = win.sessionStorage ?? nullStorage;
  } catch {
    storage = nullStorage;
  }
  const outcome = captureRedirectReturn(win.location, storage, now);
  if (outcome.kind === "none") return outcome;
  // Resolved against the page's own URL, never the deploy's <base href> (#604).
  win.history.replaceState(win.history.state, "", new URL(outcome.url, win.location.href).href);
  if (outcome.kind === "finish") _pending = outcome.pending;
  else {
    _stray = true;
    console.warn("[auth] a Web3Auth sign-in result reached this tab without its marker - not used");
    try {
      storage.setItem(AUTH_NOTICE_KEY, STRAY_REDIRECT_NOTICE);
    } catch {
      /* the notice is an explanation, never a step */
    }
  }
  return outcome;
}

const nullStorage = { getItem: () => null, removeItem: () => {}, setItem: () => {} };

/** The return the boot captured, once. */
export function takePendingWeb3AuthRedirect(): PendingRedirect | null {
  const p = _pending;
  _pending = null;
  return p;
}

/** A stripped return, once: the login sheet opens on its notice. */
export function takeStrayWeb3AuthRedirect(): boolean {
  const s = _stray;
  _stray = false;
  return s;
}

/** Test seam. */
export function setPendingWeb3AuthRedirectForTests(p: PendingRedirect | null): void {
  _pending = p;
}
