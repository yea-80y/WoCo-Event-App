/**
 * Which page names the share sheet puts to the chain (the chain decides the
 * rest, see `name-records.test.ts`). A feed only claims a name, so these rules
 * are about which claims are worth a read at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pageNamesFrom } from "../src/lib/campaign/my-pages.js";

const NOW = Date.parse("2026-09-15T12:00:00Z");

test("an event that has ended is not offered", () => {
  const pages = pageNamesFrom([], [
    { label: "lastweek", title: "Last week", startDate: "2026-09-08T20:00:00Z" },
    { label: "friday", title: "Friday", startDate: "2026-09-18T20:00:00Z" },
    // Started yesterday and still running: its end decides.
    { label: "festival", title: "Festival", startDate: "2026-09-14T10:00:00Z", endDate: "2026-09-16T23:00:00Z" },
  ], NOW);
  assert.deepEqual(pages.map((p) => p.label), ["friday", "festival"]);
});

test("a site keeps a name an event also claims", () => {
  const pages = pageNamesFrom(
    [{ label: "punkpub", title: "Punk Pub" }],
    [{ label: "punkpub", title: "Friday gig", startDate: "2026-09-18T20:00:00Z" }],
    NOW,
  );
  assert.deepEqual(pages, [{ label: "punkpub", title: "Punk Pub" }]);
});

test("a feed without a name offers nothing, and names are lower case", () => {
  const pages = pageNamesFrom(
    [{ title: "Unnamed site" }, { label: " PunkPub ", title: "Punk Pub" }],
    [{ label: "", title: "Unnamed event", startDate: "2026-09-18T20:00:00Z" }],
    NOW,
  );
  assert.deepEqual(pages, [{ label: "punkpub", title: "Punk Pub" }]);
});
