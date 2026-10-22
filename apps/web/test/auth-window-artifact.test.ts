/**
 * The built sign-in window (vite.auth.config.ts): the exact bytes that get uploaded,
 * checked against their rules and then RUN, in a sandbox with a scripted browser, so
 * the claim "keys go only to the opener at the allowed origin, once, and the PRF output
 * never" is tested on the artifact rather than on the source.
 *
 * MUTATIONS (each turns this file red):
 *  - widen __AUTH_OPENERS__ or the production target -> "production names exactly its three settings";
 *  - drop a denied channel from the rules, or add one to the source -> "the rules refuse";
 *  - skip the framing / origin / opener check at load -> "a framed or misplaced window does nothing";
 *  - reply to ev.origin or "*" instead of the literal -> "answers go to the literal origin";
 *  - drop the zeroing after postMessage -> "the window's copies are zeroed";
 *  - accept a second request -> "only the first request is answered";
 *  - show the home link in any state but "nothing opened me", or point it from the script ->
 *    "the one link" / "the rules refuse".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";
import { build } from "vite";
import { acceptPasskeyWindowReply, passkeyAccountKeys, type PasskeyWindowAccountResult } from "@woco/shared";
import {
  AUTH_WINDOW_DEV,
  AUTH_WINDOW_PRODUCTION,
  authWindowHome,
  authWindowHtml,
  authWindowProblems,
  authWindowTarget,
} from "../vite-plugins/auth-window.js";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = "https://woco.eth.limo";
const SELF = "https://auth.woco.eth.limo";

async function buildWindow(mode: string): Promise<{ index: string; notFound: string }> {
  const out = await build({
    configFile: fileURLToPath(new URL("../vite.auth.config.ts", import.meta.url)),
    root: WEB_ROOT,
    mode,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(out) ? out[0] : out) as { output: Array<{ fileName: string; source?: string | Uint8Array }> };
  const file = (name: string) => String(outputs.output.find((o) => o.fileName === name)?.source ?? "");
  return { index: file("index.html"), notFound: file("404.html") };
}

const prod = buildWindow("production");
const dev = buildWindow("dev-window");

test("production names exactly its three settings and passes every rule; the 404 page has no script", async () => {
  const { index, notFound } = await prod;
  assert.deepEqual(AUTH_WINDOW_PRODUCTION, { selfOrigin: SELF, rpId: "auth.woco.eth.limo", openers: [APP], outDir: "dist-auth" });
  assert.deepEqual(authWindowProblems(index, AUTH_WINDOW_PRODUCTION), []);
  assert.match(index, /webrtc 'block'/, "WebRTC is outside connect-src");
  assert.doesNotMatch(notFound, /<script/i);
  assert.match(notFound, /default-src 'none'/);
});

test("the dev window is its own target and can never pass as production", async () => {
  // Production is the default: only the one explicit mode builds anything else.
  for (const mode of ["production", "development", "staging", "", "Dev-Window"]) assert.equal(authWindowTarget(mode), AUTH_WINDOW_PRODUCTION, mode);
  assert.equal(authWindowTarget("dev-window"), AUTH_WINDOW_DEV);
  const { index } = await dev;
  assert.equal(AUTH_WINDOW_DEV.outDir, "dist-auth-dev");
  assert.deepEqual(authWindowProblems(index, AUTH_WINDOW_DEV), []);
  const problems = authWindowProblems(index, AUTH_WINDOW_PRODUCTION);
  assert.ok(problems.some((p) => /localhost/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /openers/.test(p)), problems.join("; "));
});

test("the rules refuse another channel, a second script, or a CSP that does not pin the bytes", async () => {
  const ok = (await prod).index;
  for (const [channel, code] of [
    ["fetch()", "fetch('/x')"],
    ["localStorage", "localStorage.x=1"],
    ["a wildcard postMessage target", 'opener.postMessage(1,"*")'],
    ["window.name", "window.name='x'"],
    ["dynamic import()", "import('x')"],
    ["the URL fragment", "location.hash"],
    ["WebRTC", "new RTCPeerConnection()"],
    ["window.open()", 'window.open("https://x.example")'],
    ["a navigation", 'location.href="https://x.example"'],
    ["a navigation", 'location="https://x.example"'],
    ["the history API", "history.replaceState(null,'','#x')"],
    ["the opener's location", "opener.location.href"],
    ["a form or link it builds", 'document.createElement("form")'],
    ["a link it points", 'document.getElementById("home").href="https://x.example"'],
    ["a link it points", 'e.href = "https://x.example"'],
    ["a link it points", 'e.setAttribute("href","https://x.example")'],
    ["a link it points", 'home.href += "?k=" + k'],
    ["a link it points", 'home.host = "x.example"'],
    ["a link it points", "home.search ??= k"],
    ["markup it builds", 'main.innerHTML = "<a href=x>"'],
    ["markup it builds", 'main.insertAdjacentHTML("beforeend", "<a>")'],
    ["a click it fires", "home.click()"],
  ]) {
    const page = authWindowHtml(`"https://auth.woco.eth.limo";"auth.woco.eth.limo";["https://woco.eth.limo"];${code}`, AUTH_WINDOW_PRODUCTION);
    assert.ok(authWindowProblems(page, AUTH_WINDOW_PRODUCTION).some((p) => p.includes(channel)), channel);
  }
  assert.ok(authWindowProblems(ok.replace("</main>", "<script>1</script></main>"), AUTH_WINDOW_PRODUCTION).length > 0);
  const link = /link, hidden, to https:\/\/woco\.eth\.limo\//;
  assert.equal(authWindowHome(AUTH_WINDOW_PRODUCTION), "https://woco.eth.limo/");
  assert.ok(authWindowProblems(ok.replace("</main>", '<a href="https://x.example">x</a></main>'), AUTH_WINDOW_PRODUCTION).some((p) => link.test(p)), "a second link");
  assert.ok(authWindowProblems(ok.replace('href="https://woco.eth.limo/"', 'href="https://x.example/"'), AUTH_WINDOW_PRODUCTION).some((p) => link.test(p)), "another target");
  assert.ok(authWindowProblems(ok.replace('href="https://woco.eth.limo/" target="_top" hidden>', 'href="https://woco.eth.limo/" target="_top">'), AUTH_WINDOW_PRODUCTION).some((p) => link.test(p)), "shown from the start");
  assert.ok(authWindowProblems(ok.replace(' target="_top" hidden>', " hidden>"), AUTH_WINDOW_PRODUCTION).some((p) => link.test(p)), "never inside a frame");
  // `#home { display: block }` would beat a plain [hidden] rule and show the link in every state.
  assert.match(ok, /\[hidden\] \{ display: none !important; \}/);
  assert.ok(authWindowProblems(ok.replace(/script-src 'sha256-[^']+'/, "script-src 'sha256-AAAA'"), AUTH_WINDOW_PRODUCTION).some((p) => /CSP/.test(p)));
});

test("the upload script refuses a dev window, and names the contenthash the Safe sets", async () => {
  const upload = createRequire(import.meta.url)("../../../scripts/upload-auth-window.cjs") as {
    windowProblems(index: string, notFound: string): Promise<string[]>;
    contenthashFor(ref: string): string;
    buildSource(repo: string, run: (args: string[]) => string): { commit: string; dirty: boolean };
  };
  const p = await prod;
  assert.deepEqual(await upload.windowProblems(p.index, p.notFound), []);
  const d = await upload.windowProblems((await dev).index, p.notFound);
  assert.ok(d.some((x) => /localhost/.test(x)) && d.some((x) => /openers/.test(x)), d.join("; "));
  assert.ok((await upload.windowProblems(p.index.replace(/script-src 'sha256-[^']+'/, "script-src 'sha256-AAAA'"), p.notFound)).length > 0);
  assert.ok((await upload.windowProblems(p.index.replace("script-src 'sha256-", "script-src https://x.example 'sha256-"), p.notFound)).some((x) => /CSP/.test(x)), "an extra script source is refused");
  assert.ok((await upload.windowProblems(p.index, "<script>1</script>")).length > 0, "a scripted 404 is refused");
  const git = (out: Record<string, string>) => (args: string[]) => out[args[0]!]!;
  assert.deepEqual(upload.buildSource("/r", git({ "rev-parse": "abc\n", status: "" })), { commit: "abc", dirty: false });
  assert.deepEqual(upload.buildSource("/r", git({ "rev-parse": "abc\n", status: " M x.ts\n" })), { commit: "abc", dirty: true });
  const ref = "ab".repeat(32);
  assert.equal(upload.contenthashFor(ref), `0xe40101fa011b20${ref}`);
  assert.throws(() => upload.contenthashFor("xyz"));
});

// --- a sandbox browser -------------------------------------------------------

interface Posted {
  raw: any;
  clone: any;
  target: string;
}

function sandbox(html: string, opts: { origin?: string; framed?: boolean; opener?: boolean; credentials: any }) {
  const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)![1]!;
  const els = new Map<string, any>();
  const el = (id: string) => {
    if (!els.has(id)) {
      const listeners: Array<() => void> = [];
      els.set(id, {
        // Hidden as the HTML ships it.
        id, textContent: "", hidden: new RegExp(`id="${id}"[^>]*\\shidden[\\s>]`).test(html), disabled: false, onclick: null as null | (() => void),
        addEventListener: (_t: string, f: () => void) => listeners.push(f), focus() {},
        click() {
          listeners.forEach((f) => f());
          this.onclick?.();
        },
      });
    }
    return els.get(id);
  };
  const posted: Posted[] = [];
  const opener = { postMessage: (raw: any, target: string) => posted.push({ raw, clone: structuredClone(raw), target }) };
  const messageListeners: Array<(ev: any) => void> = [];
  const timers: Array<() => void> = [];
  let closed = false;
  const win: any = {
    opener: opts.opener === false ? null : opener,
    addEventListener: (type: string, f: (ev: any) => void) => type === "message" && messageListeners.push(f),
    close: () => {
      closed = true;
    },
  };
  win.top = opts.framed ? {} : win;
  const context = vm.createContext({
    window: win, document: { getElementById: el }, location: { origin: opts.origin ?? SELF },
    navigator: { credentials: opts.credentials }, crypto: globalThis.crypto, TextEncoder, btoa, atob, URL,
    performance, Date, DOMException, setTimeout: (f: () => void) => timers.push(f),
  });
  vm.runInContext(script, context);
  return {
    opener, posted, el, timers, closed: () => closed,
    send: (data: any, from: { origin?: string; source?: any } = {}) =>
      messageListeners.forEach((f) => f({ origin: from.origin ?? APP, source: from.source ?? opener, data })),
    listening: () => messageListeners.length > 0,
  };
}

const PRF = () => new Uint8Array(32).fill(0xcd);
const RAW_ID = new Uint8Array(20).fill(9);
const assertion = () => ({
  rawId: RAW_ID.slice().buffer,
  authenticatorAttachment: "platform",
  response: { userHandle: null },
  getClientExtensionResults: () => ({ prf: { results: { first: PRF() } } }),
});
const creds = (get: any[] = [], create: any[] = []) => ({ get: async () => get.shift(), create: async () => create.shift() });
const nonce = "N".repeat(22);
const request = (extra: object = {}) => ({ v: 1, type: "request", nonce, action: "signin", ...extra });
/** Until `until` holds, or 10 s: the window's WebCrypto digest runs off the event loop,
 *  so a count of turns is not enough when the whole suite runs at once. */
const settle = async (until: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

test("the window says ready to the allowed opener only, then answers one request with the vectors' keys", async () => {
  const s = sandbox((await prod).index, { credentials: creds([assertion()]) });
  assert.deepEqual(s.posted.map((p) => [p.clone, p.target]), [[{ v: 1, type: "ready" }, APP]]);
  s.send(request());
  assert.equal(s.el("asker").textContent, "woco.eth.limo");
  assert.equal(s.el("go").hidden, false);
  s.el("go").click();
  await settle(() => s.posted.length > 1);
  const answer = s.posted[1]!;
  assert.equal(answer.target, APP, "answers go to the literal origin");
  const heard = acceptPasskeyWindowReply({ origin: SELF, source: "w", data: answer.clone }, { win: "w", windowOrigin: SELF, nonce, action: "signin" });
  assert.equal(heard?.kind, "result");
  const keys = (heard as { result: PasskeyWindowAccountResult }).result.keys;
  const want = passkeyAccountKeys(PRF());
  for (const k of Object.keys(want) as Array<keyof typeof want>) assert.deepEqual([...keys[k]], [...want[k]], k);
  assert.ok(!JSON.stringify(s.posted.map((p) => Object.values(p.clone.result?.keys ?? {}).map((v: any) => [...v]))).includes([...PRF()].join(",")), "the PRF output never crosses");
  assert.ok(Object.values(answer.raw.result.keys).every((v: any) => v.every((b: number) => b === 0)), "the window's copies are zeroed");
  assert.equal(s.closed(), true);
});

test("only the first request is answered, and only from the opener at the allowed origin", async () => {
  const s = sandbox((await prod).index, { credentials: creds([assertion(), assertion()]) });
  s.send(request(), { origin: "https://evil.woco.eth.limo" });
  s.send(request(), { source: { someone: "else" } });
  assert.equal(s.el("go").hidden, true, "nothing accepted");
  s.send(request());
  s.send(request({ nonce: "M".repeat(22) }));
  s.el("go").click();
  await settle(() => s.posted.length > 1);
  await settle(() => s.posted.length > 2, 300);
  assert.equal(s.posted.length, 2);
  assert.equal(s.posted[1]!.clone.nonce, nonce);
});

test("a framed or misplaced window does nothing at all", async () => {
  const html = (await prod).index;
  for (const opts of [{ framed: true }, { origin: "https://woco.eth.limo" }, { origin: "https://gateway.woco-net.com" }, { opener: false }]) {
    const s = sandbox(html, { ...opts, credentials: creds() });
    assert.equal(s.posted.length, 0, JSON.stringify(opts));
    assert.equal(s.listening(), false, JSON.stringify(opts));
    assert.equal(s.el("title").textContent, "Open WoCo to sign in");
    assert.match(s.el("line").textContent, /only works when WoCo opens it\. Go to WoCo and tap Sign in\./);
    assert.equal(s.el("home").hidden, false, "nothing to go back to: the link to WoCo shows");
  }
});

test("the one link stays hidden whenever WoCo did open the window", async () => {
  const html = (await prod).index;
  const states: Array<[string, (s: ReturnType<typeof sandbox>) => Promise<void> | void]> = [
    ["waiting", () => {}],
    ["asked", (s) => s.send(request())],
    ["timed out", (s) => s.timers.forEach((f) => f())],
    ["out of step", (s) => s.send(request({ v: 2 }))],
    ["cancelled", (s) => { s.send(request()); s.el("cancel").click(); s.timers.forEach((f) => f()); }],
    ["signed in", async (s) => { s.send(request()); s.el("go").click(); await settle(() => s.posted.length > 1); s.timers.forEach((f) => f()); }],
  ];
  for (const [name, act] of states) {
    const s = sandbox(html, { credentials: creds([assertion()]) });
    await act(s);
    assert.equal(s.el("home").hidden, true, name);
  }
});

test("a sign-in's note points a newcomer at Create; every other action keeps the reassurance", async () => {
  const html = (await prod).index;
  assert.match(html, /<p class="note" id="note">Your passkey stays on your device\.<\/p>/);
  for (const action of ["signin", "restore", "create"]) {
    const s = sandbox(html, { credentials: creds() });
    s.send(request(action === "restore" ? { action, credentialId: "A".repeat(16), fallback: false } : { action }));
    assert.equal(s.el("go").hidden, false, action);
    assert.equal(s.el("note").textContent, action === "signin" ? "New to WoCo? Cancel, then create an account." : "", action);
  }
});

test("a request this version does not know is refused readably, with its nonce", async () => {
  const s = sandbox((await prod).index, { credentials: creds() });
  s.send(request({ v: 2 }));
  assert.deepEqual(s.posted[1]!.clone, { v: 1, type: "result", nonce, ok: false, error: { name: "UnsupportedRequest", detail: "version 2" } });
  assert.match(s.el("line").textContent, /out of step/);
});

test("Cancel answers as a cancelled ceremony and closes", async () => {
  const s = sandbox((await prod).index, { credentials: creds() });
  s.send(request());
  s.el("cancel").click();
  assert.deepEqual(s.posted[1]!.clone.error, { name: "NotAllowedError", quick: false });
  assert.equal(s.closed(), true);
});

test("a creation with no PRF value gets its second tap in the window", async () => {
  const created = { ...assertion(), getClientExtensionResults: () => ({ prf: {} }), response: { getAuthenticatorData: () => new Uint8Array(37).buffer } };
  const s = sandbox((await prod).index, { credentials: creds([assertion()], [created]) });
  s.send(request({ action: "create" }));
  s.el("go").click();
  await settle(() => s.el("title").textContent === "One more step");
  assert.equal(s.el("title").textContent, "One more step");
  s.el("go").click();
  await settle(() => s.posted.length > 1);
  assert.equal(s.posted[1]!.clone.ok, true);
});
