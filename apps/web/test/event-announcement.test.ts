/**
 * Broadcast bodies go to a whole audience and cannot be recalled, so the
 * properties that make them safe get pinned here: organiser prose is escaped,
 * and the document ends where the server's compliance footer expects to insert.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEventAnnouncementHtml,
  buildPlainMessageHtml,
  formatEventWhen,
  publicEventUrl,
  escapeHtml,
} from "../src/lib/creator/audience/event-announcement.js";

const EVENT = {
  title: "Basement Sessions 04",
  tagline: "All night long",
  startDate: "2026-08-15T20:00:00.000Z",
  location: "Corsica Studios, London",
  imageUrl: "https://gateway.woco-net.com/bytes/abc123",
};

const INPUT = {
  brand: "The Fox & Hound",
  message: "Tickets are live.\n\nFirst release is 60 tickets.",
  event: EVENT,
  eventUrl: "https://woco.eth.limo/event/evt_123",
};

test("announcement carries the event, the CTA and the organiser's words", () => {
  const html = buildEventAnnouncementHtml(INPUT);
  assert.ok(html.includes("Basement Sessions 04"), "title missing");
  assert.ok(html.includes("All night long"), "tagline missing");
  assert.ok(html.includes("Corsica Studios, London"), "location missing");
  assert.ok(html.includes("https://woco.eth.limo/event/evt_123"), "CTA target missing");
  assert.match(html, />Get tickets</, "CTA button missing");
  assert.ok(html.includes("First release is 60 tickets."), "organiser message missing");
  assert.ok(html.includes(EVENT.imageUrl), "hero image missing");
});

test("body ends with a document-final </body></html> for the footer insert", () => {
  // withFooter() in the server only honours a document-final </body>; if this
  // template stopped ending that way the compliance block would be appended
  // after </html> instead of inside the document.
  for (const html of [buildEventAnnouncementHtml(INPUT), buildPlainMessageHtml("Brand", "Hi")]) {
    assert.match(html, /<\/body><\/html>$/);
  }
});

test("organiser prose cannot inject markup", () => {
  const html = buildEventAnnouncementHtml({
    ...INPUT,
    message: `<script>alert(1)</script><a href="x">click</a>`,
  });
  assert.ok(!html.includes("<script>"), "script tag survived");
  assert.ok(!html.includes('<a href="x">'), "anchor survived");
  assert.ok(html.includes("&lt;script&gt;"));
});

test("a hostile event title cannot break the layout", () => {
  const html = buildEventAnnouncementHtml({
    ...INPUT,
    event: { ...EVENT, title: `"><style>body{display:none}</style>` },
  });
  assert.ok(!html.includes("<style>body{display:none}</style>"));
});

test("brand name escapes once", () => {
  assert.equal(escapeHtml("Fish & Chips"), "Fish &amp; Chips");
  assert.ok(buildEventAnnouncementHtml(INPUT).includes("The Fox &amp; Hound"));
});

test("blank lines become paragraphs, single newlines become breaks", () => {
  const html = buildPlainMessageHtml("B", "one\ntwo\n\nthree");
  assert.ok(html.includes("one<br />two"));
  assert.equal(html.match(/<p style="margin:0 0 14px/g)?.length, 2);
});

test("event with no image renders without a broken img", () => {
  const html = buildEventAnnouncementHtml({
    ...INPUT,
    event: { ...EVENT, imageUrl: undefined },
  });
  assert.ok(!html.includes("<img"), "img tag emitted with no source");
  assert.ok(html.includes("Basement Sessions 04"));
});

test("an unparseable date drops the When row rather than printing junk", () => {
  assert.equal(formatEventWhen("not-a-date"), "");
  const html = buildEventAnnouncementHtml({
    ...INPUT,
    event: { ...EVENT, startDate: "not-a-date" },
  });
  assert.ok(!html.includes(">When<"), "empty When row was rendered");
  assert.ok(html.includes("Corsica Studios, London"), "Where row should survive");
});

test("date formats as a readable UK line", () => {
  const when = formatEventWhen("2026-08-15T19:30:00.000Z");
  assert.match(when, /Saturday/);
  assert.match(when, /15 August 2026/);
});

test("a dev-server origin never ships localhost links to an audience", () => {
  for (const local of ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost"]) {
    assert.equal(publicEventUrl("evt_1", local), "https://woco.eth.limo/event/evt_1");
  }
});

test("a real origin is kept, trailing slash and all", () => {
  assert.equal(publicEventUrl("evt_1", "https://woco.eth.limo/"), "https://woco.eth.limo/event/evt_1");
  assert.equal(
    publicEventUrl("evt_1", "https://gateway.woco-net.com"),
    "https://gateway.woco-net.com/event/evt_1",
  );
  // A host merely containing "localhost" is a real host, not the dev server.
  assert.match(publicEventUrl("e", "https://localhost.example.com"), /^https:\/\/localhost\.example\.com/);
});

test("no stylesheet or flexbox — Outlook renders through Word", () => {
  const html = buildEventAnnouncementHtml(INPUT);
  assert.ok(!/<style[\s>]/.test(html), "stylesheet block present");
  assert.ok(!html.includes("display:flex"), "flexbox present");
  assert.ok(!html.includes("display:grid"), "grid present");
});
