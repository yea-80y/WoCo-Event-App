/**
 * RichTextSection renders organiser prose through `{@html}` on the same origin
 * as the WoCo app, so the property that makes it safe is pinned here (#212).
 *
 * The safety argument is structural, not a list of blocked inputs: after the
 * escape pass, every `<` in the output must belong to a tag the renderer wrote
 * itself, and every `&` must be one of the three entities it emits. The two
 * property assertions below are that argument, made machine-checkable — they
 * hold for any input, not just the samples.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, renderMarkdown } from "../src/lib/components/site/sections/render-markdown.js";

/** The complete set of tags renderMarkdown is allowed to emit. */
const ALLOWED_TAG = /^<\/?(?:h1|h2|h3|strong|em|p|br)>/;
/** The complete set of entities it is allowed to emit. */
const ALLOWED_ENTITY = /^&(?:amp|lt|gt);/;

/** Property 1: no `<` in the output starts anything but an allowlisted tag. */
function assertOnlyOwnTags(out: string, label: string) {
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== "<") continue;
    assert.ok(
      ALLOWED_TAG.test(out.slice(i)),
      `${label}: '<' at index ${i} does not begin a renderer-written tag — ${JSON.stringify(out.slice(i, i + 40))}`,
    );
  }
}

/** Property 2: no `&` in the output starts anything but an allowlisted entity. */
function assertOnlyOwnEntities(out: string, label: string) {
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== "&") continue;
    assert.ok(
      ALLOWED_ENTITY.test(out.slice(i)),
      `${label}: '&' at index ${i} does not begin a known entity — ${JSON.stringify(out.slice(i, i + 40))}`,
    );
  }
}

/**
 * Inputs chosen to exercise each structural position the pipeline has: the
 * paragraph split, the `startsWith('<h')` branch, the newline-to-<br> step and
 * the emphasis captures. These are markup-shaped because that is the whole
 * question — none of them may survive as markup.
 */
const INPUTS: Array<[string, string]> = [
  ["plain prose", "Just some ordinary copy about the venue."],
  ["angle brackets in prose", "Doors 7 < 8 > 9 and a & b"],
  ["a raw element", "<div>hello</div>"],
  ["a script element", "<script>alert(1)</script>"],
  ["an element with an event attribute", `<img src=x onerror="boom">`],
  ["an svg with a handler", "<svg><animate onbegin=go /></svg>"],
  ["an iframe", `<iframe src="https://example.test"></iframe>`],
  ["a quoted attribute soup", `" onmouseover="x" a="`],
  ["heading spoof at block start", "<h1>not ours</h1>"],
  ["heading spoof after a blank line", "intro\n\n<h2 id=x>spoof</h2>"],
  ["entity that looks pre-escaped", "&lt;script&gt;alert(1)&lt;/script&gt;"],
  ["ampersand storm", "&&&amp;&#x27;&#39;"],
  ["emphasis wrapping markup", "**<b>bold</b>** and *<i>it</i>*"],
  ["newline to br with markup", "line one\n<br onload=x>\nline three"],
  ["heading syntax with markup", "# <script>x</script>"],
  ["dollar sequences in captures", "**$& $1 $` $'**"],
  ["comment open", "<!-- <script>x</script> -->"],
  ["cdata-ish", "<![CDATA[<script>x</script>]]>"],
  ["unclosed tag", "<div"],
  ["empty", ""],
];

test("renderMarkdown emits only its own tags, for every input", () => {
  for (const [label, input] of INPUTS) {
    const out = renderMarkdown(input);
    assertOnlyOwnTags(out, label);
    assertOnlyOwnEntities(out, label);
  }
});

test("escapeHtml escapes & first, so entities are not double-mangled", () => {
  // Reversing the order would turn a literal '<' into '&amp;lt;'.
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml(">"), "&gt;");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

test("markup an organiser typed is displayed as text, not interpreted", () => {
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!out.includes("<script"), "raw script tag must not survive");
  assert.ok(out.includes("&lt;script&gt;"), "it must appear as visible text instead");
});

test("the heading branch can no longer be spoofed from input", () => {
  // Pre-fix, a paragraph beginning "<h" was passed through unwrapped.
  const out = renderMarkdown("<h1>spoof</h1>");
  assert.ok(out.startsWith("<p>"), `expected a wrapped paragraph, got ${out}`);
});

test("the supported markdown subset still renders", () => {
  assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
  assert.equal(renderMarkdown("## Title"), "<h2>Title</h2>");
  assert.equal(renderMarkdown("### Title"), "<h3>Title</h3>");
  assert.equal(renderMarkdown("**bold**"), "<p><strong>bold</strong></p>");
  assert.equal(renderMarkdown("*italic*"), "<p><em>italic</em></p>");
  assert.equal(renderMarkdown("one\ntwo"), "<p>one<br>two</p>");
  assert.equal(renderMarkdown("one\n\ntwo"), "<p>one</p>\n<p>two</p>");
});

test("ordinary punctuation survives readably", () => {
  assert.equal(renderMarkdown("Fish & chips"), "<p>Fish &amp; chips</p>");
  assert.equal(renderMarkdown("Doors 7 < 8"), "<p>Doors 7 &lt; 8</p>");
});

test("empty and whitespace input produce nothing", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("   \n\n  "), "");
});
