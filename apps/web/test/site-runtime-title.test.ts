/**
 * #70: a published website's tab title. The HTML carries the brand name from
 * publish (packages/shared render); the runtime keeps it on the home page and
 * names any other page "{page} | {brand}", so a crawler that runs script sees
 * the brand, not the template's "Home".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTitle } from "../src/lib/seo/head.js";

const app = readFileSync(new URL("../src/MultiSiteApp.svelte", import.meta.url), "utf8");

function titled(slug: string, pageTitle: string | undefined, brand: string, before = "Acme Pub"): string {
  const doc = { title: before };
  (globalThis as { document?: unknown }).document = doc;
  try {
    // The runtime's own rule, as MultiSiteApp applies it.
    setTitle(slug === "/" || !pageTitle ? brand : pageTitle, brand);
    return doc.title;
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
}

test("the runtime names the home page by the brand and every other page '{page} | {brand}'", () => {
  assert.match(app, /setTitle\(page\.slug === '\/' \|\| !page\.title \? brand : page\.title, brand\);/);
  assert.ok(!/document\.title\s*=/.test(app), "one place sets the title");
  assert.equal(titled("/", "Home", "Acme Pub"), "Acme Pub");
  assert.equal(titled("/about", "About", "Acme Pub"), "About | Acme Pub");
  assert.equal(titled("/about", undefined, "Acme Pub"), "Acme Pub");
  assert.equal(titled("/events", "Acme Pub events", "Acme Pub"), "Acme Pub events", "no doubled brand");
  assert.equal(titled("/", "Home", "", "WoCo Site"), "WoCo Site", "no brand: the published title stays");
});
