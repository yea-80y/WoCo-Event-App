/**
 * An event page (SiteApp, the `eventPage` line of every site runtime release) is
 * served on many origins and carries no organiser code: the organiser manages an
 * event in the app (`#/creator/events/{id}`). Its old `#/dashboard` route put the
 * dashboard, the sealed-order opener and the seat-move signer in every release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const site = readFileSync(new URL("../src/SiteApp.svelte", import.meta.url), "utf8");

test("the event page imports nothing from the organiser side", () => {
  assert.doesNotMatch(site, /lib\/creator\//);
  assert.doesNotMatch(site, /Dashboard/);
});

test("the event page has no dashboard route and offers no dashboard button", () => {
  assert.doesNotMatch(site, /["'`]\/dashboard["'`]/);
  assert.doesNotMatch(site, /ondashboard/);
});
