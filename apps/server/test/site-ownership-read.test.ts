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
import { siteConfigTopic } from "@woco/shared";
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

test("a legacy config with no ownerAddress is unavailable, not found (#246)", async () => {
  // It decodes, and it names the right site — so the old code returned it as
  // `found`. Each gate then did `site.ownerAddress.toLowerCase()`, which throws
  // on `undefined` and surfaced as a 500 with no line naming the cause.
  const ownerless = { siteId: SITE_ID, theme: { brandName: "x" }, pages: [] };
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "found", data: encodeJsonFeed(ownerless) }) }),
  );
  assert.equal(res.status, "unavailable");
  assert.match(res.status === "unavailable" ? res.reason : "", /no usable ownerAddress/);
});

test("an ownerAddress that is not an address is unavailable — there is nothing to compare", async () => {
  // A string that is not an address can never equal a verified parentAddress, so
  // returning it as `found` only ever produces a 403 that says "not the site
  // owner" about a record where ownership was never established.
  for (const bad of ["", "   ", "not-an-address", "0x", "0xdeadbeef"]) {
    const site = { siteId: SITE_ID, ownerAddress: bad, theme: { brandName: "x" }, pages: [] };
    const res = await resolveSiteConfig(
      SITE_ID,
      readers({ readConfigPage: async () => ({ status: "found", data: encodeJsonFeed(site) }) }),
    );
    assert.equal(res.status, "unavailable", `ownerAddress ${JSON.stringify(bad)} should be undecidable`);
  }
});

test("a pointer whose ownerAddress is empty is unavailable, not found", async () => {
  // `isSitePointer` only requires ownerAddress to be a STRING, so "" reaches the
  // assignment and would otherwise be handed to the gates.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "found", data: encodeJsonFeed({ ...pointer, ownerAddress: "" }) }),
      readPointerTarget: async () => ({ status: "found", bytes: bytesOf(legacySite()) }),
    }),
  );
  assert.equal(res.status, "unavailable");
  assert.match(res.status === "unavailable" ? res.reason : "", /pointer carries no usable ownerAddress/);
});

test("a well-formed config is still found — the guard is not refusing everything", async () => {
  // The non-vacuity check for the three above: a fix that refused every config
  // would pass all of them while making publish and deploy impossible.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "found", data: encodeJsonFeed(legacySite()) }) }),
  );
  assert.equal(res.status, "found");
  assert.equal(res.status === "found" ? res.site.ownerAddress : "", OWNER);
});

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
  // The REASON, not just the status. Asserting the status alone leaves this test
  // passing when the pointer branch never runs at all — the fixture then falls to
  // the legacy branch, fails its siteId check, and returns `unavailable` for a
  // different reason entirely. Only this branch emits this string (#217).
  assert.match(res.status === "unavailable" ? res.reason : "", /pointer target absent/);
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
  assert.match(res.status === "unavailable" ? res.reason : "", /pointer target unreadable/);
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
  assert.match(res.status === "unavailable" ? res.reason : "", /did not parse as JSON/);
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
  assert.match(res.status === "unavailable" ? res.reason : "", /names a different siteId/);
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

test("pages are merged when the pages feed has them", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite()) }),
      readPagesPage: async () => encodeJsonFeed({ pages: [{ id: "home" }] }),
    }),
  );
  assert.equal(res.status, "found");
  assert.deepEqual(res.status === "found" ? res.site.pages : null, [{ id: "home" }]);
});

test("a THROWING pages read stays non-fatal — pages are content, not ownership", async () => {
  // The previous version of this test overrode readPagesPage with the helper's own
  // default, so it asserted nothing the test above it did not. The case that
  // actually needs pinning is a reader that REJECTS: without the catch, the whole
  // resolve would reject and a legacy site would become a 500 over missing content.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite()) }),
      readPagesPage: async () => {
        throw new Error("pages feed unreachable");
      },
    }),
  );
  assert.equal(res.status, "found");
});

test("a THROWING config read is unavailable, not an exception", async () => {
  // Otherwise a rejecting reader is a fourth outcome and the tri-state is not
  // total: the function throws instead of returning one of its three answers.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => {
        throw new Error("reader exploded");
      },
    }),
  );
  assert.equal(res.status, "unavailable");
});

test("a legacy payload naming a different siteId is unavailable, not found", async () => {
  // Any decodable non-pointer JSON reaches the legacy branch — an unrecognised
  // future pointer version, an unrelated document, a config for another site. The
  // pointer branch already refuses those; this branch used to cast and return one.
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({
      readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite("a-different-site")) }),
    }),
  );
  assert.equal(res.status, "unavailable");
});

test("a decodable payload that is not a site config at all is unavailable", async () => {
  const res = await resolveSiteConfig(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed({ foo: 1 }) }) }),
  );
  assert.equal(res.status, "unavailable");
});

test("the readers are called with the right topic and the pointer's signer", async () => {
  // Nothing else asserts the ARGUMENTS. Without this, a mutant passing the wrong
  // owner or the wrong topic survives the suite: it fails closed in production
  // (wrong target → siteId mismatch → unavailable), so the takeover direction
  // stays shut, but the happy path would break with the tests still green.
  const seen: { configTopic?: string; ownerHex?: string; targetTopic?: string } = {};
  const res = await resolveSiteConfig(SITE_ID, {
    readConfigPage: async (topic) => {
      seen.configTopic = topic.toHex();
      return { status: "ok", data: encodeJsonFeed(pointer) };
    },
    readPointerTarget: async (ownerHex, baseTopic) => {
      seen.ownerHex = ownerHex;
      seen.targetTopic = baseTopic;
      return { status: "found", bytes: bytesOf(legacySite()), version: 0 };
    },
    readPagesPage: async () => null,
  });

  assert.equal(res.status, "found");
  assert.equal(seen.configTopic, Topic.fromString(siteConfigTopic(SITE_ID)).toHex());
  // The signer comes from the pointer, 0x-stripped — not from the caller.
  assert.equal(seen.ownerHex, SIGNER.replace(/^0x/, ""));
  assert.equal(seen.targetTopic, siteConfigTopic(SITE_ID));
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

test("resolveSiteConfigOrNull collapses BOTH failure answers to null", async () => {
  // Display paths legitimately show nothing. The point of the separate function is
  // that choosing to collapse is a visible call rather than the default.
  //
  // Injected, not left to the real readers: without that this ran against whatever
  // network happened to exist and returned null in every world — no bee, live bee,
  // and the reverted code alike — so it asserted only "did not crash" while being
  // the one test in the file that could hang on a blackholed port.
  const fromUnavailable = await resolveSiteConfigOrNull(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "error", error: new Error("bee timeout") }) }),
  );
  assert.equal(fromUnavailable, null);

  const fromAbsent = await resolveSiteConfigOrNull(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "absent" }) }),
  );
  assert.equal(fromAbsent, null);

  // And it still returns the site when there is one, so "collapses to null" is not
  // passing by refusing everything.
  const found = await resolveSiteConfigOrNull(
    SITE_ID,
    readers({ readConfigPage: async () => ({ status: "ok", data: encodeJsonFeed(legacySite()) }) }),
  );
  assert.equal(found?.site.siteId, SITE_ID);
});
