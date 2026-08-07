/**
 * "I could not read the site config" is not "there is no such site" (#181).
 *
 * The two ownership gates — publish and deploy — ask `resolveSiteConfig` whether a
 * siteId already belongs to someone. It answered with `null` for six different
 * reasons, only one of which meant "nobody owns this", and the gates read `null`
 * as permission to proceed. So one failed Swarm read let any authenticated caller
 * be stamped owner of an existing site, take over its `woco-multisite-{siteId}`
 * feed, and re-point the custom domains resolving through it. Nothing to race:
 * retry until a read fails.
 *
 * These tests enumerate every way the read can fail and assert it reports
 * `unavailable` rather than `absent`. The distinction only matters on the failure
 * paths, which is why the readers are injected — a live Swarm read cannot be made
 * to fail on demand.
 *
 * The one case that is genuinely `absent` — a feed the network positively reports
 * as never written — is tested too, because a fix that refused everything would
 * pass all the others while making the product unusable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Topic } from "@ethersphere/bee-js";
import type { Site } from "@woco/shared";

import {
  resolveSiteConfig,
  resolveSiteConfigOrNull,
  type SiteConfigReaders,
} from "../src/lib/site/service.js";
import { encodeJsonFeed } from "../src/lib/swarm/feeds.js";

const SITE_ID = "site-under-test";
const OWNER = "0xAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaAAaA";
const SIGNER = "0xbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBbBBb";

function readers(over: Partial<SiteConfigReaders> = {}): SiteConfigReaders {
  return {
    readConfigPage: async () => ({ status: "absent" }),
    readPointerTarget: async () => ({ status: "absent" }),
    readPagesPage: async () => null,
    ...over,
  };
}

const legacySite = (id = SITE_ID): Site =>
  ({ siteId: id, ownerAddress: OWNER, theme: { brandName: "x" }, pages: [] }) as unknown as Site;

const pointer = {
  _woco_site_ptr: 1,
  ownerAddress: OWNER,
  siteFeedSigner: SIGNER,
  updatedAt: 1,
};

const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

// ── The one answer that permits a write ──────────────────────────────────────

test("a feed the network reports as never written is absent", async () => {
  const res = await resolveSiteConfig(SITE_ID, readers({ readConfigPage: async () => ({ status: "absent" }) }));
  assert.equal(res.status, "absent");
});

// ── Everything else must refuse ──────────────────────────────────────────────

test("a failed config read is unavailable, not absent", async () => {
  // The sharpest case: this is the one a caller can provoke by retrying.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "error", error: new Error("bee timeout") }) }),
  );
  assert.equal(res.status, "unavailable");
  assert.match(res.status === "unavailable" ? res.reason : "", /config feed read failed/);
});

test("bytes that will not decode are unavailable — something is there", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "ok", data: new Uint8Array(4096) }) }),
  );
  assert.equal(res.status, "unavailable");
});

test("an unreadable pointer target is unavailable", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(pointer) }),
      readPointerTarget: async () => ({ status: "unavailable", reason: "chunk not retrievable" }),
    }),
  );
  assert.equal(res.status, "unavailable");
  assert.match(res.status === "unavailable" ? res.reason : "", /pointer target unreadable/);
});

test("a pointer whose target is ABSENT is unavailable, not absent", async () => {
  // A pointer existing proves a site was published. Its target being missing is an
  // inconsistency to refuse on — reporting "absent" here would hand the siteId to
  // the next caller.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(pointer) }),
      readPointerTarget: async () => ({ status: "absent" }),
    }),
  );
  assert.equal(res.status, "unavailable");
});

test("a pointer target that throws is unavailable", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(pointer) }),
      readPointerTarget: async () => {
        throw new Error("network down");
      },
    }),
  );
  assert.equal(res.status, "unavailable");
});

test("a pointer target that is not JSON is unavailable", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(pointer) }),
      readPointerTarget: async () => ({ status: "found", bytes: new TextEncoder().encode("{ nope"), version: 0 }),
    }),
  );
  assert.equal(res.status, "unavailable");
});

test("a pointer target naming a DIFFERENT siteId is unavailable", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(pointer) }),
      readPointerTarget: async () => ({ status: "found", bytes: bytesOf(legacySite("someone-elses-site")), version: 0 }),
    }),
  );
  assert.equal(res.status, "unavailable");
});

// ── The happy paths still work ───────────────────────────────────────────────

test("a legacy platform-written site resolves", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite()) }) }),
  );
  assert.equal(res.status, "found");
  assert.equal(res.status === "found" ? res.site.siteId : "", SITE_ID);
});

test("a failed PAGES read stays non-fatal — pages are content, not ownership", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite()) }),
      readPagesPage: async () => null,
    }),
  );
  assert.equal(res.status, "found");
});

test("a pointer site resolves, and ownership comes from the POINTER", async () => {
  // The payload is client-signed, so its ownerAddress is a claim. The pointer is
  // server-stamped. A gate that trusted the payload would take the caller's word.
  const claimedByPayload = { ...legacySite(), ownerAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" };
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(pointer) }),
      readPointerTarget: async () => ({ status: "found", bytes: bytesOf(claimedByPayload), version: 0 }),
    }),
  );
  assert.equal(res.status, "found");
  assert.equal(res.status === "found" ? res.site.ownerAddress : "", OWNER);
  assert.equal(res.status === "found" ? res.siteFeedSigner : "", SIGNER);
});

// ── The display collapse is still available, and still a collapse ────────────

test("resolveSiteConfigOrNull collapses both failure answers to null", async () => {
  // Display paths legitimately show nothing. The point of the separate function is
  // that choosing to collapse is now visible at the call site instead of built in.
  assert.equal(await resolveSiteConfigOrNull("no-such-site-anywhere"), null);
});
