/**
 * The sign-in WINDOW design's live test pages (`public/popup-test.html` on
 * woco.eth.limo, `public/passkey-window-test.html` + its service worker on
 * app.woco.eth.limo). Throwaway pages, but they run real passkey ceremonies on the
 * production hosts, so they are held to the window design's rules: one request, from
 * woco.eth.limo only; replies to an explicit origin; no key or PRF output ever leaves
 * the window; the test passkey can never be mistaken for an account.
 *
 * MUTATION: let acceptRequest skip the origin check and "only woco.eth.limo" goes red;
 * reply with targetOrigin "*" and the reply test goes red; post the PRF bytes and the
 * no-secret test goes red; await before window.open and the gesture test goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const opener = read("popup-test.html");
const windowPage = read("passkey-window-test.html");
const sw = read("passkey-window-test-sw.js");
const scriptOf = (html: string) => html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
const winScript = scriptOf(windowPage);
const openScript = scriptOf(opener);
const block = (s: string) => s.slice(s.indexOf("// PROTOCOL-START"), s.indexOf("// PROTOCOL-END"));

// Our own shipped file, run in an empty sandbox - nothing outside the repo is evaluated.
const { acceptRequest } = runInNewContext(`${block(winScript)}; ({ acceptRequest })`, {}) as {
  acceptRequest: (ev: unknown, opener: unknown, already: boolean) => { nonce: string; action: string } | null;
};
const OPENER = { tag: "opener" };
const good = { origin: "https://woco.eth.limo", source: OPENER, data: { type: "request", nonce: "a".repeat(24), action: "get" } };

test("the window takes one request, only from woco.eth.limo, only from its opener", () => {
  // Fields, not deepEqual: the result is built in the sandbox's own realm (another Object prototype).
  const ok = acceptRequest(good, OPENER, false);
  assert.equal(ok?.nonce, "a".repeat(24));
  assert.equal(ok?.action, "get");
  assert.equal(acceptRequest({ ...good, origin: "https://rita.woco.eth.limo" }, OPENER, false), null, "a sub-name page is refused");
  assert.equal(acceptRequest({ ...good, origin: "https://app.woco.eth.limo" }, OPENER, false), null);
  assert.equal(acceptRequest({ ...good, source: { tag: "other" } }, OPENER, false), null, "not from the opener");
  assert.equal(acceptRequest(good, null, false), null, "no opener");
  assert.equal(acceptRequest(good, OPENER, true), null, "single use");
  assert.equal(acceptRequest({ ...good, data: { ...good.data, nonce: "short" } }, OPENER, false), null);
  assert.equal(acceptRequest({ ...good, data: { ...good.data, action: "sign" } }, OPENER, false), null);
});

test("replies go to an explicit origin, never '*'", () => {
  for (const s of [winScript, openScript]) assert.ok(!/postMessage\([^)]*["']\*["']/.test(s));
  assert.match(winScript, /postMessage\(\{ type: "ready" \}, ALLOWED_OPENER\)/);
  assert.match(winScript, /replyTo\.source\.postMessage\(\{ type: "result", nonce: accepted\.nonce, result: res \}, replyTo\.origin\)/);
  assert.match(openScript, /win\.postMessage\(\{[^}]*\}, WINDOW_ORIGIN\)/);
});

test("no key or PRF output leaves the window; the test passkey is never an account", () => {
  const assigns = winScript.match(/res\.prfOk\s*=\s*[^;]+;/g) ?? [];
  assert.equal(assigns.length, 1);
  assert.match(assigns[0]!, /^res\.prfOk\s*=\s*!!\(/, "a boolean, not the bytes");
  assert.ok(!/res\.\w+\s*=\s*ext\.prf\.results/.test(winScript));
  assert.match(winScript, /TEST_HANDLE_PREFIX = "woco-popup-test:"/);
  assert.match(winScript, /TEST_PRF_SALT_INPUT = "woco-popup-test-prf-v1"/);
  assert.ok(!winScript.includes("woco-passkey-secp256k1-v1"), "never the production PRF salt");
});

test("the window opens synchronously in the click, before anything is awaited", () => {
  const fn = openScript.slice(openScript.indexOf("function openWindow"), openScript.indexOf("$(\"create\")"));
  const open = fn.indexOf("window.open(");
  assert.ok(open > 0);
  for (const later of [".then(", "await "]) {
    const i = fn.indexOf(later);
    assert.ok(i === -1 || i > open, `${later} only after window.open`);
  }
});

test("self-contained, scoped and in owner copy style", () => {
  for (const f of [opener, windowPage]) {
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(f), "nothing loaded from elsewhere");
    assert.ok(!f.includes("—"), "spaced hyphen, never an em dash");
  }
  assert.match(winScript, /scope: "\.\/passkey-window-test"/, "the worker controls the test window only");
  assert.match(sw, /url\.pathname !== PAGE\) return;/, "it ignores every other request");
});
