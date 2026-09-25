/**
 * The static ticket page (vite-plugins/ticket-page.ts + src/ticket/ticket-page.ts).
 *
 * The property that matters: the signature in the URL fragment never leaves the
 * phone. That is enforced by the page's CSP (`connect-src 'none'`, one script
 * pinned by hash), so these tests pin the CSP to the exact inlined bytes and hold
 * the script source to making no request and parsing nothing as markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { escapeInlineScript, ticketPageHtml } from "../vite-plugins/ticket-page.js";

const SCRIPT_SRC = readFileSync(new URL("../src/ticket/ticket-page.ts", import.meta.url), "utf-8");

function inlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(m, "the page must carry exactly one inline script before </body>");
  return m![1];
}

test("the CSP pins the exact inlined script by hash", () => {
  const html = ticketPageHtml('console.log("ticket")');
  const inlined = inlineScript(html);
  const hash = createHash("sha256").update(inlined, "utf8").digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${hash}'`), "hash must match the bytes actually served");
});

test("the CSP forbids every request a script could make, and precedes the script", () => {
  const html = ticketPageHtml("void 0");
  const meta = html.indexOf('http-equiv="Content-Security-Policy"');
  assert.ok(meta !== -1 && meta < html.indexOf("<script>"));
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /base-uri 'none'/);
});

test("the page has no <base> and no href - nothing can resolve against a gateway base (#605)", () => {
  const html = ticketPageHtml("void 0");
  assert.doesNotMatch(html, /<base\b/i);
  assert.doesNotMatch(html, /\shref=/i);
});

test("a '</script' inside the bundle cannot end the tag early", () => {
  const html = ticketPageHtml('var s = "</script><img src=x>";');
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  assert.equal(escapeInlineScript("</SCRIPT"), "<\\/SCRIPT");
});

test("the page script makes no request and parses nothing as markup", () => {
  for (const banned of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /WebSocket/,
    /EventSource/,
    /importScripts/,
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /insertAdjacentHTML/,
    /document\.write/,
  ]) {
    assert.doesNotMatch(SCRIPT_SRC, banned, `ticket page script must not use ${banned}`);
  }
});
