/**
 * The image head start (image-head-start.ts): on a published page our gateway goes
 * first and the stored-on gateway is asked only if the first has not answered in
 * IMAGE_HEAD_START_MS. Off a published page (the app, the builder) there is no
 * second request at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { headStartPair, IMAGE_HEAD_START_MS } from "../src/lib/components/site/image-head-start.js";

const WOCO = "https://gateway.woco-net.com";
const ETHERNA = "https://gateway.etherna.io";
const H = "cd".repeat(32);

function withSiteConfig<T>(siteConfig: Record<string, unknown> | undefined, fn: () => T): T {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = siteConfig ? { SITE_CONFIG: siteConfig } : {};
  try {
    return fn();
  } finally {
    g.window = before;
  }
}

test("a published page races our gateway first, then the gateway that stores the image", () => {
  const pair = withSiteConfig({ contentGatewayUrl: WOCO, gatewayUrl: ETHERNA }, () =>
    headStartPair({ imageHash: H, preferredGateway: WOCO, storedOn: ETHERNA }),
  );
  assert.deepEqual(pair, { first: `${WOCO}/bytes/${H}`, second: `${ETHERNA}/bytes/${H}` });
});

test("off a published page there is no head start: the app and the builder never send a second request", () => {
  assert.equal(withSiteConfig(undefined, () => headStartPair({ imageHash: H, preferredGateway: WOCO, storedOn: ETHERNA })), null);
});

test("a page whose content gateway is not a known one gets no head start", () => {
  const pair = withSiteConfig({ contentGatewayUrl: "https://elsewhere.example", gatewayUrl: ETHERNA }, () =>
    headStartPair({ imageHash: H, storedOn: ETHERNA }),
  );
  assert.equal(pair, null);
});

test("no image, no head start", () => {
  assert.equal(withSiteConfig({ contentGatewayUrl: WOCO }, () => headStartPair({ imageHash: undefined })), null);
});

test("the head start is longer than our gateway's usual answer and shorter than Etherna's", () => {
  assert.ok(IMAGE_HEAD_START_MS >= 400 && IMAGE_HEAD_START_MS <= 900, String(IMAGE_HEAD_START_MS));
});

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf-8");
}

test("each published-page image gives the head start the same inputs as its fallback", () => {
  const page = src("../src/lib/components/site/EventPage.svelte");
  assert.match(page, /use:imageHeadStart=\{\{ imageHash: event\.imageHash, preferredGateway: BEE_GATEWAY, storedOn: event\.gatewayUrl \}\}\s*onerror=\{\(e\) => useNextImageUrl\(e, event\?\.imageHash, BEE_GATEWAY, event\?\.gatewayUrl\)\}/);
  const grid = src("../src/lib/components/site/sections/EventsGridSection.svelte");
  assert.match(grid, /use:imageHeadStart=\{\{ imageHash: ev\.imageHash, storedOn: ev\.gatewayUrl \}\}\s*onerror=\{\(e\) => useNextImageUrl\(e, ev\.imageHash, undefined, ev\.gatewayUrl\)\}/);
  const featured = src("../src/lib/components/site/sections/FeaturedEventSection.svelte");
  assert.match(featured, /use:imageHeadStart=\{\{ imageHash: event\.imageHash, preferredGateway: gatewayUrl, storedOn: event\.gatewayUrl \}\}\s*onerror=\{\(e\) => useNextImageUrl\(e, event\?\.imageHash, gatewayUrl, event\?\.gatewayUrl\)\}/);
});
