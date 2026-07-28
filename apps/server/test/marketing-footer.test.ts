/**
 * The compliance block is a legal control, not cosmetics: an email that ships
 * without a visible unsubscribe link or a postal address is a CAN-SPAM breach
 * and a deliverability incident. These tests pin the properties that must hold
 * for EVERY marketing send, including against a hostile organiser display name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  footerHtml,
  footerText,
  withFooter,
  htmlToPlainText,
} from "../src/lib/email/marketing-footer.js";

const CTX = {
  displayName: "The Fox & Hound",
  unsubUrl: "https://events-api.woco-net.com/u/mu1.abc.def",
  postalAddress: "WoCo Ltd, 71-75 Shelton Street, London, WC2H 9JQ",
};

test("footer carries all three legal obligations", () => {
  const html = footerHtml(CTX);
  assert.match(html, /opted in to updates from/, "provenance line missing");
  assert.ok(html.includes(CTX.unsubUrl), "unsubscribe URL missing");
  assert.match(html, />Unsubscribe</, "unsubscribe link text missing");
  assert.ok(html.includes("71-75 Shelton Street"), "postal address missing");
});

test("text footer carries the same three obligations", () => {
  const text = footerText(CTX);
  assert.match(text, /opted in to updates from/);
  assert.ok(text.includes(CTX.unsubUrl));
  assert.ok(text.includes("71-75 Shelton Street"));
});

test("display name is HTML-escaped so it cannot hide the unsubscribe link", () => {
  // 24 chars, no quotes needed — this is what an unescaped name would smuggle
  // in to swallow everything after it, unsubscribe link included.
  const hostile = "<div style=display:none>";
  const html = footerHtml({ ...CTX, displayName: hostile });
  assert.ok(!html.includes(hostile), "raw markup survived into the footer");
  assert.ok(html.includes("&lt;div style=display:none&gt;"));
  // The link must still be reachable markup, not swallowed by an injected tag.
  assert.match(html, /<a href="[^"]*\/u\/mu1[^"]*"[^>]*>Unsubscribe<\/a>/);
});

test("display name cannot break out of the href attribute", () => {
  const html = footerHtml({ ...CTX, displayName: `" onmouseover="alert(1)` });
  assert.ok(!html.includes('onmouseover="alert(1)'));
});

test("ampersands in a brand name are escaped once, not doubled", () => {
  assert.equal(escapeHtml("Fish & Chips"), "Fish &amp; Chips");
  assert.ok(footerHtml(CTX).includes("The Fox &amp; Hound"));
});

test("footer is inserted inside a document-final </body>", () => {
  const out = withFooter("<html><body><p>Hi</p></body></html>", "<i>FOOT</i>");
  assert.ok(out.includes("<i>FOOT</i></body></html>"));
});

test("a mid-document </body> cannot hide the footer", () => {
  // A sender hiding a fake document end inside the body must not move the
  // footer into the hidden region — it belongs at the true end.
  const sneaky = `<div style="display:none"></body></html></div><p>Real content</p>`;
  const out = withFooter(sneaky, "<i>FOOT</i>");
  assert.ok(out.endsWith("<i>FOOT</i>"), "footer was not appended at the true end");
});

test("footer is appended when there is no </body> at all", () => {
  assert.equal(withFooter("<p>Hi</p>", "FOOT"), "<p>Hi</p>FOOT");
});

test("plain text alternative strips markup and keeps the words", () => {
  const text = htmlToPlainText(
    "<html><body><h2>Live Friday</h2><p>Doors at 8pm.</p><p>See you there.</p></body></html>",
  );
  assert.match(text, /Live Friday/);
  assert.match(text, /Doors at 8pm\./);
  assert.ok(!text.includes("<"), "tags survived into the text part");
});

test("plain text drops style and script content entirely", () => {
  const text = htmlToPlainText(
    "<body><style>.a{color:red}</style><script>alert(1)</script><p>Only this</p></body>",
  );
  assert.equal(text, "Only this");
});

test("plain text decodes entities without double-decoding", () => {
  assert.equal(htmlToPlainText("<p>Fish &amp; Chips</p>"), "Fish & Chips");
  // &amp;lt; is a literal "&lt;", not a "<" — decoding twice would be a bug.
  assert.equal(htmlToPlainText("<p>&amp;lt;</p>"), "&lt;");
});

test("plain text collapses runaway blank lines", () => {
  const text = htmlToPlainText("<p>A</p><br/><br/><br/><br/><p>B</p>");
  assert.equal(text, "A\n\nB");
});
