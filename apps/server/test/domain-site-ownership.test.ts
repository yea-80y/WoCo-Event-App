/**
 * Binding a custom domain to a siteId requires owning the site (#216).
 *
 * `POST /api/domains` checked the caller for the eventId branch and not at all
 * for the siteId branch — it took the id from the request body and used it. So
 * any authenticated caller could point a hostname THEY control at somebody
 * else's site, and `/resolve/:hostname` would serve that organiser's content
 * hash under it, refreshed by the victim's every future deploy.
 *
 * The decision is exercised directly rather than through the route: the failure
 * paths are the whole point, and a live Swarm read cannot be made to fail on
 * demand. Reader shapes mirror `site-ownership-read.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedSiteId, type Site } from "@woco/shared";

import { decideSiteBind } from "../src/lib/domains/site-ownership.js";
import type { SiteConfigReaders } from "../src/lib/site/service.js";
import { encodeJsonFeed } from "../src/lib/swarm/feeds.js";

/** Stored lowercase, as a publish stamps it. */
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** OWNER's by the id itself (site-owner-rule.ts). */
const SITE_ID = ownedSiteId(OWNER, "000000000001");
/** An id from before ids proved their owner. */
const EARLIER_ID = "site-under-test";
/** The SAME address as the caller sees it — EIP-55 checksummed by getAddress(). */
const OWNER_CHECKSUMMED = "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA";
const STRANGER = "0xbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBb";

function readers(over: Partial<SiteConfigReaders> = {}): SiteConfigReaders {
  return {
    readConfigPage: async () => ({ status: "absent" }),
    readPointerTarget: async () => ({ status: "absent" }),
    readPagesPage: async () => null,
    ...over,
  };
}

const legacySite = (owner = OWNER): Site =>
  ({ siteId: SITE_ID, ownerAddress: owner, theme: { brandName: "x" }, pages: [] }) as unknown as Site;

/** A published, readable site owned by `owner`. */
const foundReaders = (owner = OWNER) =>
  readers({ readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite(owner)) }) });

// ── 1. "could not read" must never be treated as "unclaimed" ─────────────────

const failingReaders = () =>
  readers({ readConfigPage: async () => ({ status: "error", error: new Error("bee timeout") }) });

test("an undecidable read refuses the owner — it is not an unclaimed site", async () => {
  const d = await decideSiteBind(SITE_ID, OWNER, failingReaders());
  assert.equal(d.ok, false);
  assert.equal(d.ok === false ? d.status : 0, 503);
});

// ── 2. the vulnerability itself ──────────────────────────────────────────────

test("a caller who does not own the site cannot bind a domain to it, whatever the read says", async () => {
  // The id says whose the site is. Before it did, a caller could retry until a
  // read failed, or wait for a pointer to be lost, and be handed the site (#181).
  for (const [name, r] of [["published", foundReaders()], ["lost", readers()], ["unreadable", failingReaders()]] as const) {
    const d = await decideSiteBind(SITE_ID, STRANGER, r);
    assert.equal(d.ok, false, name);
    assert.equal(d.ok === false ? d.status : 0, 403, name);
  }
});

test("a stranger is refused before anything is read", async () => {
  let reads = 0;
  const counting = readers({ readConfigPage: async () => { reads++; return { status: "absent" }; } });
  await decideSiteBind(SITE_ID, STRANGER, counting);
  await decideSiteBind(EARLIER_ID, OWNER, counting);
  assert.equal(reads, 0);
});

test("a pointer naming someone else refuses even the id's owner", async () => {
  const d = await decideSiteBind(SITE_ID, OWNER, foundReaders(STRANGER.toLowerCase()));
  assert.equal(d.ok, false);
  assert.equal(d.ok === false ? d.status : 0, 403);
});

test("an id from before ids proved their owner is refused, unless it is one of the kept sites", async () => {
  const published = readers({
    readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed({ ...legacySite(), siteId: EARLIER_ID }) }),
  });
  const refused = await decideSiteBind(EARLIER_ID, OWNER, published);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false ? refused.status : 0, 409);
  assert.equal(refused.ok === false ? refused.code : "", "SITE_ID_RETIRED");

  const kept = new Map([[EARLIER_ID, OWNER]]);
  assert.equal((await decideSiteBind(EARLIER_ID, OWNER_CHECKSUMMED, published, kept)).ok, true);
  const stranger = await decideSiteBind(EARLIER_ID, STRANGER, published, kept);
  assert.equal(stranger.ok === false ? stranger.status : 0, 403);
});

// ── 3. the regression the fix most needs ─────────────────────────────────────

test("the owner is allowed even though the caller address is checksummed", async () => {
  // `parentAddress` arrives EIP-55 checksummed; a publish stamps ownerAddress
  // lowercase. Comparing them raw refuses every legitimate request — fail-closed,
  // but the feature is dead. Both sides must be lowercased.
  const d = await decideSiteBind(SITE_ID, OWNER_CHECKSUMMED, foundReaders(OWNER));
  assert.equal(d.ok, true);
});

test("a legacy config storing a checksummed owner also matches", async () => {
  // Older configs carry whatever form was written, so the comparison cannot
  // assume either side is already normalised.
  const d = await decideSiteBind(SITE_ID, OWNER, foundReaders(OWNER_CHECKSUMMED));
  assert.equal(d.ok, true);
});

// ── 4. the deliberate divergence from the publish gate ───────────────────────

test("an unpublished siteId is refused, not treated as bindable", async () => {
  // Publish LETS `absent` through — an unclaimed siteId is what publish is for.
  // Binding a hostname to a site that does not exist is not a real operation, so
  // this gate diverges on purpose. Pinned so nobody later "aligns" the two.
  const d = await decideSiteBind(SITE_ID, OWNER, readers());
  assert.equal(d.ok, false);
  assert.equal(d.ok === false ? d.status : 0, 404);
});

// ── 5 + 6. one target per entry ──────────────────────────────────────────────

test("re-pointing a domain from a site to an event clears the stale siteId", async () => {
  // An entry carrying BOTH ids is silently re-pointed by `updateDomainsForSite`,
  // which matches on siteId alone — so a hostname its owner deliberately moved to
  // an event gets dragged back to the site's content hash on that site's next
  // deploy. The store path is captured at module load, so chdir must precede the
  // import. `detectProvider` swallows DNS failures, so `.test` needs no network.
  const dir = mkdtempSync(join(tmpdir(), "woco-domains-test-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const svc = await import("../src/lib/domains/service.js");

    await svc.registerDomain("example.test", { siteId: "site-a" }, "feed-1", "hash-1", OWNER);
    const asEvent = await svc.registerDomain("example.test", { eventId: "event-b" }, "feed-2", "hash-2", OWNER);

    assert.equal(asEvent.eventId, "event-b");
    assert.equal(asEvent.siteId, undefined, "the stale siteId must not survive the re-point");

    // …and the site's next deploy must no longer reach it.
    await svc.updateDomainsForSite("site-a", "hash-3", "feed-3");
    const after = await svc.getDomainsForOwner(OWNER);
    const entry = after.find((d) => d.hostname === "example.test");
    assert.equal(entry?.contentHash, "hash-2", "a site deploy re-pointed a hostname it no longer owns");
  } finally {
    process.chdir(cwd);
  }
});
