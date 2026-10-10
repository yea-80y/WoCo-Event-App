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

const route = readFileSync(new URL("../src/routes/site.ts", import.meta.url), "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

test("the page deploy never signs a feed with the platform key", () => {
  for (const gone of ["getPlatformSigner", "getPlatformOwner", "writeEthernaFeedUpdate", "makeFeedWriter", "uploadReference"]) {
    assert.ok(!route.includes(gone), `site.ts must not use ${gone}`);
  }
});

test("the creator gate runs before anything is uploaded", () => {
  const gate = route.indexOf("eventPageDeployGate(eventId, parentAddress)");
  const upload = route.indexOf("uploadCollectionToEtherna(");
  assert.ok(gate > 0 && upload > 0 && gate < upload);
});

test("the page feed is prepared only for a signing client, owned by the pinned signer", () => {
  assert.match(route, /if \(body\.clientFeed === true\) \{\s*const prep = await prepareEthernaFeedUpdate\(/);
  assert.match(route, /ownerHex: gate\.signer\.replace/);
  assert.match(route, /owner: gate\.signer,/);
  // Declared empty; the only assignment of a manifest is the client-owned branch.
  assert.match(route, /let feedManifestHash = "";/);
  assert.equal(route.match(/^\s+feedManifestHash = /gm)?.length, 1);
});

test("the carrier baked into the page comes from the same record", () => {
  assert.match(route, /const eventSigner = gate\.signer;/);
  assert.ok(!route.includes("getCreatorEvents"));
});
