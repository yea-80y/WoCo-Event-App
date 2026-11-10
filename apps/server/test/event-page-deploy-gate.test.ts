/**
 * Only an event's creator publishes its page, and the page feed belongs to the
 * signer pinned at create - never the platform, never the request (#614, #679).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eventPageDeployGate, type PageDeployGateDeps } from "../src/lib/event/page-deploy-gate.js";

const CREATOR = "0x" + "aa".repeat(20);
const SIGNER = ("0x" + "bb".repeat(20)) as `0x${string}`;

function deps(record: { signer: string; creatorAddress: string } | null, healthy = true): PageDeployGateDeps {
  return {
    getRecord: () =>
      record ? { signer: record.signer as `0x${string}`, creatorAddress: record.creatorAddress as `0x${string}`, recordedAt: "" } : null,
    storeHealthy: () => healthy,
  };
}

test("the creator is let through, with the signer pinned at create", () => {
  const g = eventPageDeployGate("e1", CREATOR.toUpperCase().replace("0X", "0x"), deps({ signer: SIGNER, creatorAddress: CREATOR }));
  assert.deepEqual(g, { ok: true, signer: SIGNER });
});

test("anyone else is refused (#679)", () => {
  const g = eventPageDeployGate("e1", "0x" + "cc".repeat(20), deps({ signer: SIGNER, creatorAddress: CREATOR }));
  assert.equal(g.ok, false);
  assert.equal(!g.ok && g.status, 403);
});

test("an event with no record is refused - the platform publishes no page feed of its own", () => {
  const g = eventPageDeployGate("e1", CREATOR, deps(null));
  assert.equal(!g.ok && g.status, 404);
});

test("an unreadable record store is 'try again', not 'recreate your event'", () => {
  const g = eventPageDeployGate("e1", CREATOR, deps(null, false));
  assert.equal(!g.ok && g.status, 503);
});

// ---------------------------------------------------------------------------
// The route, pinned at source: running it means uploading a page to Etherna.
// ---------------------------------------------------------------------------

const file = readFileSync(new URL("../src/routes/site.ts", import.meta.url), "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");
/** The deploy route itself (the page-config route above it also gates). */
const route = file.slice(file.indexOf('site.post("/deploy"'));

test("the page deploy never signs a feed with the platform key", () => {
  for (const gone of ["getPlatformSigner", "getPlatformOwner", "writeEthernaFeedUpdate", "makeFeedWriter", "uploadReference"]) {
    assert.ok(!file.includes(gone), `site.ts must not use ${gone}`);
  }
});

test("the creator gate runs before anything is uploaded", () => {
  const gate = route.indexOf("pageGate(eventId, parentAddress)");
  const upload = route.indexOf("uploadSiteObjects(");
  assert.ok(gate > 0 && upload > 0 && gate < upload);
  // The gate the route calls is the creator gate unless a test swaps it.
  assert.match(file, /let pageGate = eventPageDeployGate;/);
});

test("the page feed is prepared only for a signing client, owned by the pinned signer", () => {
  assert.match(route, /let pageIndex: bigint \| null = null;\s*if \(body\.clientFeed === true\) \{/);
  assert.match(route, /const pageOwnerHex = gate\.signer\.replace/);
  assert.match(route, /if \(body\.clientFeed === true && pageIndex !== null\) \{/);
  assert.match(route, /pageFeed = \{ owner: gate\.signer, nextIndex: /);
  // The manifest is the pinned signer's feed's, stored by us (#912 slice 2b).
  assert.match(route, /feedManifestHash = await storeFeedManifest\(store, pageOwnerHex, pageTopic\.toHex\(\)\);/);
  // Declared empty; the only assignment of a manifest is the client-owned branch.
  assert.match(route, /let feedManifestHash = "";/);
  assert.equal(route.match(/^\s+feedManifestHash = /gm)?.length, 1);
});

test("the page feed's index is resolved before the page is uploaded, once (#943)", () => {
  // After the upload, a refusal there cost the whole upload - and the retry did it again.
  const resolve = route.indexOf("await resolveFeedNextIndex(");
  const upload = route.indexOf("uploadSiteObjects(");
  assert.ok(resolve > 0 && upload > resolve);
  assert.equal(route.match(/resolveFeedNextIndex\(|prepareEthernaFeed(Index|Update)\(/g)?.length, 1, "no second resolution after the upload");
  // An index nobody can settle refuses with a typed 503 before anything is stored.
  assert.ok(route.indexOf("feedIndexUnavailableBody()") > resolve && route.indexOf("feedIndexUnavailableBody()") < upload);
});

test("the carrier baked into the page comes from the same record, never the request", () => {
  assert.match(route, /pageConfig\(apiUrl, eventId, gate\.signer\)/);
  assert.ok(!file.includes("getCreatorEvents"));
  // The deploy reads nothing of the event: the head comes from the browser, format-checked.
  assert.ok(!route.includes("getEvent("), "the deploy route must not read the event");
  assert.match(route, /const head = parseEventPageHead\(body\.head\);/);
});
