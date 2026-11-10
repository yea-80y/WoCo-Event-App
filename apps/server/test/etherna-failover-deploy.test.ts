/**
 * The Etherna failover for deploys and server-signed SOCs (#912 slice 2b): the save
 * layer's expected address, a deploy's store (sticky once a part lands on WoCo, root
 * last), feed manifests stored here, the one SOC sender, and the runtime kit's read
 * fallback. Bee, Etherna and the proxy are a stubbed `fetch`; the ledger lives in a
 * temp cwd.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BEE = "http://bee.test";
const ETH = "http://etherna.test";
const PROXY = "http://proxy.test";
const T0 = Date.parse("2026-11-10T00:00:00Z");
const PARENT = "0x" + "aa".repeat(20);
const WOCO_BATCH = "ab".repeat(32);
const ETH_BATCH = "cd".repeat(32);

process.env.BEE_URL = BEE;
process.env.ETHERNA_GATEWAY_URL = ETH;
process.env.ETHERNA_TOKEN_ENDPOINT = `${ETH}/token`;
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.POSTAGE_BATCH_ID = WOCO_BATCH;
process.env.PROXY_URL = PROXY;
process.env.UPLOAD_SECRET = "s";
delete process.env.ETHERNA_FAILOVER;

type Call = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };
const calls: Call[] = [];
/** Etherna's answer to the n-th /bytes POST (from 0): a status, a root to claim, or null = the plain tree. */
let ethernaBytes: (n: number) => { status: number } | { root: string } | null = () => null;
let beeBytes: () => { status: number } | { root: string } | null = () => null;
let ethernaSoc: () => number = () => 201;
let ethernaReads: () => number = () => 200;
/** At each bee /soc POST: was its address already listed? */
const listedAtBeePost: boolean[] = [];
const beeNodes = new Map<string, Uint8Array>();
let plainRoot: (d: Uint8Array) => string;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init?.body as Uint8Array | undefined;
  calls.push({ url, method, headers, body });
  if (url === `${ETH}/token`) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  if (url === `${PROXY}/admin/whitelist`) return new Response("{}", { status: 200 });
  if (url.startsWith(`${ETH}/api/v0.3/resources/`)) return new Response(null, { status: 200 });
  if (method === "POST" && url.startsWith(`${ETH}/soc/`)) {
    const status = ethernaSoc();
    return new Response(status < 300 ? "{}" : "no", { status });
  }
  if (method === "POST" && url.startsWith(`${BEE}/soc/`)) {
    const [owner, id] = new URL(url).pathname.split("/").slice(2);
    const addr = Buffer.from(soc.calculateSocAddress(Buffer.from(id!, "hex"), Buffer.from(owner!, "hex"))).toString("hex");
    listedAtBeePost.push(ledger.getRelayEntry(addr) !== undefined);
    return new Response("{}", { status: 201 });
  }
  if (method === "GET" && url.startsWith(`${ETH}/bytes/`)) {
    const status = ethernaReads();
    return new Response(status === 200 ? new Uint8Array([9]) : "no", { status });
  }
  if (method === "GET" && url.startsWith(`${BEE}/bytes/`)) {
    const node = beeNodes.get(url.slice(`${BEE}/bytes/`.length));
    return node ? new Response(node, { status: 200 }) : new Response("not found", { status: 404 });
  }
  if (method === "POST" && (url === `${ETH}/bytes` || url === `${BEE}/bytes`)) {
    const n = calls.filter((c) => c.method === "POST" && c.url === url).length - 1;
    const store = url === `${ETH}/bytes` ? ethernaBytes(n) : beeBytes();
    if (store && "status" in store) return new Response("no", { status: store.status });
    return new Response(JSON.stringify({ reference: store?.root ?? plainRoot(body!) }), { status: 201 });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

let ledger: typeof import("../src/lib/etherna/relay-ledger.js");
let failover: typeof import("../src/lib/etherna/failover.js");
let breaker: typeof import("../src/lib/etherna/breaker.js");
let bytesMod: typeof import("../src/lib/swarm/bytes.js");
let publish: typeof import("../src/lib/site/collection-publish.js");
let socSend: typeof import("../src/lib/etherna/soc-send.js");
let router: typeof import("../src/lib/etherna/batch-router.js");
let manifest: typeof import("@woco/shared/swarm/feed-manifest");
let soc: typeof import("@woco/shared/swarm/soc");
let originalCwd: string;
let now = T0;

before(async () => {
  originalCwd = process.cwd();
  ({ bytesTreeRoot: plainRoot } = await import("@woco/shared/swarm/bytes-tree"));
  manifest = await import("@woco/shared/swarm/feed-manifest");
  soc = await import("@woco/shared/swarm/soc");
  ledger = await import("../src/lib/etherna/relay-ledger.js");
  failover = await import("../src/lib/etherna/failover.js");
  breaker = await import("../src/lib/etherna/breaker.js");
  bytesMod = await import("../src/lib/swarm/bytes.js");
  publish = await import("../src/lib/site/collection-publish.js");
  socSend = await import("../src/lib/etherna/soc-send.js");
  router = await import("../src/lib/etherna/batch-router.js");
});

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  now = T0;
  calls.length = 0;
  listedAtBeePost.length = 0;
  beeNodes.clear();
  ethernaBytes = () => null;
  beeBytes = () => null;
  ethernaSoc = () => 201;
  ethernaReads = () => 200;
  delete process.env.ETHERNA_FAILOVER;
  breaker.__resetEthernaBreaker();
  failover.__resetFailoverStatsForTest();
  process.chdir(mkdtempSync(join(tmpdir(), "woco-etherna-deploy-")));
  ledger.__resetRelayLedgerForTest({ now: () => now });
  ledger.loadRelayLedger();
  now += ledger.WARMUP_MS;
});

const ETHERNA = { target: "etherna" as const, batchId: ETH_BATCH };
const posts = (base: string, path = "/bytes") => calls.filter((c) => c.method === "POST" && c.url.startsWith(`${base}${path}`));
const listed = () => ledger.relayLedgerState().failover;
/** A deploy's objects: distinct small parts, addressed as bee addresses them at level 0, root last. */
const objects = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const data = new Uint8Array(100 + i).fill(i + 1);
    return { data, address: plainRoot(data) };
  });
const collectionOf = (objs: ReturnType<typeof objects>) =>
  ({ root: objs.at(-1)!.address, rootNode: objs.at(-1)!.data, objects: objs }) as Parameters<typeof publish.uploadSiteObjects>[1];

// ---------------------------------------------------------------------------
// The save layer's expected address
// ---------------------------------------------------------------------------

test("expected: Etherna storing another root fails the save - nothing on WoCo, nothing listed, alarm raised", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaBytes = () => ({ root: "ee".repeat(32) });
  const [o] = objects(1);
  await assert.rejects(bytesMod.saveForEtherna(o!.data, ETHERNA, { failover: { parent: PARENT }, expected: o!.address }), /expected/);
  assert.equal(posts(BEE).length, 0, "never falls through to WoCo");
  assert.equal(listed(), 0);
  assert.equal((failover.ethernaFailoverHealth() as { plainTree: { mismatches: number } }).plainTree.mismatches, 1);
});

test("expected: our bee storing another root fails the save and lists nothing", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  beeBytes = () => ({ root: "ee".repeat(32) });
  const [o] = objects(1);
  await assert.rejects(bytesMod.saveForEtherna(o!.data, ETHERNA, { failover: { parent: PARENT }, expected: o!.address }), /level-0 root/);
  assert.equal(listed(), 0);
});

// ---------------------------------------------------------------------------
// A deploy's store
// ---------------------------------------------------------------------------

test("Etherna down: the first part tries Etherna, every later part goes straight to WoCo; each listed for its owner, root last", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaBytes = () => ({ status: 503 });
  const objs = objects(6);
  const { bytes, rootLanded } = await publish.uploadSiteObjects(publish.deployStore(ETHERNA, { parent: PARENT }), collectionOf(objs));
  assert.equal(rootLanded, "woco");
  assert.equal(bytes, objs.reduce((n, o) => n + o.data.length, 0));
  // A fast 503 never trips the breaker: without the stickiness each part would pay two tries.
  assert.equal(posts(ETH).length, failover.FAILOVER_ETHERNA_ATTEMPTS, "Etherna asked for the first part only");
  const onBee = posts(BEE);
  assert.equal(onBee.length, 6);
  assert.deepEqual(onBee.map((c) => c.body!.length), objs.map((o) => o.data.length), "in order, root last");
  for (const c of onBee) {
    assert.equal(c.headers["swarm-redundancy-level"], "0");
    assert.equal(c.headers["swarm-postage-batch-id"], WOCO_BATCH);
  }
  for (const o of objs) assert.equal(ledger.getRelayEntry(o.address)?.parent, PARENT.toLowerCase());
});

test("a split deploy: parts Etherna took stay there, the rest go to WoCo, and only those are listed", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaBytes = (n) => (n < 2 ? null : { status: 503 });
  const objs = objects(5);
  const { rootLanded } = await publish.uploadSiteObjects(publish.deployStore(ETHERNA, { parent: PARENT }), collectionOf(objs));
  assert.equal(rootLanded, "woco");
  assert.equal(listed(), 3);
  assert.equal(ledger.getRelayEntry(objs[0]!.address), undefined);
  assert.equal(ledger.getRelayEntry(objs[1]!.address), undefined);
  for (const o of objs.slice(2)) assert.ok(ledger.getRelayEntry(o.address));
  // On Etherna: non-deferred, no per-part offer (the deploy offers its root once).
  for (const c of posts(ETH)) assert.equal(c.headers["swarm-deferred-upload"], "false");
  assert.equal(calls.filter((c) => c.url.includes("/offers")).length, 0);
});

test("Etherna up: every part on Etherna, root landed there, nothing listed", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const { rootLanded } = await publish.uploadSiteObjects(publish.deployStore(ETHERNA, { parent: PARENT }), collectionOf(objects(3)));
  assert.equal(rootLanded, "etherna");
  assert.equal(posts(BEE).length, 0);
  assert.equal(listed(), 0);
});

test("rail off: a deploy part Etherna refuses fails the deploy after one try, nothing on WoCo", async () => {
  ethernaBytes = () => ({ status: 503 });
  await assert.rejects(publish.uploadSiteObjects(publish.deployStore(ETHERNA, { parent: PARENT }), collectionOf(objects(3))), /503/);
  assert.equal(posts(ETH).length, 1, "what a deploy always gave Etherna");
  assert.equal(posts(BEE).length, 0);
  assert.equal(listed(), 0);
});

test("a full ledger: the deploy fails as with the rail off - no unlisted WoCo copy", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ledger.__resetRelayLedgerForTest({ now: () => now, maxEntries: 0 });
  ledger.loadRelayLedger();
  ethernaBytes = () => ({ status: 503 });
  await assert.rejects(publish.uploadSiteObjects(publish.deployStore(ETHERNA, { parent: PARENT }), collectionOf(objects(2))));
  assert.equal(posts(BEE).length, 0);
});

test("a feed manifest is stored here, child first, then the root, at the address bee would give it", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  const owner = "3324650e2d49b36a4d8a883eacc45394ae7bad00";
  const topicHex = "ab".repeat(32);
  const addr = await publish.storeFeedManifest(publish.deployStore(ETHERNA, { parent: PARENT }), `0x${owner.toUpperCase()}`, topicHex);
  assert.equal(addr, manifest.expectedFeedManifestHash(owner, topicHex));
  const [child, root] = posts(BEE);
  assert.deepEqual(child!.body, manifest.feedManifestChildChunk().subarray(8));
  assert.deepEqual(root!.body, manifest.feedManifestRootChunk(owner, topicHex).subarray(8));
  assert.ok(ledger.getRelayEntry(addr));
  assert.equal(posts(ETH).length, 0, "force: never Etherna");
});

test("the pointer update's body is the admitted root node, spanned", () => {
  const objs = objects(2);
  const chunk = publish.collectionRootChunk(collectionOf(objs));
  assert.deepEqual(chunk.subarray(8), objs[1]!.data);
  assert.equal(Buffer.from(soc.calculateCacAddress(chunk.subarray(0, 8), chunk.subarray(8))).toString("hex"), objs[1]!.address);
});

// ---------------------------------------------------------------------------
// The one SOC sender
// ---------------------------------------------------------------------------

const wire = () => ({ ownerHex: "11".repeat(20), identifierHex: "22".repeat(32), sigHex: "33".repeat(65), body: new Uint8Array([4, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]) });

test("a SOC Etherna cannot take is listed BEFORE it is stamped on WoCo, for its owner's batch", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaSoc = () => 503;
  assert.equal(await socSend.sendSocForEtherna(wire(), ETH_BATCH, { failover: { parent: PARENT }, run: socSend.runOnce }), "woco");
  assert.deepEqual(listedAtBeePost, [true]);
  assert.equal(listed(), 1);
  const [beePost] = posts(BEE, "/soc/");
  assert.equal(beePost!.headers["swarm-postage-batch-id"], WOCO_BATCH);
});

test("a SOC Etherna takes stays there: nothing on WoCo, nothing failed over", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  assert.equal(await socSend.sendSocForEtherna(wire(), ETH_BATCH, { failover: { parent: PARENT }, run: socSend.runOnce }), "etherna");
  assert.equal(posts(BEE, "/soc/").length, 0);
  assert.equal(listed(), 0);
});

test("rail off, or no failover asked: Etherna or an error; a refused batch without the failover never reaches Etherna", async () => {
  ethernaSoc = () => 503;
  await assert.rejects(socSend.sendSocForEtherna(wire(), ETH_BATCH, { failover: { parent: PARENT }, run: socSend.runOnce }), /503/);
  process.env.ETHERNA_FAILOVER = "auto";
  await assert.rejects(socSend.sendSocForEtherna(wire(), ETH_BATCH, { run: socSend.runOnce }), /503/);
  assert.equal(posts(BEE, "/soc/").length, 0);
  ledger.__resetRelayLedgerForTest({ now: () => now, maxEntries: 0 });
  ledger.loadRelayLedger();
  calls.length = 0;
  await assert.rejects(
    socSend.sendSocForEtherna(wire(), ETH_BATCH, { failover: { parent: PARENT, ethernaRefused: "batch gone" }, run: socSend.runOnce }),
    (e: unknown) => e instanceof router.PlatformBatchUnavailable,
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("a server-signed feed page in a failover lands on WoCo and is not offered on Etherna", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  const { PrivateKey, Topic } = await import("@ethersphere/bee-js");
  const key = new PrivateKey("01".repeat(32));
  const landed = await socSend.writeEthernaFeedPage({
    topic: Topic.fromString("woco/test/2b"),
    index: 3n,
    payload: new Uint8Array([1, 2, 3]),
    batchId: ETH_BATCH,
    signer: key,
    ownerHex: key.publicKey().address().toHex().replace(/^0x/, ""),
    failover: { parent: PARENT },
  });
  assert.equal(landed, "woco");
  assert.equal(posts(ETH, "/soc/").length, 0);
  assert.equal(calls.filter((c) => c.url.includes("/offers")).length, 0);
  assert.deepEqual(listedAtBeePost, [true]);
});

// ---------------------------------------------------------------------------
// The runtime kit's reads
// ---------------------------------------------------------------------------

test("a release node Etherna cannot serve is read from our bee", async () => {
  ethernaReads = () => 503;
  beeNodes.set("aa".repeat(32), new Uint8Array([7, 7]));
  assert.deepEqual(await publish.liveKitReads.node("etherna", "aa".repeat(32)), new Uint8Array([7, 7]));
  ethernaReads = () => 200;
  assert.deepEqual(await publish.liveKitReads.node("etherna", "aa".repeat(32)), new Uint8Array([9]), "Etherna first when it answers");
  // Etherna paused after a slow failure: not asked at all.
  breaker.noteEthernaFailure("slow", performance.now() - 60_000);
  assert.ok(breaker.ethernaPaused() !== null);
  calls.length = 0;
  assert.deepEqual(await publish.liveKitReads.node("etherna", "aa".repeat(32)), new Uint8Array([7, 7]));
  assert.equal(calls.filter((c) => c.url.startsWith(ETH)).length, 0);
});

test("the relay: a refused batch handed over without the failover never reaches it", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const { PrivateKey } = await import("@ethersphere/bee-js");
  const { uploadSignedSoc } = await import("../src/lib/swarm/soc-upload.js");
  const key = new PrivateKey("02".repeat(32));
  const identifier = new Uint8Array(32).fill(5);
  const payload = new Uint8Array([1, 2, 3]);
  const span = soc.encodeSpan(payload.length);
  const sig = key.sign(new Uint8Array([...identifier, ...soc.calculateCacAddress(span, payload)])) as unknown as { toUint8Array(): Uint8Array };
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const input = { owner: key.publicKey().address().toHex(), identifier: hex(identifier), signature: hex(sig.toUint8Array()), span: hex(span), payload: hex(payload) };
  await assert.rejects(uploadSignedSoc(input, { ...ETHERNA, ethernaRefused: "batch gone" }), (e: unknown) => e instanceof router.PlatformBatchUnavailable);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/soc/")).length, 0);
  // With it: straight to WoCo, listed first.
  await uploadSignedSoc(input, { ...ETHERNA, ethernaRefused: "batch gone" }, { failover: { ethernaRefused: "batch gone" } });
  assert.equal(posts(ETH, "/soc/").length, 0);
  assert.deepEqual(listedAtBeePost, [true]);
});

// ---------------------------------------------------------------------------
// Where a refused batch may still take a save
// ---------------------------------------------------------------------------

test("every slice-2b route through the batch router can fail over a refused batch (routeSave), and hands it on", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf-8");
  const sites = src("routes/sites.ts");
  const deploy = sites.slice(sites.indexOf('sitesRouter.post("/:id/deploy"'));
  assert.match(deploy, /selection = routeSave\(\(\) =>\s*batchForDeploy\(\{ ownerAddress: parentAddress, gatewayUrl, deployType: "website", freeHostingEligible \}\)/);
  assert.match(deploy, /const store = deployStore\(selection, \{ parent: parentAddress \}\);/);
  assert.match(deploy, /failover: \{ parent: parentAddress, ethernaRefused: selection\.ethernaRefused \}/);
  assert.match(sites, /function siteFeedDest[\s\S]{0,200}routeSave\(\(\) => batchForDeploy\(\{ ownerAddress, gatewayUrl, deployType: "event" \}\)\)/);
  assert.match(sites, /return dest \? \{ dest, failover: \{ parent: ownerAddress \} \} : \{\};/);
  const page = src("routes/site.ts");
  assert.match(page, /selection = routeSave\(\(\) => batchForDeploy\(\{ ownerAddress: parentAddress, gatewayUrl: ETHERNA_URL, deployType: "event" \}\)\);/);
  assert.match(page, /const store = deployStore\(selection, \{ parent: parentAddress \}\);/);
  const svc = src("lib/event/service.ts");
  assert.match(svc, /function legacyEventFeedDest[\s\S]{0,300}routeSave\(\(\) =>/);
  assert.match(svc, /return dest \? \{ dest, failover: \{ parent: feed\.creatorAddress\.toLowerCase\(\) \} \} : \{\};/);
  const cfw = src("lib/swarm/content-feed-write.ts");
  assert.match(cfw, /return routeSave\(platformEthernaBatch\);/);
  assert.match(cfw, /uploadSignedSoc\(input, dest, dest\.target === "etherna" \? \{ failover: \{ ethernaRefused: dest\.ethernaRefused \} \} : \{\}\)/);
});
