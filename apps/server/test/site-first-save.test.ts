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
import { calculateSocAddress, encodeSpan } from "@woco/shared";
import { enableFeature } from "./helpers/features.js";

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
/** Content hash -> its root chunk (span ‖ data), as bee serves it from /chunks. */
const contents = new Map<string, Uint8Array>();
/** Collection uploads, per front. */
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

async function bzzPost(req: IncomingMessage, res: ServerResponse, via: "bee" | "etherna"): Promise<void> {
  const body = await readBody(req);
  bzzUploads.push(via);
  const data = createHash("sha256").update(body).digest();
  const reference = createHash("sha256").update(data).update(via).digest("hex");
  contents.set(reference, Binary.concatBytes(encodeSpan(data.length), new Uint8Array(data)));
  json(res, 201, { reference });
}

const bee: Server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  if (req.method === "POST" && path.startsWith("/soc/")) return socPost(req, res);
  if (req.method === "POST" && path === "/bzz") return bzzPost(req, res, "bee");
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
  if (req.method === "POST" && path === "/bzz") return bzzPost(req, res, "etherna");
  if (req.method === "POST" && path.startsWith("/soc/")) return socPost(req, res);
  if (req.method === "POST" && path.includes("/offers")) return json(res, 200, {});
  if (req.method === "POST" && path.startsWith("/feeds/")) return json(res, 201, { reference: "ef".repeat(32) });
  if (req.method === "GET" && path.startsWith("/feeds/")) return json(res, 404, { code: 404, message: "no update found" });
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
  const template = join(dir, "dist-multisite");
  mkdirSync(template);
  writeFileSync(join(template, "multi-site.html"), "<!doctype html><html><head></head><body></body></html>");

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
  sites.__sitesDeployTestHooks.setDistMultisitePath(template);
  const { siteRoute } = await import("../src/routes/site.js");
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

async function call(parent: Wallet, path: string, payload: unknown): Promise<Reply> {
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
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const reqNonce = randomUUID();
  const challenge = ["woco-session-v1", "POST", path, ts, reqNonce, sha256Hex(body)].join("\n");
  const resp = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Address": session.address,
      "X-Session-Delegation": Buffer.from(JSON.stringify({ message, parentSig })).toString("base64"),
      "X-Session-Sig": await session.signMessage(challenge),
      "X-Session-Nonce": reqNonce,
      "X-Session-Timestamp": ts,
    },
    body,
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
const deploy = (who: Wallet, siteId: string, gatewayUrl: string) =>
  call(who, `/api/sites/${siteId}/deploy`, { apiUrl: PUBLIC_BASE, gatewayUrl, site: siteFor(siteId) });

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
  assert.equal(ok.json.data!.feedManifestHash, "ef".repeat(32));
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
    if (String(input).endsWith("/bzz")) await held;
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
  const upload = Math.min(route.indexOf("uploadCollectionToEtherna("), route.indexOf("fetch(`${BEE_URL}/bzz`"));
  assert.ok(upload > 0);
  for (const resolver of ["prepareEthernaFeedIndex(", "resolveFeedNextIndex("]) {
    const at = route.indexOf(resolver);
    assert.ok(at > 0 && at < upload, `${resolver} before the upload`);
    assert.equal(route.split(resolver).length - 1, 1, `${resolver} once`);
  }
  assert.ok(!route.includes("prepareEthernaFeedUpdate("), "no resolution bundled with the post-upload chunk read");
});
