/**
 * The id a site is saved under (`lib/creator/builder/owned-site-id.ts`), and that
 * both places that save a site ask it before anything is stored under the id.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ownedSiteId, siteIdOwnedBy } from "@woco/shared";
import { siteIdForSave } from "../src/lib/creator/builder/owned-site-id.js";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** What a draft started before sign-in carries. */
const PLACEHOLDER = "mvk4388p-rm7dnip";

test("a draft's placeholder becomes an id the account owns", () => {
  const id = siteIdForSave(PLACEHOLDER, ALICE, false);
  assert.notEqual(id, PLACEHOLDER);
  assert.equal(siteIdOwnedBy(id, ALICE), true);
});

test("an id the account already owns is kept, so a second save is the same site", () => {
  const id = ownedSiteId(ALICE, "000000000001");
  assert.equal(siteIdForSave(id, ALICE, false), id);
  assert.equal(siteIdForSave(id, ALICE, true), id);
});

test("an unsaved draft another account started is given this account's own id", () => {
  const theirs = ownedSiteId(BOB, "000000000001");
  const id = siteIdForSave(theirs, ALICE, false);
  assert.notEqual(id, theirs);
  assert.equal(siteIdOwnedBy(id, ALICE), true);
});

test("a site that is already live keeps its id, whatever its shape", () => {
  // A new id would be a new site and leave the live one behind; the server decides.
  assert.equal(siteIdForSave(PLACEHOLDER, ALICE, true), PLACEHOLDER);
  const theirs = ownedSiteId(BOB, "000000000001");
  assert.equal(siteIdForSave(theirs, ALICE, true), theirs);
});

test("no id yet is a new one", () => {
  assert.equal(siteIdOwnedBy(siteIdForSave("", ALICE, false), ALICE), true);
});

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the builder takes its id before the first thing a save stores or signs", () => {
  const src = source("../src/lib/creator/builder/MultiSiteBuilder.svelte");
  const sequence = src.slice(src.indexOf("const publishSequence = async () => {"));
  const adopt = sequence.indexOf("adoptOwnedSiteId();");
  assert.ok(adopt > 0, "the publish sequence adopts the id");
  for (const later of ["uploadSiteImage(", "auth.getContentFeedSigner()", "publishSite(", "deploySite("]) {
    const at = sequence.indexOf(later);
    assert.ok(at > adopt, `${later} comes after the id is adopted`);
  }
  // The index topic is derived from the id and stored in the site: it moves with it.
  const fn = src.slice(src.indexOf("function adoptOwnedSiteId()"), src.indexOf("let publishArming"));
  assert.match(fn, /site\.siteId = id;\s*site\.eventsIndexTopic = siteEventsIndexTopic\(id\);/);
});

test("the shop storefront saves under an owned id too", () => {
  const src = source("../src/lib/creator/shops/ShopEditor.svelte");
  assert.match(src, /const siteId = siteIdForSave\(saved, auth\.parent as string, false\);/);
  assert.doesNotMatch(src, /let siteId = uid\(\)/);
});
