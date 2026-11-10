/**
 * A new site's first publish and first deploy meet bee 2.8's one-minute skip
 * list (#943). Every peer that fails to return a chunk is skipped for that chunk
 * for a minute (`pkg/retrieval`), so after a few reads of a feed nobody has
 * written, bee answers `/feeds` 404 "lookup at failed" and `/chunks` 500 "read
 * chunk failed" until the minute is up. That is never "absent" (#186), so the
 * save refuses. Pinned here, against a fake bee that models the skip list:
 *  - the refusal is a TYPED 503 (`STORAGE_BUSY`, `retryAfterMs`), not a 500;
 *  - a publish whose config landed but whose events index did not says so, and
 *    the retry finishes both - publishing again never makes a second site or
 *    doubles the index;
 *  - a deploy refuses BEFORE it uploads the collection, so the retry is cheap;
 *  - nothing it could not check is ever written, and the normal paths are as before.
 *
 * One chunk store stands for the network; our bee and Etherna are two fronts on it.
 */
import { feedManifestFor } from "@woco/shared/swarm/feed-manifest";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { TypedDataEncoder, Wallet } from "ethers";
import { FeedIndex, Topic } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import { calculateSocAddress } from "@woco/shared";
import { buildSiteCollection, siteRenderUrls } from "@woco/shared/site/collection";
import { bytesTreeChunks } from "@woco/shared/swarm/bytes-tree";
import { parseMantarayNode } from "@woco/shared/swarm/mantaray";
import { enableFeature } from "./helpers/features.js";

/** Site runtime release v1 as bee encoded it (#1032): what every site deploy links. */
const RELEASE = JSON.parse(readFileSync(new URL("../../../packages/shared/test/fixtures/site-runtime-release-v1.json", import.meta.url), "utf8"));
const RELEASE_ROOT_NODE = Binary.hexToUint8Array(RELEASE.rootNode);
/** Release v2's event-page line as bee encoded it: what every event page links. */
const PAGE_RELEASE = JSON.parse(readFileSync(new URL("../../../packages/shared/test/fixtures/site-runtime-release-v2-event-page.json", import.meta.url), "utf8"));
/** The signer the creator gate pins for the test's events (no event-feed-signers record here). */
const PAGE_SIGNER = "0x" + "5e".repeat(20);
/** eventIds the injected gate lets through; anything else is refused as the real gate would. */
const PAGE_CREATORS = new Map<string, string>();

enableFeature("walletLoginAllowed");

const DEAD = "http://127.0.0.1:9";
const HOST = "test.woco.local";
const PUBLIC_BASE = "https://events-api.woco-net.com";
const PLATFORM_KEY = Wallet.createRandom().privateKey;
const PLATFORM_OWNER = new Wallet(PLATFORM_KEY).address.slice(2).toLowerCase();

// ---------------------------------------------------------------------------
// The network, with bee's skip list
// ---------------------------------------------------------------------------

/** SOC address -> stored SOC (identifier ‖ signature ‖ span ‖ payload). First write wins. */
const chunks = new Map<string, Uint8Array>();
/** Content address -> its chunk (span ‖ data), as bee serves it from /chunks. */
const contents = new Map<string, Uint8Array>();
/** Site root nodes stored, per front: one per deploy (the root goes up last). */
const bzzUploads: Array<"bee" | "etherna"> = [];

/** bee's clock, moved by the tests: the skip list is a minute of it. */
let clock = 0;
const SKIP_MS = 60_000;
/** Misses of one chunk inside a minute that leave bee no peer to ask. */
const MISSES_TO_SKIP = 3;
const misses = new Map<string, number[]>();
const skippedUntil = new Map<string, number>();

function noteMiss(addr: string): void {
  const recent = (misses.get(addr) ?? []).filter((t) => clock - t < SKIP_MS);
  recent.push(clock);
  misses.set(addr, recent);
  if (recent.length >= MISSES_TO_SKIP) skippedUntil.set(addr, clock + SKIP_MS);
}
const skipped = (addr: string) => (skippedUntil.get(addr) ?? -1) > clock;
/** Topics whose bee walk fails whatever is stored ("lookup at failed"). */
const lookupFails = new Set<string>();
/** Etherna's gateway refusing every authenticated feed lookup (nginx 403, 2026-10-23). */
let ethernaLookupRefused = false;
/** Etherna's node API down (2026-11-05: "Exception invoking node API"): 503 to all but sign-in. */
let ethernaDown = false;

const hex = (b: Uint8Array) => Binary.uint8ArrayToHex(b);
const unhex = (h: string) => Binary.hexToUint8Array(h);

function updateAddress(ownerHex: string, topicHex: string, index: bigint): string {
  const id = Binary.keccak256(Binary.concatBytes(unhex(topicHex), FeedIndex.fromBigInt(index).toUint8Array()));
  return hex(calculateSocAddress(id, unhex(ownerHex)));
}
const topicHexOf = (topic: string) => Topic.fromString(topic).toHex().replace(/^0x/, "").toLowerCase();

/** Bee has missed index 0 of this feed often enough to skip it for a minute. */
function skipListFirstChunk(topic: string, ownerHex = PLATFORM_OWNER): void {
  const addr = updateAddress(ownerHex, topicHexOf(topic), 0n);
  for (let i = 0; i < MISSES_TO_SKIP; i++) noteMiss(addr);
  assert.ok(skipped(addr));
}

/** Decoded JSON payloads of a platform feed, oldest first. */
function feedHistory(topic: string, ownerHex = PLATFORM_OWNER): unknown[] {
  const out: unknown[] = [];
  for (let i = 0n; ; i++) {
    const c = chunks.get(updateAddress(ownerHex, topicHexOf(topic), i));
    if (!c) return out;
    out.push(feeds.decodeJsonFeed(c.subarray(32 + 65 + 8)) ?? hex(c.subarray(32 + 65 + 8)));
  }
}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
  });
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function socPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", "http://x");
  const [, , owner, id] = url.pathname.split("/");
  const body = await readBody(req);
  const addr = hex(calculateSocAddress(unhex(id!), unhex(owner!)));
  if (!chunks.has(addr)) chunks.set(addr, Binary.concatBytes(unhex(id!), unhex(url.searchParams.get("sig")!), body));
  json(res, 201, { reference: addr });
}

/** `/bytes`: store the real chunk tree and answer its root, as bee does at redundancy 0. */
async function bytesPost(req: IncomingMessage, res: ServerResponse, via: "bee" | "etherna"): Promise<void> {
  const body = await readBody(req);
  const tree = bytesTreeChunks(body);
  for (const { address, chunk } of tree) contents.set(address, chunk);
  try {
    if (parseMantarayNode(body).forks.some((f) => f.prefix === "m")) bzzUploads.push(via);
  } catch {
    // not a manifest node
  }
  json(res, 201, { reference: tree.at(-1)!.address });
}

const bee: Server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  if (req.method === "POST" && path.startsWith("/soc/")) return socPost(req, res);
  if (req.method === "POST" && path === "/bytes") return bytesPost(req, res, "bee");
  if (req.method === "POST" && path.startsWith("/feeds/")) return json(res, 201, { reference: "ee".repeat(32) });
  if (req.method === "GET" && path.startsWith("/chunks/")) {
    const addr = path.split("/")[2]!.toLowerCase();
    const stored = chunks.get(addr) ?? contents.get(addr);
    if (stored) return void res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from(stored));
    if (skipped(addr)) return json(res, 500, { code: 500, message: "read chunk failed" });
    noteMiss(addr);
    return json(res, 404, { code: 404, message: "chunk not found" });
  }
  const m = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/i.exec(path);
  if (req.method === "GET" && m) {
    const owner = m[1]!.toLowerCase();
    const topic = m[2]!.toLowerCase();
    if (lookupFails.has(topic)) return json(res, 404, { code: 404, message: "lookup at failed" });
    let latest = -1n;
    while (chunks.has(updateAddress(owner, topic, latest + 1n))) latest++;
    const next = updateAddress(owner, topic, latest + 1n);
    if (latest < 0n) {
      // Bee's walk could not even ask about index 0: its 404 that is NOT "empty".
      if (skipped(next)) return json(res, 404, { code: 404, message: "lookup at failed" });
      noteMiss(next);
      return json(res, 404, { code: 404, message: "no update found" });
    }
    if (!skipped(next)) noteMiss(next); // the walk probes one past the head
    const c = chunks.get(updateAddress(owner, topic, latest))!;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "swarm-feed-index": FeedIndex.fromBigInt(latest).toHex(),
      "swarm-feed-index-next": FeedIndex.fromBigInt(latest + 1n).toHex(),
    }).end(Buffer.from(c.subarray(32 + 65 + 8)));
    return;
  }
  json(res, 404, { code: 404, message: "Not Found" });
});

/** Etherna: never skip-lists here; a fresh feed's lookup is a 404. */
const etherna: Server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  if (req.method === "POST" && path === "/token") return json(res, 200, { access_token: "t", expires_in: 3600 });
  if (ethernaDown) return json(res, 503, { code: 503, message: "Exception invoking node API" });
  if (req.method === "POST" && path === "/bytes") return bytesPost(req, res, "etherna");
  if (req.method === "POST" && path.startsWith("/soc/")) return socPost(req, res);
  if (req.method === "POST" && path.includes("/offers")) return json(res, 200, {});
  if (req.method === "POST" && path.startsWith("/feeds/")) return json(res, 201, { reference: "ef".repeat(32) });
  if (req.method === "GET" && path.startsWith("/feeds/")) {
    if (ethernaLookupRefused) return void res.writeHead(403, { "Content-Type": "text/html" }).end("<html><head><title>403 Forbidden</title></head></html>");
    return json(res, 404, { code: 404, message: "no update found" });
  }
  if (req.method === "GET" && path.startsWith("/chunks/")) {
    const stored = chunks.get(path.split("/")[2]!.toLowerCase()) ?? contents.get(path.split("/")[2]!.toLowerCase());
    if (stored) return void res.writeHead(200).end(Buffer.from(stored));
    return json(res, 404, { code: 404, message: "chunk not found" });
  }
  json(res, 404, { code: 404, message: "Not Found" });
});

// ---------------------------------------------------------------------------
// App + auth
// ---------------------------------------------------------------------------

let app: Hono;
let dir: string;
let shared: typeof import("@woco/shared");
let feeds: typeof import("../src/lib/swarm/feeds.js");
let setStripeAccount: typeof import("../src/lib/stripe/accounts.js").setStripeAccount;
let busy: typeof import("../src/lib/swarm/storage-busy.js");
let topicCreatorDirectory: typeof import("../src/lib/swarm/topics.js").topicCreatorDirectory;
let ETHERNA_URL: string;

before(async () => {
  // A server-side keep-alive close racing undici's reuse reads as "bee unreachable".
  bee.keepAliveTimeout = etherna.keepAliveTimeout = 120_000;
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => etherna.listen(0, "127.0.0.1", r));
  const ethernaUrl = `http://127.0.0.1:${(etherna.address() as AddressInfo).port}`;
  process.env.BEE_URL = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_ENABLED = "true";
  process.env.ETHERNA_API_KEY = "id.secret";
  process.env.ETHERNA_GATEWAY_URL = ethernaUrl;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${ethernaUrl}/token`;
  process.env.ETHERNA_PLATFORM_BATCH = "cd".repeat(32);
  process.env.FEED_PRIVATE_KEY = PLATFORM_KEY;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  process.env.ALLOWED_HOSTS = HOST;
  process.env.PUBLIC_API_BASE = PUBLIC_BASE;
  process.env.EMAIL_HASH_SECRET = "test-secret-site-first-save";
  delete process.env.STRIPE_SECRET_KEY;

  dir = mkdtempSync(join(tmpdir(), "woco-site-first-save-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  shared = await import("@woco/shared");
  ({ ETHERNA_GATEWAY_URL: ETHERNA_URL } = shared);
  feeds = await import("../src/lib/swarm/feeds.js");
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
  busy = await import("../src/lib/swarm/storage-busy.js");
  ({ topicCreatorDirectory } = await import("../src/lib/swarm/topics.js"));
  ({ setStripeAccount } = await import("../src/lib/stripe/accounts.js"));
  // No organiser here has a key ring (#186); the anchor is chain, not this fake network.
  (await import("../src/lib/keyring/current-ring.js"))._setCurrentRingDepsForTests({ readAnchor: async () => `0x${"0".repeat(64)}` });
  const sites = await import("../src/routes/sites.js");
  // The release a deploy builds against: v1, for whichever store the deploy lands on.
  sites.__sitesDeployTestHooks.setRuntimeKit(async (store) => ({
    version: 1,
    store,
    release: RELEASE.release,
    rootNode: RELEASE_ROOT_NODE,
    template: RELEASE.template,
  }));
  const siteMod = await import("../src/routes/site.js");
  const { siteRoute } = siteMod;
  siteMod.__siteDeployTestHooks.setRuntimeKit(async () => ({
    version: 2,
    line: "eventPage",
    store: "etherna",
    release: PAGE_RELEASE.release,
    rootNode: Binary.hexToUint8Array(PAGE_RELEASE.rootNode),
    template: PAGE_RELEASE.template,
  }));
  siteMod.__siteDeployTestHooks.setGate((eventId, parentAddress) => {
    const creator = PAGE_CREATORS.get(eventId);
    if (!creator) return { ok: false, status: 404, error: "Event not found" };
    if (creator !== parentAddress.toLowerCase()) return { ok: false, status: 403, error: "Only the event's creator can publish its page" };
    return { ok: true, signer: PAGE_SIGNER };
  });
  app = new Hono();
  app.route("/api/sites", sites.sitesRouter);
  app.route("/api/site", siteRoute);
});

after(async () => {
  await new Promise<void>((r) => bee.close(() => r()));
  await new Promise<void>((r) => etherna.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  feeds.__feedWriteTestHooks.clearCache();
  bzzUploads.length = 0;
});

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex");

async function organiser() {
  const w = Wallet.createRandom();
  setStripeAccount(w.address.toLowerCase(), `acct_${randomUUID().slice(0, 8)}`, true);
  return w;
}

type Reply = { status: number; retryAfter: string | null; json: { ok: boolean; error?: string; code?: string; retryAfterMs?: number; data?: Record<string, unknown> } };

async function call(parent: Wallet, path: string, payload: unknown, method: "POST" | "GET" = "POST"): Promise<Reply> {
  const session = Wallet.createRandom();
  const nonce = randomUUID();
  const message = {
    host: HOST,
    parent: parent.address,
    session: session.address,
    purpose: shared.SESSION_PURPOSE,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + shared.SESSION_EXPIRY_MS).toISOString(),
    sessionProof: await session.signMessage(`${HOST}:${nonce}`),
    clientCodeHash: "0x" + "00".repeat(32),
    statement: `Authorize ${session.address} as session key for ${HOST}`,
  };
  const parentSig = await parent.signTypedData(
    shared.SESSION_DOMAIN,
    shared.SESSION_TYPES as unknown as Parameters<typeof TypedDataEncoder.hash>[1],
    message,
  );
  const body = method === "GET" ? "" : JSON.stringify(payload);
  const ts = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", method, path, ts, reqNonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig })).toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": ts,
    },
    ...(method === "GET" ? {} : { body }),
  });
  return { status: resp.status, retryAfter: resp.headers.get("retry-after"), json: (await resp.json()) as Reply["json"] };
}

const newSiteId = () => `site-${randomUUID().slice(0, 12)}`;
const publish = (who: Wallet, siteId: string, events: Array<{ eventId: string }> = []) =>
  call(who, "/api/sites", { site: { siteId, theme: { brandName: "First" } }, events });

function siteFor(siteId: string) {
  let n = 0;
  return shared.newSiteFromTemplate({ siteId, ownerAddress: "0x0", templateId: "pub-venue-v1", idGen: () => `id${n++}` });
}
/** The deploy an app sends: the site built in the browser on release v1, as the builder builds it. */
function deployBody(who: Wallet, siteId: string, gatewayUrl: string) {
  const site = { ...siteFor(siteId), ownerAddress: who.address.toLowerCase() };
  const built = buildSiteCollection({
    site,
    urls: siteRenderUrls({ apiUrl: PUBLIC_BASE, gatewayUrl, wocoAppUrl: "https://woco.eth.limo" }),
    template: RELEASE.template,
    release: RELEASE.release,
    releaseRootNode: RELEASE_ROOT_NODE,
  });
  const objects = built.objects.map((o) => Buffer.from(o.data).toString("base64"));
  return { body: { apiUrl: PUBLIC_BASE, gatewayUrl, site, collection: { runtimeVersion: 1, objects } }, root: built.root };
}
const deploy = (who: Wallet, siteId: string, gatewayUrl: string) =>
  call(who, `/api/sites/${siteId}/deploy`, deployBody(who, siteId, gatewayUrl).body);

function assertStorageBusy(r: Reply): void {
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, "STORAGE_BUSY");
  assert.equal(r.json.retryAfterMs, busy.STORAGE_BUSY_RETRY_MS);
  assert.ok(busy.STORAGE_BUSY_RETRY_MS > SKIP_MS, "the wait outlasts bee's skip window");
  assert.equal(r.retryAfter, String(Math.ceil(busy.STORAGE_BUSY_RETRY_MS / 1000)));
  assert.match(String(r.json.error), /about a minute/);
}

/** Let the fire-and-forget directory upsert of a response settle before the next step. */
const settle = () => new Promise((r) => setTimeout(r, 300));

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

test("publish: the config feed skip-listed - a typed 503, nothing written; after the minute it publishes", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  skipListFirstChunk(shared.siteConfigTopic(siteId));

  const refused = await publish(who, siteId);
  assertStorageBusy(refused);
  assert.deepEqual(feedHistory(shared.siteConfigTopic(siteId)), [], "nothing written past a read that could not decide");
  assert.deepEqual(feedHistory(shared.siteEventsIndexTopic(siteId)), []);

  clock += busy.STORAGE_BUSY_RETRY_MS;
  const ok = await publish(who, siteId);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(feedHistory(shared.siteConfigTopic(siteId)).length, 1);
  assert.equal(feedHistory(shared.siteEventsIndexTopic(siteId)).length, 1);
  await settle();
});

test("publish: reads before the first save put it on the skip list (the owner's report), and it is typed", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  // The builder opening the new site: display reads of a feed nobody has written.
  for (let i = 0; i < MISSES_TO_SKIP; i++) {
    const r = await app.request(`/api/sites/${siteId}`);
    assert.equal(r.status, 404);
  }
  assertStorageBusy(await publish(who, siteId));
  clock += busy.STORAGE_BUSY_RETRY_MS;
  assert.equal((await publish(who, siteId)).status, 200);
  await settle();
});

test("publish: config lands, events index refused - a typed 503, and the retry finishes both, idempotently", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  const eventId = randomUUID();
  // The organiser's own event, so its signer is stamped from their directory (no event read).
  const signer = Wallet.createRandom().address.toLowerCase();
  await feeds.writeFeedPage(
    topicCreatorDirectory(who.address.toLowerCase()),
    feeds.encodeJsonFeed({ v: 1, entries: [{ eventId, creatorFeedSigner: signer }], pages: 0 }),
  );
  skipListFirstChunk(shared.siteEventsIndexTopic(siteId));

  const partial = await publish(who, siteId, [{ eventId }]);
  assertStorageBusy(partial);
  assert.equal(feedHistory(shared.siteConfigTopic(siteId)).length, 1, "the config landed");
  assert.deepEqual(feedHistory(shared.siteEventsIndexTopic(siteId)), [], "the events index did not");
  await settle();

  clock += busy.STORAGE_BUSY_RETRY_MS;
  const retried = await publish(who, siteId, [{ eventId }]);
  assert.equal(retried.status, 200, JSON.stringify(retried.json));
  assert.deepEqual(retried.json.data, { siteId });
  const index = feedHistory(shared.siteEventsIndexTopic(siteId)) as Array<{ siteId: string; events: Array<{ eventId: string }> }>;
  assert.equal(index.length, 1);
  assert.equal(index[0]!.siteId, siteId);
  assert.deepEqual(index[0]!.events.map((e) => e.eventId), [eventId]);
  assert.equal((index[0]!.events[0] as { creatorFeedSigner?: string }).creatorFeedSigner, signer, "the money-path carrier is stamped");
  await settle();

  // Publishing the same site again: the same site, the same one-event index.
  const again = await publish(who, siteId, [{ eventId }]);
  assert.equal(again.status, 200);
  const configs = feedHistory(shared.siteConfigTopic(siteId)) as Array<{ siteId: string; ownerAddress: string }>;
  assert.equal(configs.length, 3);
  assert.ok(configs.every((c) => c.siteId === siteId && c.ownerAddress === who.address.toLowerCase()));
  const latest = feedHistory(shared.siteEventsIndexTopic(siteId)).at(-1) as { events: Array<{ eventId: string }> };
  assert.deepEqual(latest.events.map((e) => e.eventId), [eventId], "rewritten whole, never appended to");
  await settle();
  const dir = feedHistory(shared.siteCreatorDirectoryTopic(who.address.toLowerCase())).at(-1) as { entries: Array<{ siteId: string }> };
  assert.deepEqual(dir.entries.map((e) => e.siteId), [siteId], "one directory entry for the site");
});

test("publish: the normal path is unchanged - one write per feed, a 200", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  const r = await publish(who, siteId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, data: { siteId } });
  assert.equal(feedHistory(shared.siteConfigTopic(siteId)).length, 1);
  assert.equal(feedHistory(shared.sitePagesTopicFn(siteId)).length, 1);
  assert.equal(feedHistory(shared.siteEventsIndexTopic(siteId)).length, 1);
  await settle();
});

test("publish: an undecidable read that is NOT the skip-list shape keeps its old answer", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  assert.equal((await publish(who, siteId)).status, 200);
  await settle();
  feeds.__feedWriteTestHooks.clearCache(); // a restart: no read-your-writes copy
  // bee's walk fails on a feed whose index 0 IS readable: a fault, not the skip list.
  lookupFails.add(topicHexOf(shared.siteConfigTopic(siteId)));
  try {
    const r = await publish(who, siteId);
    assert.equal(r.status, 503);
    assert.equal(r.json.code, undefined);
    assert.match(String(r.json.error), /Could not verify site ownership/);
  } finally {
    lookupFails.clear();
  }
});

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

test("deploy (WoCo): the pointer feed skip-listed - a typed 503 BEFORE the collection is uploaded", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  skipListFirstChunk(shared.multisiteFeedTopic(siteId));

  assertStorageBusy(await deploy(who, siteId, "https://gateway.woco-net.com"));
  assert.deepEqual(bzzUploads, [], "a refusal costs no upload");
  assert.deepEqual(feedHistory(shared.multisiteFeedTopic(siteId)), []);

  clock += busy.STORAGE_BUSY_RETRY_MS;
  const ok = await deploy(who, siteId, "https://gateway.woco-net.com");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(bzzUploads, ["bee"], "uploaded once, on the retry");
  const pointer = feedHistory(shared.multisiteFeedTopic(siteId));
  assert.equal(pointer.length, 1, "the pointer update is at index 0");
  // The update's payload is the uploaded collection's root chunk data.
  const root = contents.get(String(ok.json.data!.contentHash))!;
  assert.equal(pointer[0], hex(root.subarray(8)));
  await settle();
});

test("deploy (Etherna): our bee cannot say whether the pointer's index 0 is taken - typed 503, nothing uploaded", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  skipListFirstChunk(shared.multisiteFeedTopic(siteId));

  assertStorageBusy(await deploy(who, siteId, ETHERNA_URL));
  assert.deepEqual(bzzUploads, []);

  clock += busy.STORAGE_BUSY_RETRY_MS;
  const ok = await deploy(who, siteId, ETHERNA_URL);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(bzzUploads, ["etherna"]);
  assert.equal(feedHistory(shared.multisiteFeedTopic(siteId)).length, 1);
  // The manifest is built and stored here (#912 slice 2b), never Etherna's POST /feeds.
  assert.equal(ok.json.data!.feedManifestHash, feedManifestFor(PLATFORM_OWNER, shared.multisiteFeedTopic(siteId)));
  await settle();
});

test("deploy (Etherna): Etherna refuses the feed lookup (403) - resolved from our bee, and a redeploy takes the next index", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  ethernaLookupRefused = true;
  try {
    const first = await deploy(who, siteId, ETHERNA_URL);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(feedHistory(shared.multisiteFeedTopic(siteId)).length, 1, "index 0");
    await settle();
    feeds.__feedWriteTestHooks.clearCache();
    const second = await deploy(who, siteId, ETHERNA_URL);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(feedHistory(shared.multisiteFeedTopic(siteId)).length, 2, "index 1 - never a write at the taken index 0");
    assert.deepEqual(bzzUploads, ["etherna", "etherna"]);
  } finally {
    ethernaLookupRefused = false;
  }
  await settle();
});

test("deploy: the normal path is unchanged, and a redeploy writes the next index", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  const first = await deploy(who, siteId, "https://gateway.woco-net.com");
  assert.equal(first.status, 200, JSON.stringify(first.json));
  await settle();
  const second = await deploy(who, siteId, "https://gateway.woco-net.com");
  assert.equal(second.status, 200);
  assert.deepEqual(bzzUploads, ["bee", "bee"]);
  assert.equal(feedHistory(shared.multisiteFeedTopic(siteId)).length, 2, "index 0, then index 1");
  await settle();
});

test("deploy: a second deploy of the same site while one is running is refused, not raced onto its index", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  // Hold the first deploy inside its upload.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/bytes")) await held;
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const running = deploy(who, siteId, "https://gateway.woco-net.com");
    await new Promise((r) => setTimeout(r, 200));
    const second = await deploy(who, siteId, "https://gateway.woco-net.com");
    assert.equal(second.status, 409);
    assert.equal(second.json.code, "DEPLOY_IN_PROGRESS");
    release();
    assert.equal((await running).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  // Released: the next deploy runs.
  assert.equal((await deploy(who, siteId, "https://gateway.woco-net.com")).status, 200);
  await settle();
});

// ---------------------------------------------------------------------------
// Browser-built only (#1032 slice 4)
// ---------------------------------------------------------------------------

test("deploy: the stored site is the browser's build, linking the release, and the ledger names the link", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  const { body, root } = deployBody(who, siteId, "https://gateway.woco-net.com");
  const ok = await call(who, `/api/sites/${siteId}/deploy`, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data!.contentHash, root);
  assert.deepEqual([ok.json.data!.builtBy, ok.json.data!.runtimeVersion], ["client", 1]);
  const rootChunk = contents.get(root)!;
  const forks = parseMantarayNode(rootChunk.subarray(8)).forks.map((f) => f.prefix);
  assert.deepEqual(forks, ["/", "assets/", "icons/", "logo.png", "m"]);
  // The ledger file: owner -> { usedBytes, uploads[] } (lib/swarm/storage-ledger.ts).
  const ledger = JSON.parse(readFileSync(join(dir, ".data", "storage-ledger.json"), "utf8")) as Record<string, { uploads: Array<Record<string, unknown>> }>;
  const rec = Object.values(ledger).flatMap((o) => o.uploads).find((u) => u.ref === root);
  assert.ok(rec, "the deploy is in the storage ledger");
  assert.deepEqual(rec.links, [RELEASE.release.root]);
  assert.ok((rec.bytes as number) < 8192, `a few KB, not a runtime copy (${rec.bytes} B)`);
  await settle();
});

test("deploy: an app from before browser-built sites is told to update, and nothing is uploaded", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  const r = await call(who, `/api/sites/${siteId}/deploy`, { apiUrl: PUBLIC_BASE, gatewayUrl: "https://gateway.woco-net.com", site: siteFor(siteId) });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "CLIENT_BUILD_REQUIRED");
  assert.match(String(r.json.error), /reload the page/);
  assert.deepEqual(bzzUploads, []);
});

test("deploy: a build that differs from the server's rebuild is refused before anything is uploaded", async () => {
  const who = await organiser();
  const siteId = newSiteId();
  const { body } = deployBody(who, siteId, "https://gateway.woco-net.com");
  const html = Buffer.from(body.collection.objects[0]!, "base64");
  html[html.length - 2] ^= 1;
  body.collection.objects[0] = html.toString("base64");
  const r = await call(who, `/api/sites/${siteId}/deploy`, body);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "COLLECTION_MISMATCH");
  assert.deepEqual(bzzUploads, []);
  assert.deepEqual(feedHistory(shared.multisiteFeedTopic(siteId)), [], "no pointer moved");
});

// ---------------------------------------------------------------------------
// Event pages, browser-built (#1032 slice 5)
// ---------------------------------------------------------------------------

/** An event the injected gate knows, created by `who`. */
function eventOf(who: Wallet): string {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  PAGE_CREATORS.set(eventId, who.address.toLowerCase());
  return eventId;
}

/** What the builder does: read the page config, build on the event-page kit, send. */
async function pageDeployBody(who: Wallet, eventId: string, head?: import("@woco/shared").EventPageHead, name?: string) {
  const cfg = await call(who, `/api/site/${eventId}/page-config`, null, "GET");
  assert.equal(cfg.status, 200, JSON.stringify(cfg.json));
  const { config, head: suggested } = cfg.json.data as { config: Record<string, string>; head: { title: string; imageHash?: string } };
  const { buildEventPageCollection } = await import("@woco/shared/site/collection");
  const usedHead = head ?? suggested;
  const built = buildEventPageCollection({
    config: config as never,
    head: usedHead,
    name,
    template: PAGE_RELEASE.template,
    release: PAGE_RELEASE.release,
    releaseRootNode: Binary.hexToUint8Array(PAGE_RELEASE.rootNode),
  });
  const objects = built.objects.map((o) => Buffer.from(o.data).toString("base64"));
  return { config, suggested, root: built.root, rootNode: built.rootNode, body: { eventId, apiUrl: PUBLIC_BASE, gatewayUrl: ETHERNA_URL, clientFeed: true, head: usedHead, collection: { runtimeVersion: 2, objects } } };
}

test("event page: page-config names the server's own carrier; the browser's build is stored and its root signed by the browser", async () => {
  const who = await organiser();
  const eventId = eventOf(who);
  const d = await pageDeployBody(who, eventId, { title: "Friday Gig", imageHash: "ab".repeat(32) });
  assert.deepEqual(Object.keys(d.config), ["apiUrl", "gatewayUrl", "contentGatewayUrl", "eventId", "eventSigner"]);
  assert.equal(d.config.eventSigner, PAGE_SIGNER);
  assert.equal(d.config.eventId, eventId);
  assert.deepEqual(d.suggested, { title: "Event" }, "no event to read here: WoCo's fallback, shaped to pass the head parser");

  const r = await call(who, "/api/site/deploy", d.body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data!.contentHash, d.root);
  assert.equal(r.json.data!.runtimeVersion, 2);
  assert.deepEqual(r.json.data!.pageFeed, { owner: PAGE_SIGNER, nextIndex: 0 }, "no payload from the server: the browser signs its own root node");
  assert.equal(Buffer.compare(Buffer.from(contents.get(d.root)!.subarray(8)), Buffer.from(d.rootNode)), 0, "the stored root is the built one");
  const forks = parseMantarayNode(d.rootNode).forks.map((f) => f.prefix);
  assert.deepEqual(forks, ["/", "assets/", "icons/", "logo.png", "manifest.json", "site.html"]);
  const ledger = JSON.parse(readFileSync(join(dir, ".data", "storage-ledger.json"), "utf8")) as Record<string, { uploads: Array<Record<string, unknown>> }>;
  const rec = Object.values(ledger).flatMap((o) => o.uploads).find((u) => u.ref === d.root);
  assert.deepEqual([rec?.kind, rec?.links], ["event-site-deploy", [PAGE_RELEASE.release.root]]);
  await settle();
});

test("event page: an app without a browser build is told to update; a bad head is refused; nothing uploaded", async () => {
  const who = await organiser();
  const eventId = eventOf(who);
  const before = contents.size;
  const old = await call(who, "/api/site/deploy", { eventId, apiUrl: PUBLIC_BASE, clientFeed: true });
  assert.deepEqual([old.status, old.json.code], [400, "CLIENT_BUILD_REQUIRED"]);
  assert.match(String(old.json.error), /reload the page/);
  const d = await pageDeployBody(who, eventId);
  for (const head of [undefined, { title: "" }, { title: "Gig", imageHash: "AB".repeat(32) }, { title: "Gig", extra: 1 }]) {
    const r = await call(who, "/api/site/deploy", { ...d.body, head });
    assert.deepEqual([r.status, r.json.code], [400, "COLLECTION_MISMATCH"], JSON.stringify(head));
  }
  assert.equal(contents.size, before, "nothing stored");
});

test("event page: a head that is not the one rendered, or a tampered page, is refused before any upload", async () => {
  const who = await organiser();
  const eventId = eventOf(who);
  const before = contents.size;
  const d = await pageDeployBody(who, eventId, { title: "Friday Gig" });
  const lie = await call(who, "/api/site/deploy", { ...d.body, head: { title: "Saturday Gig" } });
  assert.deepEqual([lie.status, lie.json.code], [409, "COLLECTION_MISMATCH"]);
  const objects = [...d.body.collection.objects];
  const html = Buffer.from(objects[0]!, "base64");
  html[html.length - 2] ^= 1;
  objects[0] = html.toString("base64");
  const tampered = await call(who, "/api/site/deploy", { ...d.body, collection: { runtimeVersion: 2, objects } });
  assert.deepEqual([tampered.status, tampered.json.code], [409, "COLLECTION_MISMATCH"]);
  const stale = await call(who, "/api/site/deploy", { ...d.body, collection: { ...d.body.collection, runtimeVersion: 1 } });
  assert.deepEqual([stale.status, stale.json.code], [409, "RUNTIME_RELEASE_CHANGED"]);
  assert.equal(contents.size, before, "nothing stored");
});

test("event page: the name the deploy sends is rendered into the page (#70); a build that disagrees is refused before any upload", async () => {
  const who = await organiser();
  const eventId = eventOf(who);
  const before = contents.size;
  const named = await pageDeployBody(who, eventId, { title: "Friday Gig" }, "friday-gig");
  const html = Buffer.from(named.body.collection.objects[0]!, "base64").toString("utf8");
  assert.match(html, /<link rel="canonical" href="https:\/\/friday-gig\.woco\.eth\.limo\/">/);
  // Built with the name, sent without it; built without it, sent with it.
  const unsent = await call(who, "/api/site/deploy", named.body);
  assert.deepEqual([unsent.status, unsent.json.code], [409, "COLLECTION_MISMATCH"]);
  const plain = await pageDeployBody(who, eventId, { title: "Friday Gig" });
  const unbuilt = await call(who, "/api/site/deploy", { ...plain.body, subEnsLabel: "friday-gig" });
  assert.deepEqual([unbuilt.status, unbuilt.json.code], [409, "COLLECTION_MISMATCH"]);
  // Built and sent with the same name: the server's own rebuild is identical.
  const { admitClientEventPage, decodeClientCollection } = await import("../src/lib/site/collection-publish.js");
  const kit = { version: 2, line: "eventPage" as const, store: "etherna" as const, release: PAGE_RELEASE.release, rootNode: Binary.hexToUint8Array(PAGE_RELEASE.rootNode), template: PAGE_RELEASE.template };
  const received = decodeClientCollection(named.body.collection)!;
  const admitted = admitClientEventPage({ kit, config: named.config as never, head: { title: "Friday Gig" }, name: "friday-gig", received });
  assert.ok(admitted.ok && admitted.collection.root === named.root);
  assert.equal(contents.size, before, "nothing stored");
});

test("deploy: a website's name is checked like an event page's, and rendered alike (#70)", async () => {
  const who = await organiser();
  // A fresh site each time: repeated reads of one never-saved site trip bee's skip list first.
  for (const bad of ["", "ab", "Acme", "a--b", 'a"><script>', 7]) {
    const id = newSiteId();
    const { body } = deployBody(who, id, "https://gateway.woco-net.com");
    const r = await call(who, `/api/sites/${id}/deploy`, { ...body, site: { ...body.site, subEnsLabel: bad } });
    assert.deepEqual([r.status, r.json.error], [400, "subEnsLabel is not a valid name"], String(bad));
  }
  // Built without the name, sent with it: the server renders the name, so the bytes differ.
  const siteId = newSiteId();
  const { body } = deployBody(who, siteId, "https://gateway.woco-net.com");
  const r = await call(who, `/api/sites/${siteId}/deploy`, { ...body, site: { ...body.site, subEnsLabel: "acme-pub" } });
  assert.deepEqual([r.status, r.json.code], [409, "COLLECTION_MISMATCH"]);
  assert.deepEqual(bzzUploads, []);
  assert.deepEqual(feedHistory(shared.multisiteFeedTopic(siteId)), [], "no pointer moved");
});

test("event page: page-config is a signed GET with a query string, and the server checks the path it was signed over", async () => {
  const who = await organiser();
  const eventId = eventOf(who);
  const withQuery = await call(who, `/api/site/${eventId}/page-config?apiUrl=${encodeURIComponent(PUBLIC_BASE)}`, null, "GET");
  assert.equal(withQuery.status, 200, JSON.stringify(withQuery.json));
  assert.equal((withQuery.json.data as { config: { apiUrl: string } }).config.apiUrl, PUBLIC_BASE);
});

test("event page: the suggested head never ends on half of an emoji", async () => {
  const { EVENT_PAGE_TITLE_MAX, parseEventPageHead } = await import("@woco/shared");
  // getEvent is unavailable here, so test the shaping through the shared parser's rule directly:
  // a title cut at the limit inside a surrogate pair must still round-trip as text.
  const title = "x".repeat(EVENT_PAGE_TITLE_MAX - 1) + "\u{1F389}";
  let cut = title.slice(0, EVENT_PAGE_TITLE_MAX);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  assert.equal(cut, "x".repeat(EVENT_PAGE_TITLE_MAX - 1));
  assert.ok(parseEventPageHead({ title: cut }));
  const src = readFileSync(new URL("../src/routes/site.ts", import.meta.url), "utf8");
  assert.match(src, /if \(\/\[\\uD800-\\uDBFF\]\$\/\.test\(title\)\) title = title\.slice\(0, -1\);/, "the route drops a trailing high surrogate");
});

test("event page: only the creator gets the page config or publishes the page", async () => {
  const creator = await organiser();
  const stranger = await organiser();
  const eventId = eventOf(creator);
  const d = await pageDeployBody(creator, eventId);
  assert.equal((await call(stranger, `/api/site/${eventId}/page-config`, null, "GET")).status, 403);
  assert.equal((await call(stranger, "/api/site/deploy", d.body)).status, 403);
  assert.equal((await call(creator, `/api/site/evt-unknown-0001/page-config`, null, "GET")).status, 404);
});

// ---------------------------------------------------------------------------
// #55: description + schema.org facts in the head, only for an app that asks
// ---------------------------------------------------------------------------

/** An event as its feed holds it: enough for every head field. */
function feedEvent(over: Record<string, unknown> = {}) {
  return {
    eventId: "evt-x", title: "Friday Gig", tagline: "Live music every Friday", description: "Long text",
    imageHash: "AB".repeat(32), startDate: "2026-08-01T19:00:00.000Z", endDate: "2026-08-01T23:00:00.000Z",
    location: "The Lock Tavern, Camden",
    geo: { venue: "The Lock Tavern", city: "London", country: "GB", address: "35 Chalk Farm Rd", lat: 51.54, lng: -0.146 },
    series: [{
      seriesId: "s1", name: "GA", description: "", totalSupply: 10, price: 0,
      payment: { price: "12.50", currency: "GBP", recipientAddress: "0x0", acceptedChains: [], escrow: false, stripeEnabled: true },
    }],
    ...over,
  } as never;
}

test("event page: the suggested head adds the description and facts only for an app that asks (head=2, #55)", async () => {
  const { suggestedHead } = await import("../src/routes/site.js");
  const { eventLdFacts, parseEventPageHead } = await import("@woco/shared");
  const ev = feedEvent();
  // An app from before #55 passes the head through and renders title + image only.
  assert.deepEqual(suggestedHead(ev), { title: "Friday Gig", imageHash: "ab".repeat(32) });
  assert.deepEqual(suggestedHead(null, true), { title: "Event" }, "no event read: today's fallback");
  const head = suggestedHead(ev, true);
  assert.deepEqual(Object.keys(head), ["title", "imageHash", "description", "ld"]);
  assert.equal(head.description, "Live music every Friday");
  assert.deepEqual(head.ld, eventLdFacts(ev));
  assert.equal(head.ld!.offers![0]!.price, "12.50");
  assert.deepEqual(parseEventPageHead(JSON.parse(JSON.stringify(head))), head, "what the server suggests, it admits");
  // An online event: its description, no Event.
  const online = suggestedHead(feedEvent({ geo: { online: true } }), true);
  assert.deepEqual([online.description, online.ld], ["Live music every Friday", undefined]);
  // Nothing to say: the head is today's.
  const plain = { title: "Friday Gig", imageHash: "ab".repeat(32) };
  assert.deepEqual(suggestedHead(feedEvent({ tagline: "", description: "", startDate: "x" }), true), plain);
  // Data the projection throws on (fee arithmetic past a safe integer; a mistyped
  // organiser-signed feed): the plain head, never a failed page-config.
  const { ACCEPTED_COVER_FEE_RATES } = await import("@woco/shared");
  const absurd = feedEvent({ series: [{
    seriesId: "s1", name: "GA", description: "", totalSupply: 10, price: 0,
    payment: { price: "1e400", currency: "GBP", recipientAddress: "0x0", acceptedChains: [], escrow: false, feePassedToCustomer: true, coverFees: ACCEPTED_COVER_FEE_RATES[0] },
  }] });
  assert.deepEqual(suggestedHead(absurd, true), plain);
  assert.deepEqual(suggestedHead(feedEvent({ tagline: 7, series: [{ name: 5, saleStart: 9 }] }), true), plain);
});

test("event page: a build with the facts is admitted; one that dropped or changed them is refused before any upload (#55)", async () => {
  const { suggestedHead } = await import("../src/routes/site.js");
  const who = await organiser();
  const eventId = eventOf(who);
  const head = suggestedHead(feedEvent(), true);
  const before = contents.size;
  const withoutLd = await pageDeployBody(who, eventId, { title: head.title!, imageHash: head.imageHash });
  const dropped = await call(who, "/api/site/deploy", { ...withoutLd.body, head });
  assert.deepEqual([dropped.status, dropped.json.code], [409, "COLLECTION_MISMATCH"], "built without the facts, sent with them");
  assert.match(String(dropped.json.error), /reload the page/);
  const d = await pageDeployBody(who, eventId, head);
  const html = Buffer.from(d.body.collection.objects[0]!, "base64").toString("utf8");
  assert.match(html, /<script type="application\/ld\+json" data-woco-seo="event">\{"@context":"https:\/\/schema\.org","@type":"Event","name":"Friday Gig"/);
  const changed = { ...head, ld: { ...head.ld!, offers: [{ ...head.ld!.offers![0]!, price: "1.00" }] } };
  const altered = await call(who, "/api/site/deploy", { ...d.body, head: changed });
  assert.deepEqual([altered.status, altered.json.code], [409, "COLLECTION_MISMATCH"]);
  const malformed = await call(who, "/api/site/deploy", { ...d.body, head: { ...head, ld: { ...head.ld!, startDate: "soon" } } });
  assert.deepEqual([malformed.status, malformed.json.code], [400, "COLLECTION_MISMATCH"]);
  assert.equal(contents.size, before, "nothing stored");
  const r = await call(who, "/api/site/deploy", d.body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.data!.contentHash, d.root);
  await settle();
});

// ---------------------------------------------------------------------------
// The order, pinned at source for the branches a fake cannot reach offline
// (client-owned pointers need the organiser's own site SOC on the network).
// ---------------------------------------------------------------------------

const src = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

test("every pointer branch of the site deploy resolves its index once, before the upload", () => {
  const s = src("../src/routes/sites.ts");
  const route = s.slice(s.indexOf('sitesRouter.post("/:id/deploy"'));
  const upload = route.indexOf("uploadSiteObjects(");
  assert.ok(upload > 0);
  assert.equal(route.split("uploadSiteObjects(").length - 1, 1, "one upload path");
  // Both rails, one resolution (#912 slice 2b: Etherna's own lookup is gone).
  const at = route.indexOf("resolveFeedNextIndex(");
  assert.ok(at > 0 && at < upload, "resolveFeedNextIndex( before the upload");
  assert.equal(route.split("resolveFeedNextIndex(").length - 1, 1, "resolveFeedNextIndex( once");
  for (const gone of ["prepareEthernaFeedIndex(", "prepareEthernaFeedUpdate(", "fetchEthernaRootChunk("]) assert.ok(!route.includes(gone), gone);
  // An index nobody can settle refuses with a typed 503 before anything is stored.
  const refusal = route.indexOf("feedIndexUnavailableBody()");
  assert.ok(refusal > at && refusal < upload);
});

test("the deploy lock is taken only after ownership is settled, so a non-owner can never hold it", () => {
  for (const [file, route, ownerCheck] of [
    ["../src/routes/sites.ts", 'sitesRouter.post("/:id/deploy"', 'error: "Not the site owner"'],
    // pageGate is eventPageDeployGate unless a test swaps it (event-page-deploy-gate.test.ts pins that).
    ["../src/routes/site.ts", 'site.post("/deploy"', "pageGate(eventId, parentAddress)"],
  ] as const) {
    const s = src(file);
    const body = s.slice(s.indexOf(route));
    const check = body.indexOf(ownerCheck);
    const lock = body.indexOf("beginDeploy(");
    assert.ok(check > 0 && lock > check, `${file}: beginDeploy after the ownership check`);
  }
});

// ---------------------------------------------------------------------------
// Etherna down (#912 slice 2b): deploys land on WoCo and are listed to move back
// ---------------------------------------------------------------------------

/** Etherna down and the failover on, with a warm ledger of its own; restored after. */
async function withEthernaDown(mode: "auto" | "off", body: (ledger: typeof import("../src/lib/etherna/relay-ledger.js")) => Promise<void>): Promise<void> {
  const ledger = await import("../src/lib/etherna/relay-ledger.js");
  const soc = await import("../src/lib/swarm/soc-read.js");
  let t = Date.now();
  ledger.__resetRelayLedgerForTest({ now: () => t });
  rmSync(join(dir, ".data", "etherna-relay-ledger"), { recursive: true, force: true });
  ledger.loadRelayLedger();
  t += ledger.WARMUP_MS;
  if (mode === "auto") process.env.ETHERNA_FAILOVER = "auto";
  ethernaDown = true;
  try {
    await body(ledger);
  } finally {
    ethernaDown = false;
    delete process.env.ETHERNA_FAILOVER;
    soc.__resetEthernaBreaker();
    ledger.__resetRelayLedgerForTest();
    await settle();
  }
}

/** The addresses of the parts a deploy body carries, as bee addresses them at level 0. */
const partsOf = (objects: string[]) => objects.map((b64) => bytesTreeChunks(new Uint8Array(Buffer.from(b64, "base64"))).at(-1)!.address);

test("Etherna down: a website deploy lands on WoCo - every part, the manifest and the pointer listed for the owner", async () => {
  await withEthernaDown("auto", async (ledger) => {
    const who = await organiser();
    const siteId = newSiteId();
    const d = deployBody(who, siteId, ETHERNA_URL);
    const r = await call(who, `/api/sites/${siteId}/deploy`, d.body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(bzzUploads, ["bee"], "the root stamped on WoCo");
    const topic = shared.multisiteFeedTopic(siteId);
    const manifest = feedManifestFor(PLATFORM_OWNER, topic);
    assert.equal(r.json.data!.feedManifestHash, manifest);
    assert.equal(feedHistory(topic).length, 1, "the pointer written, on WoCo");
    const owner = who.address.toLowerCase();
    const expected = [...partsOf(d.body.collection.objects), manifest, updateAddress(PLATFORM_OWNER, topicHexOf(topic), 0n)];
    assert.equal(expected.at(-3), d.root);
    for (const addr of expected) {
      const e = ledger.getRelayEntry(addr);
      assert.equal(e?.status, "failover", addr);
      assert.equal(e?.parent, owner, addr);
    }
    // Still down: a redeploy takes the next index, resolved over both stores.
    await settle();
    feeds.__feedWriteTestHooks.clearCache();
    const again = await deploy(who, siteId, ETHERNA_URL);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(feedHistory(topic).length, 2, "index 1 - never the taken 0");
  });
});

test("Etherna down: an event page deploys on WoCo, its manifest listed, the browser handed index 0", async () => {
  await withEthernaDown("auto", async (ledger) => {
    const who = await organiser();
    const eventId = eventOf(who);
    const d = await pageDeployBody(who, eventId, { title: "Friday Gig", imageHash: "ab".repeat(32) });
    const r = await call(who, "/api/site/deploy", d.body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.data!.pageFeed, { owner: PAGE_SIGNER, nextIndex: 0 });
    const manifest = feedManifestFor(PAGE_SIGNER, shared.eventPageFeedTopic(eventId));
    assert.equal(r.json.data!.feedManifestHash, manifest);
    for (const addr of [d.root, manifest]) assert.equal(ledger.getRelayEntry(addr)?.parent, who.address.toLowerCase(), addr);
  });
});

test("Etherna down: an update sent to Etherna and not yet on our bee refuses the deploy - typed 503, nothing stored", async () => {
  await withEthernaDown("auto", async (ledger) => {
    const who = await organiser();
    const siteId = newSiteId();
    const topicHex = topicHexOf(shared.multisiteFeedTopic(siteId));
    const id = Binary.uint8ArrayToHex(Binary.keccak256(Binary.concatBytes(unhex(topicHex), FeedIndex.fromBigInt(0n).toUint8Array())));
    ledger.noteEthernaSend(updateAddress(PLATFORM_OWNER, topicHex, 0n), PLATFORM_OWNER, id);
    const r = await deploy(who, siteId, ETHERNA_URL);
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.code, "STORAGE_UNAVAILABLE");
    assert.deepEqual(bzzUploads, []);
    assert.equal(ledger.relayLedgerState().failover, 0, "nothing stamped, nothing listed");
  });
});

test("Etherna down, failover off: the deploy fails as before - nothing stamped on WoCo", async () => {
  await withEthernaDown("off", async (ledger) => {
    const who = await organiser();
    const r = await deploy(who, newSiteId(), ETHERNA_URL);
    assert.ok(r.status >= 500, JSON.stringify(r.json));
    assert.deepEqual(bzzUploads, []);
    assert.equal(ledger.relayLedgerState().failover, 0);
  });
});
