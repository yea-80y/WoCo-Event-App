/**
 * The real read path, run against a faked network (#658).
 *
 * Until `probeSoc` left the auth-bound client module, nothing that reached it
 * could load under this runner, so the content-feed readers were proven only by
 * types and source pins. Now the REAL readers and the REAL probe run here; only
 * `fetch` is replaced, answering as our gateway (`GET /chunks/{address}`) and our
 * server (`GET /api/swarm/soc/{owner}/{id}?gatewayUrl=`) would. Chunks are genuine
 * signed SOCs, so the signature check is exercised on both sources.
 *
 * The network model lives in fake-swarm-net.ts.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { contentFeedSocIdentifier, versionedSocIdentifier } from "@woco/shared";
import { probeSoc } from "../src/lib/swarm/probe-soc.js";
import { readBandedContentFeed, readContentFeedAtVersion, readContentFeedResult } from "../src/lib/swarm/content-feed.js";
import { ETHERNA_GATEWAY_URL, FEED_ROUTES, WOCO_ROUTE } from "../src/lib/swarm/gateways.js";
import {
  OTHER_KEY,
  OWNER,
  clearRequests,
  gatewayParam,
  install,
  requests,
  resetNet,
  restoreNet,
  serverRequests,
  soc,
  socBytes,
  type Net,
} from "./fake-swarm-net.js";

const TOPIC = "woco/test/probe";
const at = (v: number, topic = TOPIC) => versionedSocIdentifier(contentFeedSocIdentifier(topic), v);

beforeEach(resetNet);
afterEach(restoreNet);

/** Version 0 everywhere; version 1 was just written through Etherna. */
function savedMomentsAgo(): Net {
  const v0 = soc(at(0), { v: 0 });
  const v1 = soc(at(1), { v: 1 });
  return { ourBee: new Map([[v0.address, v0]]), etherna: new Map([[v0.address, v0], [v1.address, v1]]) };
}

// ---------------------------------------------------------------------------
// The route reaches the wire
// ---------------------------------------------------------------------------

test("an Etherna-routed read asks the server WITH Etherna, and finds the version just written", async () => {
  install(savedMomentsAgo());
  const res = await readContentFeedResult<{ v: number }>(OWNER, TOPIC, { route: FEED_ROUTES.profile, thorough: true });
  assert.equal(res.status, "found");
  assert.equal((res as { version: number }).version, 1);
  assert.ok(serverRequests().length > 0, "the thorough read reached the server");
  for (const u of serverRequests()) assert.equal(gatewayParam(u), ETHERNA_GATEWAY_URL, u);
});

test("a WoCo-routed read of the same feed returns the PREVIOUS version, marked clean - the #651 hazard, in the real code", async () => {
  install(savedMomentsAgo());
  const res = await readContentFeedResult<{ v: number }>(OWNER, TOPIC, { route: WOCO_ROUTE, thorough: true });
  assert.equal(res.status, "found");
  assert.equal((res as { version: number }).version, 0);
  assert.equal((res as { scanClean: boolean }).scanClean, true);
  for (const u of serverRequests()) assert.notEqual(gatewayParam(u), ETHERNA_GATEWAY_URL, u);
});

test("the device that just wrote (hint = 1) still needs the route: without it the hint reads absent and the scan falls back", async () => {
  // readContentFeedResult stores the hint it resolves; seed the writer's hint first.
  install(savedMomentsAgo());
  await readContentFeedResult(OWNER, TOPIC, { route: FEED_ROUTES.profile, thorough: true });
  clearRequests();
  const again = await readContentFeedResult<{ v: number }>(OWNER, TOPIC, { route: FEED_ROUTES.profile, thorough: true });
  assert.equal((again as { version: number }).version, 1);
  const stale = await readContentFeedResult<{ v: number }>(OWNER, TOPIC, { route: WOCO_ROUTE, thorough: true });
  assert.equal((stale as { version: number }).version, 0);
});

test("the exact-version and banded readers carry their route on every server request", async () => {
  const band0 = (b: number) => `woco/test/banded/b${b}`;
  const v0 = soc(at(0, band0(0)), { band: 0 });
  install({ ourBee: new Map(), etherna: new Map([[v0.address, v0]]) });

  const exact = await readContentFeedAtVersion<{ band: number }>(OWNER, band0(0), 0, { route: FEED_ROUTES.profile, thorough: true });
  assert.equal(exact.status, "found");

  const banded = await readBandedContentFeed<{ band: number }>(OWNER, band0, { route: FEED_ROUTES.profile, thorough: true });
  assert.equal(banded.status, "found");

  assert.ok(serverRequests().length >= 2);
  for (const u of serverRequests()) assert.equal(gatewayParam(u), ETHERNA_GATEWAY_URL, u);
});

test("Etherna unreachable: a routed read cannot vouch for the newest version, and says so", async () => {
  install({ ...savedMomentsAgo(), ethernaDown: true });
  const res = await readContentFeedResult(OWNER, TOPIC, { route: FEED_ROUTES.profile, thorough: true });
  // Version 0 is readable from our bee, but the scan could not rule version 1 out.
  assert.ok(res.status === "unavailable" || (res.status === "found" && !res.scanClean), JSON.stringify(res));
});

test("bytes that are not JSON are called unusable only when the scan could confirm they are the head (#689)", async () => {
  const junk = socBytes(at(0), new TextEncoder().encode("not json"));
  const v1 = soc(at(1), { v: 1 });
  install({ ourBee: new Map([[junk.address, junk]]), etherna: new Map([[v1.address, v1]]), ethernaDown: true });
  const blind = await readContentFeedResult(OWNER, TOPIC, { route: FEED_ROUTES.profile, thorough: true });
  assert.equal(blind.status, "unavailable");
  assert.equal((blind as { unusableAt?: number }).unusableAt, undefined, "version 1 may be the head");

  install({ ourBee: new Map([[junk.address, junk]]), etherna: new Map() });
  const alone = await readContentFeedResult(OWNER, TOPIC, { route: FEED_ROUTES.profile, thorough: true });
  assert.equal((alone as { unusableAt?: number }).unusableAt, 0);
});

// ---------------------------------------------------------------------------
// The probe's gateway step behaves as the bee-js reader did
// ---------------------------------------------------------------------------

test("a valid chunk from our gateway is found with no server request", async () => {
  const c = soc(at(0), { ok: 1 });
  install({ ourBee: new Map([[c.address, c]]), etherna: new Map() });
  const res = await probeSoc(OWNER, at(0), { thorough: true, gatewayUrl: ETHERNA_GATEWAY_URL });
  assert.equal(res.status, "found");
  assert.deepEqual(serverRequests(), []);
});

test("a gateway 404 is a verdict for a display read, and asked about again for a thorough one", async () => {
  install({ ourBee: new Map(), etherna: new Map() });
  assert.equal((await probeSoc(OWNER, at(0))).status, "absent");
  assert.deepEqual(serverRequests(), []);
  assert.equal((await probeSoc(OWNER, at(0), { thorough: true })).status, "absent");
  assert.equal(serverRequests().length, 1);
});

test("our gate's 403 is a verdict for a display read - by its header alone, or its body code alone", async () => {
  const cases: Array<[string, () => Response]> = [
    ["header only", () => new Response("Forbidden", { status: 403, headers: { "X-Chunk-Gate": "not-whitelisted" } })],
    ["body code only", () => new Response(JSON.stringify({ error: "denied", code: "NOT_WHITELISTED" }), { status: 403 })],
  ];
  for (const [label, denial] of cases) {
    clearRequests();
    install({ ourBee: new Map(), etherna: new Map(), gateway: () => denial() });
    assert.equal((await probeSoc(OWNER, at(0))).status, "absent", label);
    assert.deepEqual(serverRequests(), [], `${label}: a verdict needs no server`);
  }
});

test("a thorough read asks the server even after our gate refused", async () => {
  const tagged = () => new Response("Forbidden", { status: 403, headers: { "X-Chunk-Gate": "not-whitelisted" } });
  install({ ourBee: new Map(), etherna: new Map(), gateway: () => tagged() });
  await probeSoc(OWNER, at(0), { thorough: true });
  assert.equal(serverRequests().length, 1);
});

test("anything else from the gateway is not an answer: an untagged 403, a 5xx, a 200 that is not a SOC", async () => {
  const cases: Array<[string, () => Response]> = [
    ["untagged 403", () => new Response("Forbidden", { status: 403 })],
    ["502", () => new Response("Bad Gateway", { status: 502 })],
    ["200, not a SOC", () => new Response(new Uint8Array([1, 2, 3]))],
  ];
  for (const [label, answer] of cases) {
    clearRequests();
    install({ ourBee: new Map(), etherna: new Map(), gateway: () => answer() });
    await probeSoc(OWNER, at(0));
    assert.equal(serverRequests().length, 1, `${label} falls through to the server`);
  }
});

test("a malformed owner never reaches the gateway, and reads as unavailable - as it did through bee-js", async () => {
  install({ ourBee: new Map(), etherna: new Map() });
  for (const bad of ["abc", "zz".repeat(20)]) {
    clearRequests();
    const res = await probeSoc(bad, at(0));
    assert.equal(res.status, "unavailable", bad);
    assert.deepEqual(requests.filter((u) => u.includes("/chunks/")), [], `${bad}: no garbage address probed`);
  }
});

test("a chunk our gateway serves but the owner did not sign is never found from it", async () => {
  const real = soc(at(0), { real: true });
  const forged = soc(at(0), { forged: true }, OTHER_KEY);
  install({
    ourBee: new Map([[real.address, real]]),
    etherna: new Map(),
    // The gateway serves the forgery at the owner's address; the server has the real one.
    gateway: (address) => (address === real.address ? new Response(forged.raw) : undefined),
  });
  const res = await probeSoc(OWNER, at(0));
  assert.equal(res.status, "found");
  assert.equal(new TextDecoder().decode((res as { bytes: Uint8Array }).bytes), JSON.stringify({ real: true }));
  assert.equal(serverRequests().length, 1, "the forgery sent the probe to the server");
});

test("a gateway that cannot be reached sends the probe to the server", async () => {
  const c = soc(at(0), { ok: 1 });
  install({ ourBee: new Map([[c.address, c]]), etherna: new Map(), gateway: () => "throw" });
  const res = await probeSoc(OWNER, at(0));
  assert.equal(res.status, "found");
  assert.equal(serverRequests().length, 1);
});
