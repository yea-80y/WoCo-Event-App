/**
 * Who may write to a site, from the site id alone (`lib/site/site-owner-rule.ts`).
 *
 * The routes are covered in `site-gates-routes.test.ts`; this is the rule by
 * itself, and the closed list of sites kept from before ids proved their owner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ownedSiteId } from "@woco/shared";
import { EARLIER_SITE_OWNERS, SITE_ID_RETIRED_CODE, siteOwnerRefusal } from "../src/lib/site/site-owner-rule.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_CHECKSUMMED = "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA";
const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SITE_ID = ownedSiteId(OWNER, "000000000001");

test("a v2 id lets its owner through, in either letter case", () => {
  assert.equal(siteOwnerRefusal(SITE_ID, OWNER), null);
  assert.equal(siteOwnerRefusal(SITE_ID, OWNER_CHECKSUMMED), null);
});

test("a v2 id refuses everyone else as not the owner", () => {
  assert.deepEqual(siteOwnerRefusal(SITE_ID, STRANGER), { status: 403, error: "Not the site owner" });
});

test("a v2 id is never looked up in the list of earlier sites", () => {
  // Listing a v2 id under a stranger must not let the stranger in, nor shut the owner out.
  const listed = new Map([[SITE_ID, STRANGER]]);
  assert.equal(siteOwnerRefusal(SITE_ID, STRANGER, listed)?.status, 403);
  assert.equal(siteOwnerRefusal(SITE_ID, OWNER, listed), null);
});

test("an earlier id on the list belongs to the account listed, and to nobody else", () => {
  const kept = new Map([["site-kept-0001", OWNER]]);
  assert.equal(siteOwnerRefusal("site-kept-0001", OWNER, kept), null);
  assert.equal(siteOwnerRefusal("site-kept-0001", OWNER_CHECKSUMMED, kept), null);
  assert.deepEqual(siteOwnerRefusal("site-kept-0001", STRANGER, kept), { status: 403, error: "Not the site owner" });
});

test("an earlier id that is not on the list is refused for everyone, with its own code", () => {
  for (const who of [OWNER, STRANGER]) {
    const refusal = siteOwnerRefusal("site-not-kept-01", who, new Map([["site-kept-0001", OWNER]]));
    assert.equal(refusal?.status, 409);
    assert.equal(refusal?.code, SITE_ID_RETIRED_CODE);
    assert.match(String(refusal?.error), /earlier version/);
  }
});

test("names every object carries are not sites on the list", () => {
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(siteOwnerRefusal(id, OWNER)?.code, SITE_ID_RETIRED_CODE, id);
  }
});

test("the kept sites are the three test websites, under the account that deployed them", () => {
  assert.deepEqual([...EARLIER_SITE_OWNERS.keys()].sort(), ["mvk4388p-rm7dnip", "mw59l4fc-esurd0y", "mw59p9pl-xy51zc9"]);
  for (const [siteId, owner] of EARLIER_SITE_OWNERS) {
    assert.equal(owner, "0x2b6e834afbf4cfaa8990e3205de02e07ee95fe5d", siteId);
    assert.equal(siteOwnerRefusal(siteId, owner), null, siteId);
    assert.equal(siteOwnerRefusal(siteId, STRANGER)?.status, 403, siteId);
  }
});

test("a listed owner must be stored lowercase to match the caller", () => {
  // The caller is lowercased before the comparison; a mixed-case entry would lock its site.
  for (const owner of EARLIER_SITE_OWNERS.values()) assert.equal(owner, owner.toLowerCase());
});
