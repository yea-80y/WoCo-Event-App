/**
 * New events are stored on Etherna, and an event's recorded gateway is only ever
 * one of ours (owner decision 2026-09-22).
 *
 * The recorded `gatewayUrl` now steers which host every viewer's browser asks
 * for the event image first, and a Phase B event feed is organiser-signed. So
 * the create path refuses an unknown host, and the listing card copies only the
 * canonical Etherna URL - never the feed's own string.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventFeed } from "@woco/shared";

// listing-state (imported by the card builder) pins DATA_DIR at import: isolate it.
let cardFromFeed: typeof import("../src/lib/event/directory-snapshot.js").cardFromFeed;
let createEventV2: typeof import("../src/lib/event/service.js").createEventV2;
let ETHERNA_URL: string;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-etherna-only-")));
  ({ cardFromFeed } = await import("../src/lib/event/directory-snapshot.js"));
  ({ createEventV2 } = await import("../src/lib/event/service.js"));
  ({ ETHERNA_URL } = await import("../src/lib/etherna/batch-router.js"));
});

function feed(gatewayUrl?: string): EventFeed {
  return {
    eventId: "e1",
    title: "T",
    imageHash: "ab".repeat(32),
    startDate: "2026-10-01T18:00:00Z",
    location: "Somewhere",
    creatorAddress: "0x" + "11".repeat(20),
    series: [],
    createdAt: "2026-09-22T00:00:00Z",
    ...(gatewayUrl !== undefined ? { gatewayUrl } : {}),
  } as unknown as EventFeed;
}

test("a card records Etherna storage as the canonical URL", () => {
  assert.equal(cardFromFeed(feed(ETHERNA_URL)).gatewayUrl, ETHERNA_URL);
  assert.equal(cardFromFeed(feed(ETHERNA_URL + "/")).gatewayUrl, ETHERNA_URL);
});

test("a card never carries a foreign host, and WoCo or none means absent", () => {
  for (const g of ["https://evil.example", "https://gateway.etherna.io.evil.example", "https://gateway.woco-net.com", "", undefined]) {
    assert.equal(cardFromFeed(feed(g)).gatewayUrl, undefined, String(g));
  }
});

function createWith(gatewayUrl?: string) {
  return createEventV2({
    eventId: "e1",
    title: "T",
    startDate: "2026-10-01T18:00:00Z",
    creatorAddress: "0x" + "11".repeat(20),
    imageData: "",
    series: [],
    ...(gatewayUrl !== undefined ? { gatewayUrl } : {}),
  } as unknown as Parameters<typeof createEventV2>[0]);
}

test("create refuses a gateway that is not ours, before touching storage", async () => {
  await assert.rejects(createWith("https://evil.example"), /gatewayUrl must be the Etherna or WoCo gateway/);
});

test("create with no gateway routes to Etherna, not the WoCo batch", async () => {
  // No user batch in the temp data dir and no platform batch configured, so the
  // Etherna route fails on ITS OWN precondition - which it only reaches if chosen.
  const saved = process.env.ETHERNA_PLATFORM_BATCH;
  delete process.env.ETHERNA_PLATFORM_BATCH;
  try {
    await assert.rejects(createWith(), /ETHERNA_PLATFORM_BATCH not configured/);
  } finally {
    if (saved !== undefined) process.env.ETHERNA_PLATFORM_BATCH = saved;
  }
});

test("the stored gateway is the canonical Etherna URL, never the request's string", () => {
  const src = readFileSync(new URL("../src/lib/event/service.ts", import.meta.url), "utf-8");
  assert.match(src, /\.\.\.\(onEtherna \? \{ gatewayUrl: ETHERNA_URL \} : \{\}\)/);
  assert.doesNotMatch(src, /\?\s*\{\s*gatewayUrl\s*\}\s*:/, "the request's gatewayUrl must not be stored as given");
});
