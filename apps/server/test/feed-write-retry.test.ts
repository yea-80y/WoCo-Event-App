/**
 * Feed writes: the retry table (#120) and the next-index cache (#186).
 *
 * The fakes behave like bee 2.7.1 where it matters, because the old fake did not
 * and the tests passed while production lost edits:
 *  - a SOC upload at a taken address answers 201 and KEEPS the bytes already
 *    there (it never 409s);
 *  - a feed lookup can read BEHIND the network (bee's walk counts a slow probe
 *    as missing), while a chunk read by address is a full retrieval;
 *  - 404 "no update found" and 404 "lookup at failed" are different answers.
 *
 * Pinned: a read never lowers the cached index (that rewind lost the next edit),
 * a lost write is refilled in place rather than skipped (a max() would leave a
 * hole bee's walk never crosses), every resolution starts at the lookup and
 * walks forward by chunk reads, a write is read back, and a read inside the
 * window returns what this server just wrote.
 *
 * One HTTP chunk store stands for the network; our bee and Etherna are two
 * fronts on it. No real network.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "ethers";
import { FeedIndex, PrivateKey, Topic } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import { calculateCacAddress, calculateSocAddress, encodeSpan } from "@woco/shared";
import { decideFeedWriteRetry, type FeedWriteErrorFacts } from "../src/lib/swarm/feed-write-retry.js";

// ---------------------------------------------------------------------------
// Decision table (pure)
// ---------------------------------------------------------------------------

describe("decideFeedWriteRetry", () => {
  const base: FeedWriteErrorFacts = {
    status: undefined,
    transient: false,
    attempt: 0,
    maxAttempts: 5,
    etherna: false,
    fresh: false,
  };
  const d = (over: Partial<FeedWriteErrorFacts>) => decideFeedWriteRetry({ ...base, ...over }).action;

  test("transient errors retry at the same index until the last attempt", () => {
    assert.equal(d({ transient: true, status: 503 }), "retry-transient");
    assert.equal(d({ transient: true, attempt: 3 }), "retry-transient");
    assert.equal(d({ transient: true, attempt: 4 }), "throw");
  });

  test("a 404 from an upload is batch-not-found, never 'feed empty': throw, on both rails", () => {
    assert.equal(d({ status: 404 }), "throw");
    assert.equal(d({ status: 404, etherna: true }), "throw");
  });

  test("409 re-discovers the index, on both rails, until the last attempt", () => {
    assert.equal(d({ status: 409 }), "rediscover-index");
    assert.equal(d({ status: 409, etherna: true }), "rediscover-index");
    assert.equal(d({ status: 409, attempt: 4 }), "throw");
  });

  test("409 on a `fresh` write is a violated assumption, not a stale cache — throw", () => {
    assert.equal(d({ status: 409, fresh: true }), "throw");
  });

  test("anything else throws", () => {
    assert.equal(d({ status: 400 }), "throw");
    assert.equal(d({ status: 402 }), "throw");
    assert.equal(d({}), "throw");
  });
});

// ---------------------------------------------------------------------------
// The network, our bee, Etherna
// ---------------------------------------------------------------------------

const KEY = "0x" + "11".repeat(32);
const OWNER = new Wallet(KEY).address.slice(2).toLowerCase();
const OTHER_KEY = "0x" + "22".repeat(32);
const OTHER_OWNER = new Wallet(OTHER_KEY).address.slice(2).toLowerCase();

/** address -> stored SOC (identifier ‖ signature ‖ span ‖ payload). First write wins. */
const chunks = new Map<string, Uint8Array>();
/** Addresses that reached the network through Etherna. */
const viaEtherna = new Set<string>();

const net = {
  /** Our bee does not see Etherna writes yet (the lag): neither its feed walk
   *  nor a chunk read finds them - seconds to minutes in production
   *  (apps/web/src/lib/swarm/content-feed.ts, knownChunkProbe). */
  beeMissesEtherna: false,
  /** Our bee's feed walk also stops this many updates short. */
  lookupBehind: 0,
  /** GET /feeds answers this instead of walking. */
  lookupAnswer: null as null | { status: number; message: string },
  /** GET /chunks on our bee answers 500. */
  beeChunks500: false,
  /** POST /soc on our bee answers this status instead of storing. */
  beeUploadFails: null as null | number,
  /** Etherna's GET /feeds: a status, and for 200 the next index it reports. */
  ethernaFeeds: { status: 404 } as { status: number; next?: bigint },
  feedLookups: 0,
};

/** A content root chunk Etherna serves for the deploy-pointer tests (span ‖ data). */
const CONTENT_HASH = "cc".repeat(32);

/** Every upload attempt, as (rail, index) — the index read off the identifier. */
const uploads: Array<{ via: "bee" | "etherna"; owner: string; index: bigint | null }> = [];

const hex = (b: Uint8Array) => Binary.uint8ArrayToHex(b);
const unhex = (h: string) => Binary.hexToUint8Array(h);

function identifierFor(topic: Topic, index: bigint): Uint8Array {
  return Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), FeedIndex.fromBigInt(index).toUint8Array()));
}
function addressFor(owner: string, topic: Topic, index: bigint): string {
  return hex(calculateSocAddress(identifierFor(topic, index), unhex(owner)));
}

/** Topics the fakes are asked about, so an identifier can be mapped back to its index. */
const knownTopics: Topic[] = [];
function indexOfIdentifier(idHex: string): bigint | null {
  for (const t of knownTopics) for (let i = 0n; i < 64n; i++) if (hex(identifierFor(t, i)) === idHex) return i;
  return null;
}

/** Put a signed update straight onto the network — another writer, or an old one. */
function seed(topic: Topic, index: bigint, payload: Uint8Array, key = KEY, via: "bee" | "etherna" = "bee"): void {
  const id = identifierFor(topic, index);
  const span = encodeSpan(payload.length);
  const sig = new PrivateKey(key.slice(2)).sign(Binary.concatBytes(id, calculateCacAddress(span, payload)));
  const owner = new Wallet(key).address.slice(2).toLowerCase();
  const addr = addressFor(owner, topic, index);
  if (chunks.has(addr)) return;
  chunks.set(addr, Binary.concatBytes(id, sig.toUint8Array(), span, payload));
  if (via === "etherna") viaEtherna.add(addr);
}

function payloadAt(owner: string, topic: Topic, index: bigint): Uint8Array | undefined {
  return chunks.get(addressFor(owner, topic, index))?.subarray(32 + 65 + 8);
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

/** POST /soc/{owner}/{id}?sig= — first write wins, 201 either way (bee 2.7.1). */
async function handleSocPost(req: IncomingMessage, res: ServerResponse, via: "bee" | "etherna"): Promise<void> {
  const url = new URL(req.url ?? "", "http://x");
  const [, , owner, id] = url.pathname.split("/");
  const body = await readBody(req);
  uploads.push({ via, owner: owner!.toLowerCase(), index: indexOfIdentifier(id!.toLowerCase()) });
  if (via === "bee" && net.beeUploadFails) return json(res, net.beeUploadFails, { code: net.beeUploadFails, message: "batch with id not found" });
  const addr = hex(calculateSocAddress(unhex(id!), unhex(owner!)));
  if (!chunks.has(addr)) {
    chunks.set(addr, Binary.concatBytes(unhex(id!), unhex(url.searchParams.get("sig")!), body));
    if (via === "etherna") viaEtherna.add(addr);
  }
  json(res, 201, { reference: addr });
}

function handleChunkGet(res: ServerResponse, addr: string): void {
  const c = chunks.get(addr.toLowerCase());
  if (!c) return json(res, 404, { code: 404, message: "chunk not found" });
  res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from(c));
}

const bee: Server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  if (req.method === "POST" && path.startsWith("/soc/")) return handleSocPost(req, res, "bee");
  if (req.method === "GET" && path.startsWith("/chunks/")) {
    if (net.beeChunks500) return json(res, 500, { code: 500, message: "read chunk failed" });
    const addr = path.split("/")[2]!.toLowerCase();
    if (net.beeMissesEtherna && viaEtherna.has(addr)) return json(res, 404, { code: 404, message: "chunk not found" });
    return handleChunkGet(res, addr);
  }
  const m = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/i.exec(path);
  if (req.method === "GET" && m) {
    net.feedLookups++;
    if (net.lookupAnswer) return json(res, net.lookupAnswer.status, { code: net.lookupAnswer.status, message: net.lookupAnswer.message });
    const owner = m[1]!.toLowerCase();
    const topic = knownTopics.find((t) => t.toHex() === m[2]!.toLowerCase());
    const visible = (i: bigint) => {
      const a = topic && addressFor(owner, topic, i);
      return !!a && chunks.has(a) && !(net.beeMissesEtherna && viaEtherna.has(a));
    };
    let latest = -1n;
    while (visible(latest + 1n)) latest++;
    latest -= BigInt(net.lookupBehind);
    if (latest < 0n) return json(res, 404, { code: 404, message: "no update found" });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "swarm-feed-index": FeedIndex.fromBigInt(latest).toHex(),
      "swarm-feed-index-next": FeedIndex.fromBigInt(latest + 1n).toHex(),
    }).end(Buffer.from(payloadAt(owner, topic!, latest)!));
    return;
  }
  json(res, 404, { code: 404, message: "Not Found" });
});

const etherna: Server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  if (req.method === "GET" && path === `/chunks/${CONTENT_HASH}`) {
    res.writeHead(200).end(Buffer.from(Binary.concatBytes(encodeSpan(3), new Uint8Array([1, 2, 3]))));
    return;
  }
  if (req.method === "POST" && path === "/token") return json(res, 200, { access_token: "t", expires_in: 3600 });
  if (req.method === "POST" && path.startsWith("/soc/")) return handleSocPost(req, res, "etherna");
  if (req.method === "GET" && path.startsWith("/chunks/")) return handleChunkGet(res, path.split("/")[2]!);
  if (req.method === "POST" && path.includes("/offers")) return json(res, 200, {});
  if (req.method === "POST" && path.startsWith("/feeds/")) return json(res, 201, { reference: "ee".repeat(32) });
  if (req.method === "GET" && path.startsWith("/feeds/")) {
    const a = net.ethernaFeeds;
    if (a.status !== 200) return json(res, a.status, { code: a.status, message: "x" });
    res.writeHead(200, { "swarm-feed-index-next": FeedIndex.fromBigInt(a.next!).toHex() }).end();
    return;
  }
  json(res, 404, { code: 404, message: "Not Found" });
});

let swarm: typeof import("../src/config/swarm.js");
let feeds: typeof import("../src/lib/swarm/feeds.js");
let socRead: typeof import("../src/lib/swarm/soc-read.js");
let upload: typeof import("../src/lib/etherna/upload.js");

const ETHERNA = { target: "etherna" as const, batchId: "cd".repeat(32) };
let topicSeq = 0;
function freshTopic(): Topic {
  const t = Topic.fromString(`woco/test/feed-write/${topicSeq++}`);
  knownTopics.push(t);
  return t;
}
function page(text: string): Uint8Array {
  return feeds.encodeJsonFeed({ text });
}
function textAt(owner: string, topic: Topic, index: bigint): string | undefined {
  const p = payloadAt(owner, topic, index);
  return p ? (feeds.decodeJsonFeed<{ text: string }>(p)?.text) : undefined;
}

before(async () => {
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => etherna.listen(0, "127.0.0.1", r));
  const ethernaUrl = `http://127.0.0.1:${(etherna.address() as AddressInfo).port}`;
  process.env.BEE_URL = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  process.env.PROXY_URL = "http://127.0.0.1:9";
  process.env.ETHERNA_ENABLED = "true";
  process.env.ETHERNA_API_KEY = "id.secret";
  process.env.ETHERNA_GATEWAY_URL = ethernaUrl;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${ethernaUrl}/token`;
  process.env.FEED_PRIVATE_KEY = KEY;
  process.env.POSTAGE_BATCH_ID = "ab".repeat(32);
  swarm = await import("../src/config/swarm.js");
  feeds = await import("../src/lib/swarm/feeds.js");
  socRead = await import("../src/lib/swarm/soc-read.js");
  upload = await import("../src/lib/etherna/upload.js");
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
});

after(() => {
  bee.close();
  etherna.close();
});

beforeEach(() => {
  feeds.__feedWriteTestHooks.clearCache();
  feeds.__feedWriteTestHooks.setClock(null);
  swarm.__setBeeForTests(null);
  socRead.__resetEthernaBreaker();
  Object.assign(net, {
    beeMissesEtherna: false,
    lookupBehind: 0,
    lookupAnswer: null,
    beeChunks500: false,
    beeUploadFails: null,
    ethernaFeeds: { status: 404 },
    feedLookups: 0,
  });
  uploads.length = 0;
});

const hooks = () => feeds.__feedWriteTestHooks;

// ---------------------------------------------------------------------------
// Reads never lower the cache
// ---------------------------------------------------------------------------

describe("the cached next index", () => {
  test("a read behind the cache disputes it and leaves it; a read ahead raises it", async () => {
    const t = freshTopic();
    seed(t, 0n, page("a"));
    seed(t, 1n, page("b"));
    await feeds.writeFeedPage(t, page("c"));
    assert.equal(hooks().cachedNextIndex(t), 3n);

    net.lookupBehind = 2;
    await feeds.readFeedPage(t);
    assert.equal(hooks().cachedNextIndex(t), 3n, "a lagging read must not rewind the cache");
    assert.equal(hooks().cachedEntry(t)!.disputed, true);

    net.lookupBehind = 0;
    seed(t, 3n, page("d"));
    await feeds.readFeedPage(t);
    assert.equal(hooks().cachedNextIndex(t), 4n);
  });

  test("THE BUG (#186): an Etherna feed read inside the lag, then edited — the edit lands, nothing is overwritten", async () => {
    const t = freshTopic();
    net.beeMissesEtherna = true; // our bee never sees Etherna writes in this test
    await feeds.writeFeedPage(t, page("v1"), { dest: ETHERNA });
    await feeds.writeFeedPage(t, page("v2"), { dest: ETHERNA });
    await feeds.readFeedPageStrict(t); // bee: "no update found"
    await feeds.writeFeedPage(t, page("v3"), { dest: ETHERNA });
    assert.deepEqual(
      [0n, 1n, 2n].map((i) => textAt(OWNER, t, i)),
      ["v1", "v2", "v3"],
    );
  });

  test("disputed, and our last write is there: write at the cached index, no lookup", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    await feeds.writeFeedPage(t, page("b"));
    net.lookupBehind = 1;
    await feeds.readFeedPage(t);
    const lookups = net.feedLookups;
    await feeds.writeFeedPage(t, page("c"));
    assert.equal(textAt(OWNER, t, 2n), "c");
    assert.equal(net.feedLookups, lookups, "the dispute is settled by one chunk read");
    assert.equal(hooks().cachedEntry(t)!.disputed, false);
  });

  test("disputed, and our last write is GONE: refill the hole, never write past it", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    await feeds.writeFeedPage(t, page("b")); // index 1 — then lost
    chunks.delete(addressFor(OWNER, t, 1n));
    await feeds.readFeedPage(t); // bee: next = 1, below the cache (2)
    await feeds.writeFeedPage(t, page("c"));
    assert.equal(textAt(OWNER, t, 1n), "c", "a max() would have written index 2 behind a hole");
    assert.equal(textAt(OWNER, t, 2n), undefined);
  });

  test("disputed and nothing can be checked: refuse, write nothing", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    net.lookupBehind = 1;
    await feeds.readFeedPage(t);
    net.beeChunks500 = true;
    uploads.length = 0;
    await assert.rejects(feeds.writeFeedPage(t, page("b")), /cannot tell whether index/);
    assert.equal(uploads.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Resolution: lookup is the start, chunk reads find the end
// ---------------------------------------------------------------------------

describe("resolving the index (cold cache)", () => {
  test("never-written feed: 'no update found', index 0 checked, written at 0", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    assert.deepEqual(uploads.map((u) => u.index), [0n]);
  });

  test("a lookup that reads behind is walked forward to the real head", async () => {
    const t = freshTopic();
    for (let i = 0n; i < 5n; i++) seed(t, i, page(`old${i}`));
    net.lookupBehind = 3;
    await feeds.writeFeedPage(t, page("new"));
    assert.equal(textAt(OWNER, t, 5n), "new");
    assert.deepEqual(uploads.map((u) => u.index), [5n]);
  });

  test("every upload names its index — never bee-js discovery, which answers 0 on any bee error", async () => {
    const t = freshTopic();
    seed(t, 0n, page("a"));
    await feeds.writeFeedPage(t, page("b"));
    assert.ok(uploads.every((u) => u.index !== null));
    assert.equal(textAt(OWNER, t, 1n), "b");
  });

  test("lookup 500: refuse, write nothing", async () => {
    const t = freshTopic();
    net.lookupAnswer = { status: 500, message: "boom" };
    await assert.rejects(feeds.writeFeedPage(t, page("a")));
    assert.equal(uploads.length, 0);
  });

  test("'lookup at failed' on a live feed is an error, not absent — the read and the write both refuse", async () => {
    const t = freshTopic();
    seed(t, 0n, page("a"));
    net.lookupAnswer = { status: 404, message: "lookup at failed" };
    const r = await feeds.readFeedPageStrict(t);
    assert.equal(r.status, "error");
    await assert.rejects(feeds.writeFeedPage(t, page("b")));
    assert.equal(uploads.length, 0);
  });

  test("a 404 with any other message is checked against index 0: absent only if index 0 is", async () => {
    const t = freshTopic();
    net.lookupAnswer = { status: 404, message: "something new" };
    assert.equal((await feeds.readFeedPageStrict(t)).status, "absent");
    seed(t, 0n, page("a"));
    assert.equal((await feeds.readFeedPageStrict(t)).status, "error");
  });

  test("Etherna, cold, lookup behind: walked forward against Etherna", async () => {
    const t = freshTopic();
    for (let i = 0n; i < 3n; i++) seed(t, i, page(`e${i}`), KEY, "etherna");
    net.beeMissesEtherna = true;
    await feeds.writeFeedPage(t, page("new"), { dest: ETHERNA });
    assert.equal(textAt(OWNER, t, 3n), "new");
    assert.deepEqual(uploads.map((u) => [u.via, u.index]), [["etherna", 3n]]);
  });

  test("an index confirmed on one destination is re-resolved for the other", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    assert.equal(hooks().cachedEntry(t)!.confirmedAt, "woco");
    seed(t, 1n, page("b"), KEY, "etherna"); // someone moved this feed to Etherna before us
    net.beeMissesEtherna = true;
    uploads.length = 0;
    await feeds.writeFeedPage(t, page("c"), { dest: ETHERNA });
    assert.equal(textAt(OWNER, t, 2n), "c");
    assert.deepEqual(uploads.map((u) => u.index), [2n], "no upload onto the taken index 1");
  });

  test("a read-primed entry is not trusted for an Etherna write", async () => {
    const t = freshTopic();
    seed(t, 0n, page("a"));
    seed(t, 1n, page("b"), KEY, "etherna");
    net.beeMissesEtherna = true;
    await feeds.readFeedPage(t); // primes next = 1 from our lagging bee
    assert.equal(hooks().cachedEntry(t)!.confirmedAt, null);
    await feeds.writeFeedPage(t, page("c"), { dest: ETHERNA });
    assert.equal(textAt(OWNER, t, 2n), "c");
    assert.equal(textAt(OWNER, t, 1n), "b");
    // Not rescued by the read-back: an upload onto a taken index may REPLACE
    // that update on the network later (a newer stamp), so it must not happen.
    assert.deepEqual(uploads.map((u) => u.index), [2n]);
  });

  test("a write after a cold read walks on from the read's index — no second lookup", async () => {
    const t = freshTopic();
    seed(t, 0n, page("a"));
    seed(t, 1n, page("b"));
    await feeds.readFeedPageStrict(t);
    const lookups = net.feedLookups;
    await feeds.writeFeedPage(t, page("c"));
    assert.equal(net.feedLookups, lookups);
    assert.equal(textAt(OWNER, t, 2n), "c");
  });

  test("resolveFeedNextIndex serves another owner's feed (client-owned site pointer)", async () => {
    const t = freshTopic();
    seed(t, 0n, page("x"), OTHER_KEY);
    seed(t, 1n, page("y"), OTHER_KEY);
    net.lookupBehind = 1;
    assert.equal(await feeds.resolveFeedNextIndex(t, `0x${OTHER_OWNER}`, "woco"), 2n);
  });
});

// ---------------------------------------------------------------------------
// After the upload
// ---------------------------------------------------------------------------

describe("read-back", () => {
  test("the index already held another update (a second writer): the write moves past it", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a")); // cache: 1
    seed(t, 1n, page("someone else")); // same key, another process
    await feeds.writeFeedPage(t, page("b"));
    assert.equal(textAt(OWNER, t, 1n), "someone else");
    assert.equal(textAt(OWNER, t, 2n), "b");
    assert.equal(hooks().cachedNextIndex(t), 3n);
  });

  test("a fresh write whose index 0 is taken throws instead of appending", async () => {
    const t = freshTopic();
    seed(t, 0n, page("already"));
    await assert.rejects(feeds.writeFeedPage(t, page("mine"), { fresh: true }), /fresh/);
  });

  test("read-back cannot be asked: the write stands, and the next one checks it", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a")); // cache confirmed: the next write reads no chunk first
    net.beeChunks500 = true;
    await feeds.writeFeedPage(t, page("b"));
    assert.equal(hooks().cachedEntry(t)!.disputed, true);
    assert.equal(textAt(OWNER, t, 1n), "b");
  });

  test("an upload 404 (batch not found) throws — it used to rewrite at index 0", async () => {
    const t = freshTopic();
    seed(t, 0n, page("a"));
    await feeds.writeFeedPage(t, page("b"));
    net.beeUploadFails = 404;
    uploads.length = 0;
    await assert.rejects(feeds.writeFeedPage(t, page("c")));
    assert.deepEqual(uploads.map((u) => u.index), [2n]);
  });

  test("a page over 4096 bytes is refused before anything is sent", async () => {
    const t = freshTopic();
    await assert.rejects(feeds.writeFeedPage(t, new Uint8Array(4097)), /max 4096/);
    assert.equal(uploads.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Read-your-writes
// ---------------------------------------------------------------------------

describe("read-your-writes", () => {
  test("bee behind our write: the read returns our page; level or ahead: bee's; after the window: bee's", async () => {
    let clock = 1_000_000;
    hooks().setClock(() => clock);
    const t = freshTopic();
    seed(t, 0n, page("old"));
    await feeds.writeFeedPage(t, page("mine"));

    net.lookupBehind = 1;
    const behind = await feeds.readFeedPageStrict(t);
    assert.equal(behind.status === "ok" && feeds.decodeJsonFeed<{ text: string }>(behind.data)?.text, "mine");

    net.lookupBehind = 0;
    const level = await feeds.readFeedPage(t);
    assert.equal(feeds.decodeJsonFeed<{ text: string }>(level!)?.text, "mine");

    seed(t, 2n, page("theirs"));
    const ahead = await feeds.readFeedPage(t);
    assert.equal(feeds.decodeJsonFeed<{ text: string }>(ahead!)?.text, "theirs");

    net.lookupBehind = 2;
    clock += feeds.READ_YOUR_WRITES_MS;
    const late = await feeds.readFeedPage(t);
    assert.equal(feeds.decodeJsonFeed<{ text: string }>(late!)?.text, "old");
  });

  test("bee says absent or errors inside the window: our page", async () => {
    const t = freshTopic();
    net.beeMissesEtherna = true;
    await feeds.writeFeedPage(t, page("first"), { dest: ETHERNA });
    const absent = await feeds.readFeedPageStrict(t);
    assert.equal(absent.status === "ok" && feeds.decodeJsonFeed<{ text: string }>(absent.data)?.text, "first");
    net.lookupAnswer = { status: 500, message: "boom" };
    const failed = await feeds.readFeedPageStrict(t);
    assert.equal(failed.status, "ok");
  });

  test("PAST the window, a write-path read that bee answers ABSENT for a feed we wrote: our page, once Etherna confirms it (Fable F2)", async () => {
    let clock = 1_000_000;
    hooks().setClock(() => clock);
    const t = freshTopic();
    net.beeMissesEtherna = true; // the lag outlives the window
    await feeds.writeFeedPage(t, page("published list"), { dest: ETHERNA });
    clock += feeds.READ_YOUR_WRITES_MS + 1;
    const strict = await feeds.readFeedPageStrict(t);
    assert.equal(strict.status === "ok" && feeds.decodeJsonFeed<{ text: string }>(strict.data)?.text, "published list",
      "absent here used to bootstrap an empty list and wipe the published one");
    assert.equal(await feeds.readFeedPage(t), null, "a display read takes bee's answer, as before");
    await feeds.writeFeedPage(t, page("published list + new event"), { dest: ETHERNA });
    assert.equal(textAt(OWNER, t, 1n), "published list + new event");
  });

  test("past the window, bee OLDER than our write: a write-path read still gets ours", async () => {
    let clock = 1_000_000;
    hooks().setClock(() => clock);
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    await feeds.writeFeedPage(t, page("b"));
    clock += feeds.READ_YOUR_WRITES_MS + 1;
    net.lookupBehind = 1;
    const strict = await feeds.readFeedPageStrict(t);
    assert.equal(strict.status === "ok" && feeds.decodeJsonFeed<{ text: string }>(strict.data)?.text, "b");
    assert.equal(feeds.decodeJsonFeed<{ text: string }>((await feeds.readFeedPage(t))!)?.text, "a");
  });

  test("past the window, our update GONE: bee's answer stands, and the next write refills the hole", async () => {
    let clock = 1_000_000;
    hooks().setClock(() => clock);
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    await feeds.writeFeedPage(t, page("b"));
    chunks.delete(addressFor(OWNER, t, 1n));
    clock += feeds.READ_YOUR_WRITES_MS + 1;
    const strict = await feeds.readFeedPageStrict(t);
    assert.equal(strict.status === "ok" && feeds.decodeJsonFeed<{ text: string }>(strict.data)?.text, "a");
    await feeds.writeFeedPage(t, page("a + c"));
    assert.equal(textAt(OWNER, t, 1n), "a + c");
  });

  test("past the window, our update cannot be confirmed: a write-path read refuses", async () => {
    let clock = 1_000_000;
    hooks().setClock(() => clock);
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    await feeds.writeFeedPage(t, page("b"));
    clock += feeds.READ_YOUR_WRITES_MS + 1;
    net.lookupBehind = 1;
    net.beeChunks500 = true;
    assert.equal((await feeds.readFeedPageStrict(t)).status, "error");
  });

  test("the returned page is a copy", async () => {
    const t = freshTopic();
    await feeds.writeFeedPage(t, page("a"));
    net.lookupAnswer = { status: 500, message: "boom" };
    const one = await feeds.readFeedPage(t);
    one!.fill(0);
    const two = await feeds.readFeedPage(t);
    assert.equal(feeds.decodeJsonFeed<{ text: string }>(two!)?.text, "a");
  });
});

// ---------------------------------------------------------------------------
// Deploy pointer feeds (no cache, same lost-write class)
// ---------------------------------------------------------------------------

describe("prepareEthernaFeedUpdate", () => {
  const prep = (topic: Topic, owner: string) =>
    upload.prepareEthernaFeedUpdate({ topic, contentHash: CONTENT_HASH, batchId: ETHERNA.batchId, ownerHex: owner });

  test("an Etherna lookup error throws — any non-OK used to mean index 0, keeping the old pointer", async () => {
    const t = freshTopic();
    seed(t, 0n, page("old pointer"), OTHER_KEY, "etherna");
    net.ethernaFeeds = { status: 500 };
    await assert.rejects(prep(t, OTHER_OWNER), /Etherna feed lookup 500/);
  });

  test("404 starts at 0 and walks; a lookup behind is walked forward", async () => {
    const fresh = freshTopic();
    assert.equal((await prep(fresh, OTHER_OWNER)).nextIndex, 0n);
    const t = freshTopic();
    for (let i = 0n; i < 3n; i++) seed(t, i, page(`p${i}`), OTHER_KEY, "etherna");
    net.ethernaFeeds = { status: 200, next: 1n };
    assert.equal((await prep(t, OTHER_OWNER)).nextIndex, 3n);
  });
});

// ---------------------------------------------------------------------------
// No feed upload without an index, anywhere in the server
// ---------------------------------------------------------------------------

test("every bee-js feed upload in the server names its index (F1: the WoCo site pointer did not)", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  let calls = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\.(uploadPayload|uploadReference)\(/g)) {
      // The argument list up to the matching close paren.
      let depth = 0;
      let end = m.index! + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")" && --depth === 0) break;
      }
      calls++;
      assert.match(src.slice(m.index!, end), /index/, `${f}: ${src.slice(m.index!, end + 1)}`);
    }
  }
  assert.ok(calls >= 4, "the scan found the known call sites");
});
