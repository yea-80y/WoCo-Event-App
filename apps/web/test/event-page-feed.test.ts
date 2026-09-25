/**
 * The browser signs an event page's feed update only for its own key and only
 * over the page that was deployed, and a name follows that feed only once the
 * update is signed (#614). Pinned at source: running these means a live deploy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8");
}

function body(file: string, fn: string): string {
  const s = src(file);
  const start = s.indexOf(`export async function ${fn}`);
  assert.ok(start > 0, `${fn} not found`);
  const next = s.indexOf("\nexport ", start + 10);
  return s.slice(start, next > 0 ? next : undefined);
}

test("deployEventPage checks the owner, then the bytes, then signs", () => {
  const b = body("../src/lib/api/sites.ts", "deployEventPage");
  const owner = b.indexOf("pageFeed.owner.toLowerCase() !== feedSigner.address.toLowerCase()");
  const bytes = b.indexOf("assertFeedUpdateMatches(payload, res.data.contentHash)");
  const sign = b.indexOf("signAndUploadSoc(");
  assert.ok(owner > 0 && bytes > owner && sign > bytes, "owner check, then content check, then sign");
  assert.match(b, /beeFeedUpdateIdentifier\(eventPageFeedTopic\(eventId\), pageFeed\.nextIndex\)/);
  assert.match(b, /return \{ \.\.\.res, feedSigned: true \}/);
});

test("deploySite checks the bytes before it signs, too", () => {
  const b = body("../src/lib/api/sites.ts", "deploySite");
  const bytes = b.indexOf("assertFeedUpdateMatches(payload, res.data.contentHash)");
  const sign = b.indexOf("signAndUploadSoc(");
  assert.ok(bytes > 0 && sign > bytes);
});

test("the event builder binds a name to the feed only after its own update was signed", () => {
  const s = src("../src/lib/creator/SiteBuilder.svelte");
  assert.match(s, /deployResult\.feedOwner === "client" && deployResult\.feedSigned && !!deployResult\.feedManifestHash/);
  assert.match(s, /target=\{pointerTarget\}\s*targetIsFeed=\{pointerFollowsFeed\}/);
  assert.ok(!s.includes("target={deployResult.contentHash}"), "the target is chosen, not fixed");
});
