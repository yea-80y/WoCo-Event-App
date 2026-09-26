/**
 * The /embed/frame page (#567): the organiser page the snippet passes in reaches
 * the widget only as an escaped http(s) attribute, and the page serves exactly
 * the inline script whose hash FRAME_CSP pins — the pairing security-headers.test
 * could not see while the template lived inline in index.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildFramePage, framePageUrl } from "../src/lib/embed/frame-page.js";
import { FRAME_INLINE_SCRIPT } from "../src/lib/http/security-headers.js";

const EV = "83d23fab-16f7-42d6-922f-57eb95f437cf";
const pageAttr = (html: string) => html.match(/page-url="([^"]*)"/)?.[1] ?? null;

test("the page serves exactly the inline script FRAME_CSP hashes", () => {
  assert.ok(buildFramePage({ eventId: EV }).includes(`<script>${FRAME_INLINE_SCRIPT}</script>`));
});

test("an https organiser page reaches the widget as an escaped attribute", () => {
  const html = buildFramePage({ eventId: EV, page: "https://venue.example/p?a=1&b=2" });
  assert.equal(pageAttr(html), "https://venue.example/p?a=1&amp;b=2");
});

test("a non-http page, an absent page and an overlong page add no attribute", () => {
  for (const page of ["javascript:alert(1)", "data:text/html,x", undefined, `https://venue.example/${"a".repeat(3000)}`]) {
    assert.equal(buildFramePage({ eventId: EV, page }).includes("page-url="), false, String(page).slice(0, 40));
  }
});

test("quotes and angle brackets in a page cannot leave the attribute", () => {
  const html = buildFramePage({ eventId: EV, page: `https://venue.example/p?q="'><b>` });
  const attr = pageAttr(html);
  assert.ok(attr);
  assert.ok(!/["'<>]/.test(attr!), attr!);
  assert.ok(!html.includes("<b>"));
});

test("framePageUrl keeps http and https only", () => {
  assert.equal(framePageUrl("http://localhost:8787/embed-test.html"), "http://localhost:8787/embed-test.html");
  assert.equal(framePageUrl("ftp://venue.example/"), null);
  assert.equal(framePageUrl("not a url"), null);
});

test("event id and theme stay sanitised, and the current bundle version is loaded", () => {
  const html = buildFramePage({ eventId: `${EV}"><x`, theme: "light" });
  assert.ok(html.includes(`event-id="${EV}x"`));
  assert.ok(html.includes(`theme="light"`));
  assert.ok(html.includes("woco-embed.js?v=12"));
});
