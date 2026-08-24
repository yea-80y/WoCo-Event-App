/**
 * Event broadcasts go to every attendee of an event and cannot be recalled, so
 * the properties that make them safe are pinned here rather than left to the
 * component that used to build them.
 *
 * The builder these tests cover replaced one that escaped nothing (#252) while
 * naming its local `escaped`. Each test states the property, not the
 * implementation, so a future rewrite is still held to it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEventBroadcastHtml } from "../src/lib/creator/dashboard/event-broadcast-email.js";

test("organiser prose is escaped, so typed markup cannot become markup", () => {
  const html = buildEventBroadcastHtml("<script>alert(1)</script>", "Basement Sessions 04");
  assert.ok(!html.includes("<script>"), "raw <script> reached the document");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("the event title is escaped too — it is organiser-controlled and reaches the same inbox", () => {
  const html = buildEventBroadcastHtml("See you there.", '<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"), "raw <img> reached the document");
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("a quote in the title cannot break out of a surrounding attribute", () => {
  const html = buildEventBroadcastHtml("body", 'Nights " onmouseover="x');
  assert.ok(!html.includes('" onmouseover="'), "unescaped quote survived");
  assert.ok(html.includes("&quot; onmouseover=&quot;"));
});

test("newlines become <br>, and those tags survive escaping", () => {
  const html = buildEventBroadcastHtml("line one\nline two", "T");
  assert.ok(html.includes("line one<br>line two"));
  assert.ok(!html.includes("&lt;br&gt;"), "the builder escaped its own <br>");
});

test("ampersands are escaped once, not twice", () => {
  const html = buildEventBroadcastHtml("Fish & Chips", "Rock & Roll");
  assert.ok(html.includes("Fish &amp; Chips"));
  assert.ok(html.includes("Rock &amp; Roll"));
  assert.ok(!html.includes("&amp;amp;"), "double-escaped — organisers would see literal &amp;");
});

test("the document ends at a final </body>, which is where the compliance footer inserts", () => {
  const html = buildEventBroadcastHtml("body", "T");
  assert.ok(
    html.trimEnd().endsWith("</body></html>"),
    "moving this anchor drops the unsubscribe link and postal address from every send",
  );
  assert.equal(html.match(/<\/body>/g)?.length, 1, "more than one </body> makes the anchor ambiguous");
});
