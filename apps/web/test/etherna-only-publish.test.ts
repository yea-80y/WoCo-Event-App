/**
 * Sites, event pages and events are stored on Etherna, with no gateway to pick
 * (owner decision 2026-09-22), and event images try the gateway that stores them
 * first - Etherna holds a new image at once, other nodes only once it spreads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { imageUrlCandidates } from "../src/lib/components/site/image-fallback.js";

const WOCO = "https://gateway.woco-net.com";
const ETHERNA = "https://gateway.etherna.io";
const H = "ab".repeat(32);

test("an image stored on Etherna tries Etherna first, even where WoCo is preferred", () => {
  assert.deepEqual(imageUrlCandidates(H, WOCO, ETHERNA), [`${ETHERNA}/bytes/${H}`, `${WOCO}/bytes/${H}`]);
  assert.equal(imageUrlCandidates(H, WOCO, ETHERNA + "/")[0], `${ETHERNA}/bytes/${H}`);
});

test("a storage hint naming an unknown host is ignored, never fetched", () => {
  for (const hint of ["https://evil.example", "https://gateway.etherna.io.evil.example", "javascript:alert(1)"]) {
    const list = imageUrlCandidates(H, WOCO, hint);
    assert.equal(list[0], `${WOCO}/bytes/${H}`, hint);
    assert.ok(list.every((u) => u.startsWith(WOCO) || u.startsWith(ETHERNA)), hint);
  }
});

test("without a hint the order is what it was", () => {
  assert.deepEqual(imageUrlCandidates(H, WOCO), [`${WOCO}/bytes/${H}`, `${ETHERNA}/bytes/${H}`]);
});

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8");
}

test("neither builder offers a gateway choice; both use Etherna", () => {
  for (const f of ["../src/lib/creator/SiteBuilder.svelte", "../src/lib/creator/builder/MultiSiteBuilder.svelte"]) {
    const s = src(f);
    assert.doesNotMatch(s, /GatewayPicker/, f);
    assert.match(s, /const gatewayUrl\s*=\s*ETHERNA_GATEWAY_URL;/, f);
  }
});

test("the create-event form sends Etherna", () => {
  assert.match(src("../src/lib/creator/events/EventForm.svelte"), /<PublishButton\s+gatewayUrl=\{ETHERNA_GATEWAY_URL\}/);
});

test("the events list card falls back across gateways, starting where the image is stored", () => {
  const s = src("../src/lib/attendee/events/EventCard.svelte");
  assert.match(s, /src=\{firstImageUrl\(event\.imageHash, BEE_GATEWAY, event\.gatewayUrl\)\}/);
  assert.match(s, /onerror=\{\(e\) => useNextImageUrl\(e, event\.imageHash, BEE_GATEWAY, event\.gatewayUrl\)\}/);
});

test("the ticket canvas keeps WoCo first: a canvas read needs CORS, which Etherna does not send", () => {
  assert.match(src("../src/lib/attendee/events/TicketSuccess.svelte"), /imageUrlCandidates\(imageHash, BEE_GATEWAY\);/);
});
