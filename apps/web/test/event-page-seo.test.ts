/**
 * #55: a single-event page bakes its schema.org Event at publish, and the page's
 * runtime replaces that block with live values. The two must agree on the page's
 * address and the app must ask for the head it renders.
 *
 * By SOURCE SCAN (the components declare `$state`, which Node cannot load).
 *
 * MUTATION: drop `&head=2` from the page-config request and "the app asks for the
 * head it renders" goes red; pass `window.location.href` from SiteApp, or stop
 * reading the baked canonical, and "a single-event page states its canonical" goes
 * red; drop `cancelled` from EventPage and "the runtime says when it is cancelled"
 * goes red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(SRC + p, "utf-8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("the app asks for the head it renders (head=2): an app that does not ask never gets one", () => {
  assert.match(code(read("lib/api/sites.ts")), /\/page-config\?apiUrl=\$\{encodeURIComponent\(opts\.apiUrl\)\}&head=2`/);
});

test("a single-event page states its baked canonical as the Event's url, or none - never the URL it is read through", () => {
  const app = code(read("SiteApp.svelte"));
  assert.match(app, /const PAGE_URL =\s*\(typeof document !== "undefined" && document\.querySelector\('link\[rel="canonical"\]'\)\?\.getAttribute\("href"\)\) \|\| null;/);
  assert.match(app, /<EventPage eventId=\{EVENT_ID\} pageUrl=\{PAGE_URL\}/);
  const page = code(read("lib/components/site/EventPage.svelte"));
  assert.match(page, /url: pageUrl === undefined \? window\.location\.href : \(pageUrl \?\? undefined\),/);
});

test("the runtime says when the event is cancelled, and describes it as the bake does", () => {
  const page = code(read("lib/components/site/EventPage.svelte"));
  assert.match(page, /cancelled: !!ev\.cancelledAt,/);
  assert.match(page, /setMetaDescription\(eventMetaDescription\(ev, EVENT_DESCRIPTION_MAX - 1\)\)/);
  assert.match(page, /setJsonLd\(\s*"event",/, "the id the baked block carries (data-woco-seo=\"event\"), so it is replaced, not doubled");
});
