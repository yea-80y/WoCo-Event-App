/**
 * The passkey sign-in window (src/auth-window/): ONE self-contained file, its script and
 * style inlined and pinned by hash in a meta CSP, plus a scriptless 404 page as the
 * collection's error document - without one, an unknown path on the passkey host would
 * be answered with whatever the gateway falls back to (the app, once, on app.woco.eth.limo).
 *
 * `connect-src 'none'` and `default-src 'none'` make "the keys go nowhere but the
 * opener" structural: no request, no storage-backed worker, no other script can run.
 *
 * PRODUCTION IS THE DEFAULT OUTPUT. The dev window (`--mode dev-window`) is the only
 * other target and builds into its own directory, so the upload script never sees it;
 * `authWindowProblems` refuses a production artifact carrying anything else.
 */
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { PASSKEY_DEV_APP_ORIGIN, PASSKEY_DEV_WINDOW_ORIGIN, PASSKEY_WINDOW_ORIGIN, WOCO_APP_ORIGIN } from "@woco/shared/auth/passkey-rp";
import { escapeInlineScript } from "./ticket-page";

export interface AuthWindowTarget {
  selfOrigin: string;
  rpId: string;
  openers: readonly string[];
  outDir: string;
}

export const AUTH_WINDOW_PRODUCTION: AuthWindowTarget = {
  selfOrigin: PASSKEY_WINDOW_ORIGIN,
  rpId: new URL(PASSKEY_WINDOW_ORIGIN).hostname,
  openers: [WOCO_APP_ORIGIN],
  outDir: "dist-auth",
};

export const AUTH_WINDOW_DEV: AuthWindowTarget = {
  selfOrigin: PASSKEY_DEV_WINDOW_ORIGIN,
  rpId: new URL(PASSKEY_DEV_WINDOW_ORIGIN).hostname,
  openers: [PASSKEY_DEV_APP_ORIGIN],
  outDir: "dist-auth-dev",
};

/** From the Vite command's mode only - never from .env, which a worktree does not have. */
export function authWindowTarget(mode: string): AuthWindowTarget {
  return mode === "dev-window" ? AUTH_WINDOW_DEV : AUTH_WINDOW_PRODUCTION;
}

export const sha256Base64 = (text: string) => createHash("sha256").update(text, "utf8").digest("base64");

const STYLE = `
:root { --bg: #0B0B09; --card: #14140F; --line: #2B2A23; --text: #F2EBE0; --muted: #8A8478; --accent: #C7F23A; --accent-text: #0B0B09; }
@media (prefers-color-scheme: light) { :root { --bg: #F4F1EA; --card: #FFFFFF; --line: #DDD8CC; --text: #16150F; --muted: #5F5A4F; --accent: #16150F; --accent-text: #F4F1EA; } }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
[hidden] { display: none !important; }
main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 28px 24px; text-align: center; }
.brand { font: 700 11px/1 ui-monospace, Menlo, monospace; letter-spacing: .4em; color: var(--accent); margin: 0 0 20px; }
h1 { font-size: 20px; line-height: 1.3; margin: 0 0 8px; }
p { margin: 0 0 20px; color: var(--muted); overflow-wrap: anywhere; }
#asker { color: var(--text); font-weight: 600; }
button { font: inherit; font-weight: 600; width: 100%; padding: 14px; border-radius: 6px; cursor: pointer; }
#go { border: 0; background: var(--accent); color: var(--accent-text); }
#go:disabled { opacity: .5; cursor: default; }
#cancel { margin-top: 8px; border: 1px solid var(--line); background: none; color: var(--muted); }
.note { margin: 20px 0 0; font-size: 12px; }
#home { display: block; padding: 14px; border-radius: 6px; background: var(--accent); color: var(--accent-text); font-weight: 600; text-decoration: none; }
`;

export function authWindowCsp(scriptHash: string, styleHash: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    `style-src 'sha256-${styleHash}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "connect-src 'none'",
    // WebRTC is not governed by connect-src; ignored where the directive is not known.
    "webrtc 'block'",
  ].join("; ");
}

/** The page's one link: to the app, for a window nothing opened (window.ts). Static in the
 *  HTML, never built or pointed by the script (`DENIED`, `authWindowProblems`). */
export const authWindowHome = (target: AuthWindowTarget) => `${target.openers[0]}/`;
const homeLink = (target: AuthWindowTarget) => `<a id="home" href="${authWindowHome(target)}" hidden>`;

export function authWindowHtml(code: string, target: AuthWindowTarget): string {
  const script = escapeInlineScript(code);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${authWindowCsp(sha256Base64(script), sha256Base64(STYLE))}" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<meta name="referrer" content="no-referrer" />
<title>Sign in to WoCo</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <p class="brand">WOCO</p>
  <h1 id="title">Sign in to WoCo</h1>
  <p><span id="asker"></span><span id="line">Connecting to WoCo...</span></p>
  <button type="button" id="go" hidden>Continue</button>
  <button type="button" id="cancel" hidden>Cancel</button>
  ${homeLink(target)}Go to WoCo</a>
  <p class="note" id="note">Your passkey stays on your device.</p>
  <noscript><p>Turn on JavaScript to sign in.</p></noscript>
</main>
<script>${script}</script>
</body>
</html>
`;
}

export function notFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${sha256Base64(STYLE)}'; base-uri 'none'; form-action 'none'" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>Not found - WoCo</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <p class="brand">WOCO</p>
  <h1>Nothing here</h1>
  <p>This address only signs you in to WoCo, from the WoCo app.</p>
</main>
</body>
</html>
`;
}

/**
 * What a script on the passkey host must never do or name (Fable 10-21 §5), checked on
 * the built bytes. Each one is a channel for keys to leave other than `postMessage` to
 * the opener, or a way for other code to run there.
 */
const DENIED: Array<[string, RegExp]> = [
  ["a <base> element", /<base\b/i],
  ["fetch()", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["sendBeacon", /sendBeacon/],
  ["WebSocket", /WebSocket/],
  ["localStorage", /localStorage/],
  ["sessionStorage", /sessionStorage/],
  ["indexedDB", /indexedDB/],
  ["a service worker", /serviceWorker/],
  ["cookies", /document\.cookie/],
  ["the URL fragment", /location\.hash/],
  ["window.name", /window\.name/],
  ["BroadcastChannel", /BroadcastChannel/],
  ["WebRTC", /RTCPeerConnection|RTCDataChannel/],
  ["window.open()", /\bopen\s*\(\s*["'`]|window\.open\b/],
  ["a navigation", /location\.(href|assign|replace|search|pathname)\b|location\s*=[^=]/],
  ["the history API", /history\.(pushState|replaceState)/],
  ["the opener's location", /opener\.location/],
  ["a form or link it builds", /createElement\(\s*["'`](a|form|iframe|img|script|link)["'`]/],
  ["a link it points", /\.href\s*=[^=]|setAttribute\s*\(\s*["'`](href|src|action)["'`]/],
  ["dynamic import()", /\bimport\s*\(/],
  ["eval / Function", /\beval\s*\(|new Function\s*\(/],
  ["a wildcard postMessage target", /["'`]\*["'`]/],
  ["the Vite dev client", /@vite\/client/],
  ["import.meta", /import\.meta/],
];

/** Why `html` is not a sign-in window for `target`, or [] when it is. Pure. */
export function authWindowProblems(html: string, target: AuthWindowTarget): string[] {
  const problems: string[] = [];
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)?.[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
  if (!script || !style || !csp) return ["the page has no inline script, style or CSP"];
  if ((html.match(/<script\b/g) ?? []).length !== 1) problems.push("more than one script element");
  if (csp !== authWindowCsp(sha256Base64(script), sha256Base64(style))) problems.push("the CSP does not pin exactly this script and style");
  for (const [what, re] of DENIED) if (re.test(script)) problems.push(`the script uses ${what}`);
  const links = html.replace(script, "").match(/<a\b[^>]*>/g) ?? [];
  if (links.length !== 1 || links[0] !== homeLink(target)) problems.push(`the page does not carry exactly one link, hidden, to ${authWindowHome(target)}`);
  const literal = (v: unknown) => JSON.stringify(v);
  if (!script.includes(literal(target.selfOrigin))) problems.push(`the script does not name its origin ${target.selfOrigin}`);
  if (!script.includes(literal(target.rpId))) problems.push(`the script does not name its RP ID ${target.rpId}`);
  if (!script.includes(literal(target.openers))) problems.push(`the script does not name exactly the openers ${literal(target.openers)}`);
  if (target === AUTH_WINDOW_PRODUCTION && /localhost|127\.0\.0\.1/.test(html)) problems.push("a production window names localhost");
  return problems;
}

/** Emits index.html + 404.html from the window's IIFE, drops the JS chunk, and fails
 *  the build if the page breaks any rule above. */
export function authWindowPlugin(target: AuthWindowTarget): Plugin {
  return {
    name: "woco-auth-window",
    generateBundle(_options, bundle) {
      const entry = Object.entries(bundle).find(([, c]) => c.type === "chunk" && c.isEntry);
      if (!entry || entry[1].type !== "chunk") {
        this.error("the sign-in window build produced no entry chunk");
        return;
      }
      const [fileName, chunk] = entry;
      for (const name of Object.keys(bundle)) if (name !== fileName && bundle[name]!.type === "chunk") this.error(`the sign-in window split into a second chunk (${name})`);
      delete bundle[fileName];
      const html = authWindowHtml(chunk.code, target);
      const problems = authWindowProblems(html, target);
      if (problems.length) this.error(`the sign-in window breaks its rules: ${problems.join("; ")}`);
      this.emitFile({ type: "asset", fileName: "index.html", source: html });
      this.emitFile({ type: "asset", fileName: "404.html", source: notFoundHtml() });
    },
  };
}
