/**
 * The id a site is saved under (`lib/creator/builder/owned-site-id.ts`), and that
 * both places that save a site ask it before anything is stored under the id.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ownedSiteId, siteIdOwnedBy } from "@woco/shared";
import { siteIdForSave, siteIsLive } from "../src/lib/creator/builder/owned-site-id.js";

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

// ── Which sites count as live ───────────────────────────────────────────────

test("a draft's card on My Sites is not a live site", () => {
  // Going back to the list adds the draft as a card. Counting it as live kept the
  // placeholder id, and the server refused that id on every later save.
  const draftCard = { siteId: PLACEHOLDER, brandName: "x", accentColor: "#000", updatedAt: 1 };
  assert.equal(siteIsLive(draftCard, false), false);
  assert.equal(siteIsLive(undefined, false), false);
  assert.equal(siteIdOwnedBy(siteIdForSave(PLACEHOLDER, ALICE, siteIsLive(draftCard, false)), ALICE), true);
});

test("a card that was published, has an address or a feed is live", () => {
  assert.equal(siteIsLive({ publishedAt: 1 }, false), true);
  assert.equal(siteIsLive({ deployedUrl: "https://x.example" }, false), true);
  assert.equal(siteIsLive({ feedHash: "ab".repeat(32) }, false), true);
});

test("a copy from a deploy or from the server makes a site live without a card", () => {
  assert.equal(siteIsLive(undefined, true), true);
  assert.equal(siteIsLive({}, true), true);
});

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the builder decides live from the card's content and this device's copies, not from being listed", () => {
  const src = source("../src/lib/creator/builder/MultiSiteBuilder.svelte");
  const fn = src.slice(src.indexOf("function adoptOwnedSiteId()"), src.indexOf("let publishArming"));
  assert.match(fn, /siteIsLive\(\s*mySites\.find\(\(r\) => r\.siteId === placeholder\),/);
  assert.match(fn, /woco:site-content-hash:\$\{placeholder\}/);
  assert.match(fn, /cacheKey\.siteConfig\(placeholder\)/);
  assert.doesNotMatch(fn, /mySites\.some\(\(r\) => r\.siteId === site\.siteId\)/);
  // The draft's card goes with its placeholder, or My Sites shows the site twice.
  assert.match(fn, /mySites = mySites\.filter\(\(r\) => r\.siteId !== placeholder\);\s*saveMySites\(auth\.parent, mySites\);/);
});

test("removing a passkey passes over a site nobody can save any more, and moves the rest", () => {
  const src = source("../src/lib/keyring/rotate-live.ts");
  const loop = src.slice(src.indexOf("sites: async (keys: NewKeys) => {"));
  const skip = loop.indexOf('if (!pub.ok && pub.code === "SITE_ID_RETIRED") continue;');
  const fail = loop.indexOf("if (!pub.ok) throw new Error(");
  assert.ok(skip > 0, "a retired id is passed over");
  assert.ok(fail > skip, "before any other refusal stops the move");
});

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
