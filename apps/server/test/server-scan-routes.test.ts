/**
 * The server's own feed scans ask the stores their FAMILY names (#657) - run for
 * real: the live readers (`readContentFeedJsonResult`, the banded walk, the
 * client fallback's `readVerifiedSoc`) against a faked bee, Etherna gateway and
 * Etherna SSO behind `fetch`, with SOCs signed the way clients sign them.
 *
 * What the old reader did, and these pin against: every scan asked our bee and,
 * on a bee miss, Etherna - whatever the family - and answered "absent" whenever
 * Etherna could not answer. So a scan of an Etherna-stamped feed during an
 * Etherna blip stopped at the previous version and called it CLEAN: the shape
 * that lets the campaign issuer countersign a referral whose retraction sits in
 * Etherna's store. And a WoCo feed paid an Etherna request on every miss.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@ethersphere/bee-js";
import {
  calculateCacAddress,
  calculateSocAddress,
  contentFeedSocIdentifier,
  encodeSpan,
  eventContentTopic,
  likeStatementTopic,
  versionedSocIdentifier,
  type Hex0x,
} from "@woco/shared";

// Hosts no test can reach for real. ETHERNA_GATEWAY_URL deliberately points
// somewhere that is NOT the canonical Etherna host: routing must not care.
const BEE = "http://bee.test";
const ETHERNA_BASE = "http://etherna-fetch.test";
const SSO = "http://sso.test/token";
process.env.BEE_URL = BEE;
process.env.PROXY_URL = "http://proxy.test";
process.env.UPLOAD_SECRET = "s";
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.ETHERNA_GATEWAY_URL = ETHERNA_BASE;
process.env.ETHERNA_TOKEN_ENDPOINT = SSO;

// Type-only: erased at runtime, so they cannot load a module before the chdir.
type SocUpload = typeof import("../src/lib/swarm/soc-upload.js");
type SocRead = typeof import("../src/lib/swarm/soc-read.js");
type Gateway = typeof import("../src/lib/etherna/gateway.js");
type Indexer = typeof import("../src/lib/social/indexer.js");
type Participants = typeof import("../src/lib/social/participants.js");
type EventService = typeof import("../src/lib/event/service.js");
type FeedSignerRecord = typeof import("../src/lib/event/feed-signer-record.js");
let up: SocUpload;
let rd: SocRead;
let gw: Gateway;
let indexer: Indexer;
let participants: Participants;
let events: EventService;
let signerRecord: FeedSignerRecord;

// ---------------------------------------------------------------------------
// The fake network
// ---------------------------------------------------------------------------

type Mode = "up" | "503" | "500" | "throw";
const net = {
  bee: new Map<string, Uint8Array>(),
  etherna: new Map<string, Uint8Array>(),
  beeMode: "up" as Mode,
  ethernaMode: "up" as Mode,
  /** Addresses our bee answers 503 for, whatever the mode. */
  beeFaulty: new Set<string>(),
  requests: { bee: 0, etherna: 0, sso: 0 },
};

const realFetch = globalThis.fetch;

function answer(store: Map<string, Uint8Array>, mode: Mode, address: string): Response {
  if (mode === "throw") throw new TypeError("fetch failed");
  if (mode === "503") return new Response("unavailable", { status: 503 });
  if (mode === "500") return new Response('{"code":500,"message":"read chunk failed"}', { status: 500 });
  const raw = store.get(address);
  return raw
    ? new Response(raw, { status: 200 })
    : new Response('{"code":404,"message":"chunk not found"}', { status: 404 });
}

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const chunk = url.pathname.match(/^\/chunks\/([0-9a-f]{64})$/);
  if (url.origin === BEE && chunk) {
    net.requests.bee++;
    return Promise.resolve(answer(net.bee, net.beeFaulty.has(chunk[1]!) ? "503" : net.beeMode, chunk[1]!));
  }
  if (url.origin === ETHERNA_BASE) {
    net.requests.etherna++;
    if (chunk) {
      try {
        return Promise.resolve(answer(net.etherna, net.ethernaMode, chunk[1]!));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve(new Response("{}", { status: 200 })); // offer registration
  }
  if (url.href === SSO) {
    net.requests.sso++;
    return Promise.resolve(Response.json({ access_token: "tok", expires_in: 3600 }));
  }
  // The proxy's whitelist self-heal, fire-and-forget.
  return Promise.resolve(new Response("{}", { status: 200 }));
}

// ---------------------------------------------------------------------------
// Signed SOCs, as stored: identifier ‖ signature ‖ span ‖ payload
// ---------------------------------------------------------------------------

const SIGNER = new PrivateKey("0x" + "33".repeat(32));
const OWNER = SIGNER.publicKey().address().toHex().replace(/^0x/, "").toLowerCase();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function storedSoc(identifier: Uint8Array, text: string): { address: string; raw: Uint8Array } {
  const payload = new TextEncoder().encode(text);
  const span = encodeSpan(payload.length);
  const sig = (SIGNER.sign(new Uint8Array([...identifier, ...calculateCacAddress(span, payload)])) as unknown as {
    toUint8Array(): Uint8Array;
  }).toUint8Array();
  const raw = new Uint8Array([...identifier, ...sig, ...span, ...payload]);
  return { address: hex(calculateSocAddress(identifier, Buffer.from(OWNER, "hex"))), raw };
}

/** Put version `v` of `topic` in the named stores. */
function put(topic: string, v: number, text: string, where: Array<"bee" | "etherna">): void {
  const { address, raw } = storedSoc(versionedSocIdentifier(contentFeedSocIdentifier(topic), v), text);
  for (const w of where) net[w].set(address, raw);
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
let n = 0;
/** A fresh topic per test: the version cache is process-wide. */
const topic = () => `woco/test/657/${++n}`;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-657-scan-")));
  globalThis.fetch = fakeFetch as typeof fetch;
  up = await import("../src/lib/swarm/soc-upload.js");
  rd = await import("../src/lib/swarm/soc-read.js");
  gw = await import("../src/lib/etherna/gateway.js");
  indexer = await import("../src/lib/social/indexer.js");
  participants = await import("../src/lib/social/participants.js");
  events = await import("../src/lib/event/service.js");
  signerRecord = await import("../src/lib/event/feed-signer-record.js");
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  net.bee.clear();
  net.etherna.clear();
  net.beeMode = "up";
  net.ethernaMode = "up";
  net.beeFaulty.clear();
  net.requests = { bee: 0, etherna: 0, sso: 0 };
});

// ---------------------------------------------------------------------------
// WoCo families never wait on Etherna
// ---------------------------------------------------------------------------

test("a WoCo-routed scan: bee 404 is the verdict, and Etherna is never asked", async () => {
  const t = topic();
  put(t, 0, "v0", ["bee"]);
  const res = await up.readContentFeedJsonResult(OWNER, t, "referral", { skipLegacy: true });
  assert.equal(res.status, "found");
  if (res.status !== "found") return;
  assert.equal(decode(res.bytes), "v0");
  assert.equal(res.version, 0);
  assert.equal(res.scanClean, true);
  assert.equal(net.requests.etherna, 0, "no Etherna chunk read");
  assert.equal(net.requests.sso, 0, "no Etherna token either");

  const empty = await up.readContentFeedJsonResult(OWNER, topic(), "credits", { skipLegacy: true });
  assert.equal(empty.status, "absent");
  assert.equal(net.requests.etherna, 0);
});

test("a WoCo-routed scan with Etherna DOWN is still clean - it never depended on it", async () => {
  net.ethernaMode = "503";
  const t = topic();
  put(t, 0, "v0", ["bee"]);
  put(t, 1, "v1", ["bee"]);
  const res = await up.readContentFeedJsonResult(OWNER, t, "campaignIssuer", { skipLegacy: true });
  assert.equal(res.status, "found");
  if (res.status !== "found") return;
  assert.equal(res.version, 1);
  assert.equal(res.scanClean, true);
  assert.equal(net.requests.etherna, 0);
});

test("a bee fault is unavailable, never absent - the old reader called bee's 500 a miss", async () => {
  net.beeMode = "500";
  const res = await up.readContentFeedJsonResult(OWNER, topic(), "referral", { skipLegacy: true });
  assert.equal(res.status, "unavailable");
});

// ---------------------------------------------------------------------------
// Etherna families ask Etherna, and say so when it cannot answer
// ---------------------------------------------------------------------------

test("an Etherna-routed scan finds a version our bee has not received yet", async () => {
  const t = topic();
  put(t, 0, "v0", ["bee", "etherna"]);
  put(t, 1, "v1", ["etherna"]); // still on its way to the public net
  const res = await up.readContentFeedJsonResult(OWNER, t, "social", { skipLegacy: true });
  assert.equal(res.status, "found");
  if (res.status !== "found") return;
  assert.equal(decode(res.bytes), "v1");
  assert.equal(res.scanClean, true);
  assert.ok(net.requests.etherna > 0);
});

test("Etherna down during an Etherna-routed scan: the previous version comes back DIRTY, and is not cached", async () => {
  const t = topic();
  put(t, 0, "v0", ["bee", "etherna"]);
  put(t, 1, "v1-retraction", ["etherna"]);
  net.ethernaMode = "503";
  const dirty = await up.readContentFeedJsonResult(OWNER, t, "social", { skipLegacy: true });
  assert.equal(dirty.status, "found");
  if (dirty.status !== "found") return;
  assert.equal(decode(dirty.bytes), "v0");
  assert.equal(dirty.scanClean, false, "a lower bound, never a verdict - the countersign check refuses on it");

  // Etherna back: the next read scans again rather than serving v0 from the cache.
  net.ethernaMode = "up";
  const again = await up.readContentFeedJsonResult(OWNER, t, "social", { skipLegacy: true });
  assert.equal(again.status, "found");
  if (again.status !== "found") return;
  assert.equal(decode(again.bytes), "v1-retraction");
  assert.equal(again.scanClean, true);
});

test("bee 404 + Etherna 503 with nothing found is unavailable, not absent", async () => {
  net.ethernaMode = "503";
  const res = await up.readContentFeedJsonResult(OWNER, topic(), "social", { skipLegacy: true });
  assert.equal(res.status, "unavailable");

  net.ethernaMode = "throw";
  const res2 = await up.readContentFeedJsonResult(OWNER, topic(), "social", { skipLegacy: true });
  assert.equal(res2.status, "unavailable");
});

test("bee 404 + Etherna 404 is the only absent an Etherna-routed scan gives", async () => {
  const res = await up.readContentFeedJsonResult(OWNER, topic(), "event");
  assert.equal(res.status, "absent");
});

test("an Etherna chunk that fails verification is a fault, not a find and not a miss", async () => {
  const t = topic();
  const { address, raw } = storedSoc(versionedSocIdentifier(contentFeedSocIdentifier(t), 0), "v0");
  const forged = raw.slice();
  forged[forged.length - 1] ^= 1;
  net.etherna.set(address, forged);
  const res = await up.readContentFeedJsonResult(OWNER, t, "social", { skipLegacy: true });
  assert.equal(res.status, "unavailable");
});

// ---------------------------------------------------------------------------
// The version cache never lets one route answer for another
// ---------------------------------------------------------------------------

test("a WoCo-routed 'absent' is never served to an Etherna-routed read of the same feed", async () => {
  const t = topic();
  put(t, 0, "only-on-etherna", ["etherna"]);
  const woco = await up.readContentFeedJsonResult(OWNER, t, "referral", { skipLegacy: true });
  assert.equal(woco.status, "absent", "the WoCo route cannot see it - and caches that");
  const eth = await up.readContentFeedJsonResult(OWNER, t, "social", { skipLegacy: true });
  assert.equal(eth.status, "found", "the Etherna route asks for itself");
});

test("invalidation drops every route's cached version", async () => {
  const t = topic();
  put(t, 0, "v0", ["bee"]);
  await up.readContentFeedJsonResult(OWNER, t, "referral", { skipLegacy: true });
  await up.readContentFeedJsonResult(OWNER, t, "social", { skipLegacy: true });
  put(t, 1, "v1", ["bee"]);
  up.invalidateContentFeedVersion(OWNER, t);
  for (const family of ["referral", "social"] as const) {
    const res = await up.readContentFeedJsonResult(OWNER, t, family, { skipLegacy: true });
    assert.equal(res.status === "found" && res.version, 1, family);
  }
});

// ---------------------------------------------------------------------------
// Banded walks and exact slots
// ---------------------------------------------------------------------------

test("a band walk that could not ask is unavailable, not an empty feed", async () => {
  net.beeMode = "503";
  const res = await up.readBandedContentFeedJsonResult(OWNER, (b) => `woco/test/657/band/${n}/${b}`, "credits");
  assert.equal(res.status, "unavailable");
});

test("a band walk that stopped early marks the head it read as a lower bound", async () => {
  const family = `woco/test/657/walk/${++n}`;
  const topicForBand = (b: number) => `${family}/${b}`;
  put(topicForBand(0), 0, "band0-v0", ["bee"]);
  // The next band's opener cannot be asked, so band 1 may be open.
  const { address } = storedSoc(versionedSocIdentifier(contentFeedSocIdentifier(topicForBand(1)), 0), "x");
  net.beeFaulty.add(address);
  const res = await up.readBandedContentFeedJsonResult(OWNER, topicForBand, "credits");
  assert.equal(res.status, "found");
  if (res.status !== "found") return;
  assert.equal(res.band, 0);
  assert.equal(res.scanClean, false, "band 0's head is clean on its own - but band 1 may hold the real one");
});

test("readVersion0 is tri-state and follows its family", async () => {
  const t = topic();
  put(t, 0, "slot", ["etherna"]);
  assert.equal((await up.readVersion0(OWNER, t, "campaignIssuer")).status, "absent");
  assert.equal(net.requests.etherna, 0);
  assert.equal((await up.readVersion0(OWNER, t, "social")).status, "found");
  net.ethernaMode = "503";
  assert.equal((await up.readVersion0(OWNER, topic(), "social")).status, "unavailable");
});

// ---------------------------------------------------------------------------
// The host rule and the fetch base are separate things
// ---------------------------------------------------------------------------

test("the canonical host selects Etherna even though the env points the fetches elsewhere", async () => {
  const t = topic();
  put(t, 0, "v0", ["etherna"]);
  const id = hex(versionedSocIdentifier(contentFeedSocIdentifier(t), 0));
  const viaCanonical = await rd.readVerifiedSoc(OWNER, id, { gatewayUrl: "https://gateway.etherna.io" });
  assert.equal(viaCanonical.status, "found", "the client's gateway routes to Etherna");
  assert.ok(net.requests.etherna > 0, "and the request went to the configured base");

  net.requests.etherna = 0;
  const viaEnvHost = await rd.readVerifiedSoc(OWNER, id, { gatewayUrl: ETHERNA_BASE });
  assert.equal(viaEnvHost.status, "absent", "the env host is a fetch base, not a routing signal");
  assert.equal(net.requests.etherna, 0);

  assert.equal(gw.ETHERNA_FETCH_BASE, ETHERNA_BASE);
  assert.match(gw.ethernaFetchBaseNotice() ?? "", /not the canonical Etherna gateway/);
  assert.equal(gw.ethernaFetchBaseNotice("https://gateway.etherna.io"), null);
});

// ---------------------------------------------------------------------------
// The indexer reads each format through its own family
// ---------------------------------------------------------------------------

test("the indexer's families: likes and follows are social, credits are credits", () => {
  assert.deepEqual(indexer.FORMAT_FAMILY, {
    "woco.credit.v1": "credits",
    "woco.like.v1": "social",
    "woco.follow.v1": "social",
  });
});

test("an Etherna failure on a like is a GAP in the evidence, not a participant who said nothing", async () => {
  const subject = ("0x" + "5a".repeat(32)) as Hex0x;
  participants.__resetParticipants({ "woco.like.v1": { [subject]: [OWNER] } });
  // The like exists only in Etherna's store so far, and Etherna is down.
  put(likeStatementTopic(subject), 0, '{"format":"woco.like.v1"}', ["etherna"]);
  net.ethernaMode = "503";
  const res = await indexer.indexSubject("woco.like.v1", subject);
  assert.deepEqual(res.unreadable, [OWNER]);
  assert.ok(net.requests.etherna > 0, "the social family asked Etherna");
});

// ---------------------------------------------------------------------------
// The event money path: a dirty scan is served, never cached, never a basis
// ---------------------------------------------------------------------------

const CREATOR = "0x" + "77".repeat(20);

function eventVersion(eventId: string, title: string): string {
  return JSON.stringify({ eventId, title, creatorAddress: CREATOR, creatorFeedSigner: "0x" + OWNER, series: [] });
}

test("getEvent serves an inconclusive read but does not cache it; a clean one is cached", async () => {
  const eventId = `657-${++n}-${Date.now()}`;
  signerRecord.recordEventFeedSigner(eventId, "0x" + OWNER, CREATOR);
  put(eventContentTopic(eventId), 0, eventVersion(eventId, "v0"), ["bee", "etherna"]);
  put(eventContentTopic(eventId), 1, eventVersion(eventId, "v1"), ["etherna"]);

  net.ethernaMode = "503";
  const dirty = await events.getEvent(eventId);
  assert.equal(dirty?.title, "v0", "what the server can see, served");
  assert.equal(events.peekEventCache(eventId), null, "but not kept for the cache's ten minutes");

  net.ethernaMode = "up";
  const clean = await events.getEvent(eventId);
  assert.equal(clean?.title, "v1");
  assert.equal(events.peekEventCache(eventId)?.title, "v1");
});

test("an owner edit refuses a base it could not show is the head - the client would re-sign it over the newer version", async () => {
  const eventId = `657-${++n}-${Date.now()}`;
  signerRecord.recordEventFeedSigner(eventId, "0x" + OWNER, CREATOR);
  put(eventContentTopic(eventId), 0, eventVersion(eventId, "v0"), ["bee", "etherna"]);
  put(eventContentTopic(eventId), 1, eventVersion(eventId, "v1-cancelled-banner"), ["etherna"]);

  net.ethernaMode = "503";
  await assert.rejects(
    events.updateEventMetadata({ eventId, parentAddress: CREATOR, updates: { title: "edited" } }),
    (err: Error) => err.message === events.EVENT_BASIS_UNVERIFIED && err.message.startsWith("Could not verify"),
  );
  await assert.rejects(
    events.deleteEventIfNoOrders({ eventId, parentAddress: CREATOR }),
    (err: Error) => err.message === events.EVENT_BASIS_UNVERIFIED,
  );
});
