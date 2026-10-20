/**
 * The creator's site directory (`woco/site/creator/{addr}`), owner report
 * 2026-10-20: a creator's FIRST site never reached it.
 *
 * Cause, verified on production: bee 2.8 puts every neighbourhood peer on a
 * node-wide one-minute skip list after a few misses of the same chunk inside a
 * minute. A never-written directory's index-0 chunk misses on every read, and
 * the builder read it on each open, so by Publish the chunk was skip-listed:
 * `GET /feeds` answered 404 "lookup at failed" and `GET /chunks` 500 "read chunk
 * failed". The strict read rightly called that an error, and the upsert was
 * dropped with a log line.
 *
 * Pinned here against a fake bee holding real signed SOCs:
 *  - that bee answer is an ERROR for the strict read, never absent;
 *  - the upsert retries after 70 s and 140 s (past the skip window), writes
 *    nothing while the directory is unreadable, and on giving up logs the whole
 *    entry for replay;
 *  - a publish and its deploy end as ONE entry with both sets of fields;
 *  - a display read memoizes "absent" for 90 s, never an error, and an upsert
 *    clears it.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { FeedIndex, Topic } from "@ethersphere/bee-js";
import { Binary } from "cafe-utility";
import type { SiteDirectoryEntry, Hex0x } from "@woco/shared";

const DEAD = "http://127.0.0.1:9";
const KEY = Wallet.createRandom().privateKey;
const OWNER = new Wallet(KEY).address.slice(2).toLowerCase();

// ---------------------------------------------------------------------------
// The fake bee: one SOC store, first write wins (bee 2.7+), plus bee's
// skip-list answers on demand.
// ---------------------------------------------------------------------------

/** SOC address -> identifier ‖ signature ‖ span ‖ payload. */
const chunks = new Map<string, Uint8Array>();
const posted: string[] = [];
const net = {
  /** GET /feeds answers 404 "lookup at failed" (bee's walk failed). */
  lookupFailed: false,
  /** GET /chunks answers 500 "read chunk failed". */
  chunks500: false,
  feedLookups: 0,
  /** Hold the next lookup of this topic: answer computed on arrival, sent on release. */
  holdOnce: null as null | { topicHex: string; arrived: () => void; release: Promise<void> },
};
function skipListed(on: boolean): void {
  net.lookupFailed = on;
  net.chunks500 = on;
}

const hex = (b: Uint8Array) => Binary.uint8ArrayToHex(b);
const unhex = (h: string) => Binary.hexToUint8Array(h);
let calculateSocAddress: typeof import("@woco/shared").calculateSocAddress;

function addressFor(owner: string, topicHex: string, index: bigint): string {
  const id = Binary.keccak256(Binary.concatBytes(unhex(topicHex), FeedIndex.fromBigInt(index).toUint8Array()));
  return hex(calculateSocAddress(id, unhex(owner)));
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

function feedAnswer(owner: string, topicHex: string): (res: ServerResponse) => void {
  if (net.lookupFailed) return (res) => json(res, 404, { code: 404, message: "lookup at failed" });
  let latest = -1n;
  while (chunks.has(addressFor(owner, topicHex, latest + 1n))) latest++;
  if (latest < 0n) return (res) => json(res, 404, { code: 404, message: "no update found" });
  const payload = chunks.get(addressFor(owner, topicHex, latest))!.subarray(32 + 65 + 8);
  return (res) =>
    res
      .writeHead(200, {
        "Content-Type": "application/octet-stream",
        "swarm-feed-index": FeedIndex.fromBigInt(latest).toHex(),
        "swarm-feed-index-next": FeedIndex.fromBigInt(latest + 1n).toHex(),
      })
      .end(Buffer.from(payload));
}

const bee: Server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  if (req.method === "POST" && path.startsWith("/soc/")) {
    // Uploads are pushes, not retrievals: the skip list does not stop them.
    const url = new URL(req.url ?? "", "http://x");
    const [, , owner, id] = url.pathname.split("/");
    const body = await readBody(req);
    const addr = hex(calculateSocAddress(unhex(id!), unhex(owner!)));
    posted.push(addr);
    if (!chunks.has(addr)) chunks.set(addr, Binary.concatBytes(unhex(id!), unhex(url.searchParams.get("sig")!), body));
    return json(res, 201, { reference: addr });
  }
  if (req.method === "GET" && path.startsWith("/chunks/")) {
    if (net.chunks500) return json(res, 500, { code: 500, message: "read chunk failed" });
    const c = chunks.get(path.split("/")[2]!.toLowerCase());
    if (!c) return json(res, 404, { code: 404, message: "chunk not found" });
    return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from(c));
  }
  const m = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/i.exec(path);
  if (req.method === "GET" && m) {
    net.feedLookups++;
    const answer = feedAnswer(m[1]!.toLowerCase(), m[2]!.toLowerCase());
    const hold = net.holdOnce;
    if (hold && hold.topicHex === m[2]!.toLowerCase()) {
      net.holdOnce = null;
      hold.arrived();
      await hold.release;
    }
    return answer(res);
  }
  json(res, 404, { code: 404, message: "Not Found" });
});

// ---------------------------------------------------------------------------

let dir: string;
let originalCwd: string;
let shared: typeof import("@woco/shared");
let feeds: typeof import("../src/lib/swarm/feeds.js");
let service: typeof import("../src/lib/site/service.js");
let retryHooks: typeof import("../src/lib/swarm/first-write-retry.js").__firstWriteRetryTestHooks;
let memoHooks: typeof import("../src/lib/swarm/display-read-memo.js").__displayReadMemoTestHooks;

/** Every retry wait the upsert asked for; `onSleep` runs in it (the minute passing). */
const sleeps: number[] = [];
let onSleep: ((ms: number) => void | Promise<void>) | null = null;

before(async () => {
  await new Promise<void>((r) => bee.listen(0, "127.0.0.1", r));
  process.env.BEE_URL = `http://127.0.0.1:${(bee.address() as AddressInfo).port}`;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_GATEWAY_URL = DEAD;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
  process.env.FEED_PRIVATE_KEY = KEY;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-site-directory-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  shared = await import("@woco/shared");
  calculateSocAddress = shared.calculateSocAddress;
  feeds = await import("../src/lib/swarm/feeds.js");
  service = await import("../src/lib/site/service.js");
  ({ __firstWriteRetryTestHooks: retryHooks } = await import("../src/lib/swarm/first-write-retry.js"));
  ({ __displayReadMemoTestHooks: memoHooks } = await import("../src/lib/swarm/display-read-memo.js"));
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
  retryHooks.setSleep(async (ms) => {
    sleeps.push(ms);
    await onSleep?.(ms);
  });
});

after(async () => {
  retryHooks.setSleep(null);
  await new Promise<void>((r) => bee.close(() => r()));
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  skipListed(false);
  net.feedLookups = 0;
  net.holdOnce = null;
  posted.length = 0;
  sleeps.length = 0;
  onSleep = null;
  feeds.__feedWriteTestHooks.clearCache();
  feeds.__feedWriteTestHooks.setClock(null);
  memoHooks.setClock(null);
});

/** A fresh creator per test: nothing memoized or queued carries over. */
const newCreator = () => Wallet.createRandom().address.toLowerCase();
const dirTopicHex = (creator: string, page = 0) =>
  Topic.fromString(shared.siteCreatorDirectoryTopic(creator, page)).toHex().replace(/^0x/, "").toLowerCase();

/** Updates written to page 0 of the creator's directory, oldest first. */
function directoryWrites(creator: string): SiteDirectoryEntry[][] {
  const t = dirTopicHex(creator);
  const out: SiteDirectoryEntry[][] = [];
  for (let i = 0n; ; i++) {
    const c = chunks.get(addressFor(OWNER, t, i));
    if (!c) return out;
    out.push(feeds.decodeJsonFeed<{ entries: SiteDirectoryEntry[] }>(c.subarray(32 + 65 + 8))!.entries);
  }
}
const latestDirectory = (creator: string) => directoryWrites(creator).at(-1);

function entry(siteId: string, extra: Partial<SiteDirectoryEntry> = {}): SiteDirectoryEntry {
  return { siteId, brandName: `Brand ${siteId}`, accentColor: "#6366f1", publishedAt: 1_700_000_000_000, ...extra };
}

// ---------------------------------------------------------------------------
// The bee answer
// ---------------------------------------------------------------------------

test("bee's skip list on a never-written feed ('lookup at failed', /chunks 500) is an ERROR for the strict read, never absent", async () => {
  const t = Topic.fromString(shared.siteCreatorDirectoryTopic(newCreator()));
  skipListed(true);
  const r = await feeds.readFeedPageStrict(t);
  assert.equal(r.status, "error");
  // The chunk read decides: the same lookup answer with the chunk really missing is absent.
  net.chunks500 = false;
  assert.equal((await feeds.readFeedPageStrict(t)).status, "absent");
});

// ---------------------------------------------------------------------------
// Upsert: retry, never write on an unreadable base, log what is given up
// ---------------------------------------------------------------------------

test("THE BUG: first site, directory skip-listed -> retried past the skip window, written once with the entry", async () => {
  const creator = newCreator();
  const e = entry("site-first-0001", { siteFeedSigner: ("0x" + "ab".repeat(20)) as Hex0x });
  skipListed(true);
  onSleep = () => skipListed(false); // the minute passes
  await service.upsertCreatorSite(creator, e);
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(directoryWrites(creator), [[e]], "exactly one write, holding the entry");
});

test("the read says absent but the write's own index-0 probe fails: the attempt is retried, not dropped", async () => {
  const creator = newCreator();
  const e = entry("site-probe-001");
  net.chunks500 = true; // lookup answers "no update found"; writeFeedPage's walk of index 0 cannot
  onSleep = () => {
    net.chunks500 = false;
  };
  await service.upsertCreatorSite(creator, e);
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(directoryWrites(creator), [[e]]);
});

test("every attempt fails: nothing written, one error log carrying the whole entry, after 3 attempts", async (t) => {
  const creator = newCreator();
  const e = entry("site-never-0001", { deployedUrl: "https://gw.example/bzz/aa/" });
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  skipListed(true);
  await assert.rejects(service.upsertCreatorSite(creator, e));
  assert.deepEqual(sleeps, [70_000, 140_000]);
  assert.equal(net.feedLookups, 3, "one strict read per attempt");
  assert.equal(posted.length, 0);
  const lines = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("[site]"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes(JSON.stringify({ creator, siteId: e.siteId, entry: e })), lines[0]);
});

test("an existing directory that cannot be read is never written as empty - the other sites survive", async () => {
  const creator = newCreator();
  let clock = 1_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const a = entry("site-old-00001");
  await service.upsertCreatorSite(creator, a);
  // Past read-your-writes, so only bee can answer - and it cannot.
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  skipListed(true);
  onSleep = () => {
    assert.equal(directoryWrites(creator).length, 1, "nothing written while the directory is unreadable");
    skipListed(false);
  };
  const b = entry("site-new-00001");
  await service.upsertCreatorSite(creator, b);
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(latestDirectory(creator)!.map((x) => x.siteId), [b.siteId, a.siteId]);
});

// ---------------------------------------------------------------------------
// Publish + deploy of one new site
// ---------------------------------------------------------------------------

const SIGNER = ("0x" + "cd".repeat(20)) as Hex0x;
const publishEntry = (siteId: string) => entry(siteId, { logoSwarmRef: "11".repeat(32), siteFeedSigner: SIGNER });
const deployEntry = (siteId: string) =>
  entry(siteId, { logoSwarmRef: "11".repeat(32), feedHash: "22".repeat(32), deployedUrl: `https://gw.example/bzz/${"33".repeat(32)}/`, publishedAt: 1_700_000_000_500 });

test("deploy arrives while publish is retrying: ONE write, ONE entry with publish's siteFeedSigner and deploy's feedHash/deployedUrl", async () => {
  const creator = newCreator();
  const siteId = "site-pubdep-01";
  skipListed(true);
  let deployed: Promise<void> | undefined;
  onSleep = () => {
    deployed = service.upsertCreatorSite(creator, deployEntry(siteId));
    skipListed(false);
  };
  const published = service.upsertCreatorSite(creator, publishEntry(siteId));
  await published;
  await deployed;
  const writes = directoryWrites(creator);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], [{ ...publishEntry(siteId), ...deployEntry(siteId) }]);
  assert.equal(writes[0]![0]!.siteFeedSigner, SIGNER);
  assert.equal(writes[0]![0]!.feedHash, "22".repeat(32));
});

test("publish then deploy, directory readable: the deploy merges over what the publish wrote", async () => {
  const creator = newCreator();
  const siteId = "site-pubdep-02";
  const other = entry("site-other-002");
  await service.upsertCreatorSite(creator, other);
  await service.upsertCreatorSite(creator, publishEntry(siteId));
  await service.upsertCreatorSite(creator, deployEntry(siteId));
  assert.deepEqual(latestDirectory(creator), [{ ...publishEntry(siteId), ...deployEntry(siteId) }, other]);
  assert.deepEqual(sleeps, []);
});

// ---------------------------------------------------------------------------
// Display reads: the memo
// ---------------------------------------------------------------------------

test("absent is memoized for 90 s and no longer", async () => {
  const creator = newCreator();
  let now = 5_000_000;
  memoHooks.setClock(() => now);
  assert.deepEqual(await service.getCreatorSites(creator), []);
  assert.equal(net.feedLookups, 1);
  assert.deepEqual(await service.getCreatorSites(creator), []);
  now += 90_000 - 1;
  assert.deepEqual(await service.getCreatorSites(creator), []);
  assert.equal(net.feedLookups, 1, "builder opens inside the window cost bee nothing");
  now += 1;
  await service.getCreatorSites(creator);
  assert.equal(net.feedLookups, 2);
});

test("an unreadable directory reads as [] but is never memoized", async () => {
  const creator = newCreator();
  skipListed(true);
  assert.deepEqual(await service.getCreatorSites(creator), []);
  skipListed(false);
  const x = entry("site-later-001");
  // Written behind the memo's back (no upsert, so nothing invalidates it).
  await feeds.writeFeedPage(
    Topic.fromString(shared.siteCreatorDirectoryTopic(creator)),
    feeds.encodeJsonFeed({ v: 1, entries: [x], updatedAt: new Date().toISOString(), pages: 0 }),
  );
  assert.deepEqual(await service.getCreatorSites(creator), [x]);
});

test("an upsert clears a memoized absent: the new site shows straight away", async () => {
  const creator = newCreator();
  assert.deepEqual(await service.getCreatorSites(creator), []);
  const x = entry("site-shows-001");
  await service.upsertCreatorSite(creator, x);
  assert.deepEqual(await service.getCreatorSites(creator), [x]);
});

test("a display read that started before an upsert's write is not memoized", async () => {
  const creator = newCreator();
  const a = entry("site-page0-001");
  const b = entry("site-page1-001");
  // A two-page directory, written directly.
  await feeds.writeFeedPage(
    Topic.fromString(shared.siteCreatorDirectoryTopic(creator)),
    feeds.encodeJsonFeed({ v: 1, entries: [a], updatedAt: new Date().toISOString(), pages: 1 }),
  );
  await feeds.writeFeedPage(
    Topic.fromString(shared.siteCreatorDirectoryTopic(creator, 1)),
    feeds.encodeJsonFeed({ v: 1, entries: [b], updatedAt: new Date().toISOString() }),
  );
  // The display read gets page 0, then waits on page 1 while the upsert lands.
  let arrived!: () => void;
  const atPage1 = new Promise<void>((r) => (arrived = r));
  let release!: () => void;
  net.holdOnce = { topicHex: dirTopicHex(creator, 1), arrived, release: new Promise<void>((r) => (release = r)) };
  const stale = service.getCreatorSites(creator);
  await atPage1;
  const x = entry("site-during-01");
  await service.upsertCreatorSite(creator, x);
  release();
  assert.deepEqual((await stale).map((e) => e.siteId), [a.siteId, b.siteId], "it answers its own caller");
  assert.deepEqual((await service.getCreatorSites(creator)).map((e) => e.siteId), [x.siteId, a.siteId, b.siteId]);
});

