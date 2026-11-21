/**
 * The Etherna failover for `/bytes` saves (#912 slice 2a): the save layer in
 * `uploadToBytes`, `routeSave`, the ledger's root entries and the sweep that
 * moves a root back. Bee, Etherna and the proxy are a stubbed `fetch`; the
 * ledger lives in a temp cwd.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BEE = "http://bee.test";
const ETH = "http://etherna.test";
const PROXY = "http://proxy.test";
const T0 = Date.parse("2026-11-09T00:00:00Z");
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

type Call = { url: string; method: string; headers: Record<string, string>; size: number };
const calls: Call[] = [];
/** Etherna's answer to a /bytes POST: a status, or a root to claim (default: `storeRoot`). */
let ethernaBytes: () => { status: number } | { root: string } | null = () => null;
let beeBytes: () => { status: number } | { root: string } | null = () => null;
/** Our bee's answer to GET /bytes/<root>; absent = 404. */
const beeReads: Record<string, () => Response> = {};
let plainRoot: (d: Uint8Array) => string;
/** A stand-in for a level-1 root: not the plain one, and the same from both stores. */
const codedRoot = (d: Uint8Array) => createHash("sha256").update("level 1").update(d).digest("hex");
/** What a store that honours the level answers: parity moves a file of more than one chunk, nothing else. */
const storeRoot = (d: Uint8Array, level: number | string | undefined) => (String(level) === "1" && d.length > 4096 ? codedRoot(d) : plainRoot(d));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init?.body as Uint8Array | undefined;
  calls.push({ url, method, headers, size: body?.length ?? 0 });
  if (url === `${ETH}/token`) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  if (url === `${PROXY}/admin/whitelist`) return new Response("{}", { status: 200 });
  if (url.startsWith(`${ETH}/api/v0.3/resources/`)) return new Response(null, { status: 200 });
  if (method === "GET" && url.startsWith(`${BEE}/bytes/`)) {
    const r = beeReads[url.slice(`${BEE}/bytes/`.length)];
    return r ? r() : new Response("not found", { status: 404 });
  }
  const store = url === `${ETH}/bytes` ? ethernaBytes() : url === `${BEE}/bytes` ? beeBytes() : undefined;
  if (store !== undefined && method === "POST") {
    if (store && "status" in store) return new Response("no", { status: store.status });
    const reference = store?.root ?? storeRoot(body!, headers["swarm-redundancy-level"]);
    return new Response(JSON.stringify({ reference }), { status: 201 });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

let ledger: typeof import("../src/lib/etherna/relay-ledger.js");
let failover: typeof import("../src/lib/etherna/failover.js");
let breaker: typeof import("../src/lib/etherna/breaker.js");
let bytesMod: typeof import("../src/lib/swarm/bytes.js");
let plain: typeof import("../src/lib/swarm/plain-bytes.js");
let router: typeof import("../src/lib/etherna/batch-router.js");
let dir: string;
let originalCwd: string;
let now = T0;

before(async () => {
  originalCwd = process.cwd();
  ({ bytesTreeRoot: plainRoot } = await import("@woco/shared/swarm/bytes-tree"));
  ledger = await import("../src/lib/etherna/relay-ledger.js");
  failover = await import("../src/lib/etherna/failover.js");
  breaker = await import("../src/lib/etherna/breaker.js");
  bytesMod = await import("../src/lib/swarm/bytes.js");
  plain = await import("../src/lib/swarm/plain-bytes.js");
  router = await import("../src/lib/etherna/batch-router.js");
});

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = realFetch;
});

function freshLedger(opts: { maxEntries?: number } = {}): void {
  dir = mkdtempSync(join(tmpdir(), "woco-etherna-bytes-"));
  process.chdir(dir);
  ledger.__resetRelayLedgerForTest({ now: () => now, ...(opts.maxEntries ? { maxEntries: opts.maxEntries } : {}) });
  ledger.loadRelayLedger();
  now += ledger.WARMUP_MS;
}

function restart(): void {
  ledger.__resetRelayLedgerForTest({ now: () => now });
  ledger.loadRelayLedger();
}

beforeEach(() => {
  now = T0;
  calls.length = 0;
  ethernaBytes = () => null;
  beeBytes = () => null;
  delete process.env.ETHERNA_FAILOVER;
  breaker.__resetEthernaBreaker();
  failover.__resetFailoverStatsForTest();
  freshLedger();
});

const ETHERNA = { target: "etherna" as const, batchId: ETH_BATCH };
const data = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const posts = (base: string) => calls.filter((c) => c.method === "POST" && c.url === `${base}/bytes`);
const health = () => failover.ethernaFailoverHealth() as Record<string, any>;

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

test("an Etherna save is level 1 and deferred, on the routed batch, and returns Etherna's root", async () => {
  const d = data(10_000);
  const ref = await bytesMod.uploadToBytes(d, ETHERNA);
  assert.equal(ref, codedRoot(d));
  const [p] = posts(ETH);
  assert.equal(p.headers["swarm-redundancy-level"], "1");
  assert.equal(p.headers["swarm-deferred-upload"], "true");
  assert.equal(p.headers["swarm-postage-batch-id"], ETH_BATCH);
  assert.equal(p.headers["authorization"], "Bearer t");
  assert.equal(posts(BEE).length, 0);
  assert.equal(ledger.relayLedgerState().failover, 0);
  assert.equal(health().plainTree.ok, true, "a level-1 root is not a mismatch");
});

test("the level rule: 1, except a file of more than one chunk whose address the caller fixed", () => {
  assert.equal(plain.saveLevel(1, false), 1);
  assert.equal(plain.saveLevel(8 * 1024 * 1024, false), 1);
  assert.equal(plain.saveLevel(4096, true), 1, "one chunk: the same address at both levels");
  assert.equal(plain.saveLevel(4097, true), 0, "parity would move it off the address computed");
});

test("the rule on the wire: a one-chunk save at level 1 under its plain root; a fixed multi-chunk address at level 0", async () => {
  const one = data(3000);
  assert.equal(await bytesMod.uploadToBytes(one, ETHERNA), plainRoot(one));
  const big = data(9000, 3);
  await bytesMod.saveForEtherna(big, ETHERNA, { expected: plainRoot(big) });
  const small = data(200, 4);
  await bytesMod.saveForEtherna(small, ETHERNA, { expected: plainRoot(small) });
  assert.deepEqual(posts(ETH).map((p) => p.headers["swarm-redundancy-level"]), ["1", "0", "1"]);
  assert.equal(health().plainTree.ok, true);
});

test("an Etherna save's level is the save layer's: a caller naming one, even 0, is refused", async () => {
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { redundancyLevel: 2 as never }), /save layer/);
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { redundancyLevel: 0 as never }), /save layer/);
  assert.equal(calls.length, 0);
});

test("rail off: Etherna refusing fails the save as before - nothing on WoCo, nothing listed", async () => {
  ethernaBytes = () => ({ status: 402 });
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { failover: { parent: PARENT } }), /402/);
  assert.equal(posts(BEE).length, 0);
  assert.equal(ledger.relayLedgerState().failover, 0);
});

test("auto, but a save that did not ask for the failover: Etherna or an error, as before", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaBytes = () => ({ status: 402 });
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA), /402/);
  assert.equal(posts(BEE).length, 0);
  assert.equal(ledger.relayLedgerState().failover, 0);
});

test("one classifier for store faults: 429, 423 (bee's stamp lock), 5xx and network faults retry; other 4xx are answers", async () => {
  const { isTransientSwarmError } = await import("../src/lib/swarm/upload-queue.js");
  for (const status of [429, 423, 500, 503]) assert.equal(isTransientSwarmError({ status }), true, String(status));
  for (const status of [400, 402, 404, 409]) assert.equal(isTransientSwarmError({ status }), false, String(status));
  assert.equal(isTransientSwarmError({ response: { status: 423 } }), true, "bee-js's shape");
  assert.equal(isTransientSwarmError(new Error("socket hang up")), true);
  assert.equal(isTransientSwarmError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), true);
  assert.equal(isTransientSwarmError(new Error("bad input")), false);
});

test("auto: Etherna cannot write - two short tries, then stamped on WoCo at the same level, listed with it and whitelisted", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaBytes = () => ({ status: 503 });
  const d = data(10_000);
  const ref = await bytesMod.uploadToBytes(d, ETHERNA, { failover: { parent: PARENT } });
  assert.equal(ref, codedRoot(d), "the address it would have had on Etherna");
  assert.equal(posts(ETH).length, failover.FAILOVER_ETHERNA_ATTEMPTS);
  const [w] = posts(BEE);
  assert.equal(w.headers["swarm-redundancy-level"], "1");
  assert.equal(posts(ETH)[0].headers["swarm-redundancy-level"], "1", "one level on both legs");
  assert.equal(w.headers["swarm-postage-batch-id"], WOCO_BATCH);
  assert.deepEqual(ledger.getRelayEntry(ref), { kind: "bytes", level: 1, parent: PARENT, status: "failover", at: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
  assert.ok(calls.some((c) => c.url === `${PROXY}/admin/whitelist`), "readers falling back to our gateway find it");
  assert.equal(health().sinceBoot.failedOver, 1);
  assert.equal(ledger.relayLedgerState().failoverBytes, 1);
  assert.equal(health().plainTree.ok, true);
});

test("what is listed is the level stored: 1 for a one-chunk save, none for a fixed multi-chunk address", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  const one = data(3000);
  const big = data(9000, 3);
  const a = await bytesMod.uploadToBytes(one, ETHERNA, { failover: { parent: PARENT } });
  const { ref: b } = await bytesMod.saveForEtherna(big, ETHERNA, { failover: { parent: PARENT }, expected: plainRoot(big) });
  assert.equal(a, plainRoot(one));
  assert.equal(b, plainRoot(big));
  assert.deepEqual(posts(BEE).map((p) => p.headers["swarm-redundancy-level"]), ["1", "0"]);
  assert.equal((ledger.getRelayEntry(a) as { level?: number }).level, 1);
  assert.equal("level" in ledger.getRelayEntry(b)!, false, "absent is level 0, as every entry from before levels");
});

test("auto: a slow Etherna failure pauses Etherna, and the save goes to WoCo without a second wait", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  breaker.__resetEthernaBreaker({ slowMs: 0 });
  ethernaBytes = () => ({ status: 503 });
  await bytesMod.uploadToBytes(data(5000), ETHERNA, { failover: { parent: PARENT } });
  assert.equal(posts(ETH).length, 1, "an 8 MB image would otherwise wait twice - past the edge's 100 s");
  assert.equal(posts(BEE).length, 1);
});

test("an empty save is a 400, not a 500", async () => {
  await assert.rejects(bytesMod.uploadToBytes(new Uint8Array(0), ETHERNA), (e: Error & { status?: number }) => e.status === 400);
  assert.equal(calls.length, 0);
});

test("the same bytes saved by a different account move back to the platform batch, not either account's", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const root = "37".repeat(32);
  const other = "0x" + "bb".repeat(20);
  ledger.noteBytesFailover(root, PARENT, 1);
  ledger.noteBytesFailover(root, PARENT.toUpperCase().replace(/^0X/, "0x"), 1);
  assert.equal(ledger.getRelayEntry(root)?.parent, PARENT, "the same account again: its own");
  ledger.noteBytesFailover(root, other, 1);
  assert.equal(ledger.getRelayEntry(root)?.parent, undefined);
  ledger.noteBytesFailover(root, PARENT, 1);
  assert.equal(ledger.getRelayEntry(root)?.parent, undefined, "once neutral, stays neutral");
  restart();
  assert.equal(ledger.getRelayEntry(root)?.parent, undefined);
  assert.equal((ledger.getRelayEntry(root) as { level?: number }).level, 1, "the level survives every rewrite and the restart");
});

test("reading a root back from our bee: its bytes, 404 absent, anything else unavailable", async () => {
  const d = data(300);
  beeReads["aa".repeat(32)] = () => new Response(d, { status: 200 });
  beeReads["bb".repeat(32)] = () => new Response("read chunk failed", { status: 500 });
  const ok = await plain.readPlainBytesFromBee("aa".repeat(32));
  assert.equal(ok.status, "found");
  assert.deepEqual(ok.status === "found" ? [...ok.data] : [], [...d]);
  assert.deepEqual(await plain.readPlainBytesFromBee("cc".repeat(32)), { status: "absent" });
  assert.equal((await plain.readPlainBytesFromBee("bb".repeat(32))).status, "unavailable");
});

test("force, an open breaker, or a batch the router refused: no Etherna try at all", async () => {
  const d = data(5000);
  process.env.ETHERNA_FAILOVER = "force";
  await bytesMod.uploadToBytes(d, ETHERNA, { failover: { parent: PARENT } });
  process.env.ETHERNA_FAILOVER = "auto";
  breaker.__resetEthernaBreaker({ slowMs: 0 });
  breaker.noteEthernaFailure("test", performance.now());
  await bytesMod.uploadToBytes(data(5000, 8), ETHERNA, { failover: { parent: PARENT } });
  breaker.__resetEthernaBreaker();
  await bytesMod.uploadToBytes(data(5000, 9), { ...ETHERNA, ethernaRefused: "batch gone" }, { failover: { parent: PARENT } });
  assert.equal(posts(ETH).length, 0);
  assert.equal(posts(BEE).length, 3);
  assert.equal(ledger.relayLedgerState().failoverBytes, 3);
});

test("a refused batch without the failover able to take it is refused, nothing sent", async () => {
  await assert.rejects(bytesMod.uploadToBytes(data(10), { ...ETHERNA, ethernaRefused: "batch gone" }), router.PlatformBatchUnavailable);
  process.env.ETHERNA_FAILOVER = "auto";
  await assert.rejects(bytesMod.uploadToBytes(data(10), { ...ETHERNA, ethernaRefused: "batch gone" }), router.PlatformBatchUnavailable);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("a save that cannot be listed after its WoCo stamp fails: no root is handed back that nothing moves", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { failover: { parent: "not-an-account" } }), router.PlatformBatchUnavailable);
  assert.equal(posts(BEE).length, 1, "stamped - an unreferenced copy, cost only");
  assert.equal(ledger.relayLedgerState().failover, 0);
  assert.equal(health().sinceBoot.failedOver, 0);
});

test("a full ledger is the rail off: Etherna or an error, never an unlisted WoCo copy", async () => {
  freshLedger({ maxEntries: 1 });
  process.env.ETHERNA_FAILOVER = "auto";
  assert.equal(ledger.noteBytesFailover("11".repeat(32), PARENT, 1), true);
  assert.equal(ledger.noteBytesFailover("22".repeat(32), PARENT, 1), false, "full");
  ethernaBytes = () => ({ status: 402 });
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { failover: { parent: PARENT } }));
  assert.equal(posts(BEE).length, 0);
});

test("our bee storing a one-chunk save at a root other than its plain root fails it, nothing listed", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  beeBytes = () => ({ root: "ee".repeat(32) });
  // 4096 bytes is still one chunk: its root is known here.
  await assert.rejects(bytesMod.uploadToBytes(data(4096), ETHERNA, { failover: { parent: PARENT } }), /plain root/);
  assert.equal(ledger.relayLedgerState().failover, 0);
  assert.equal(health().plainTree.ok, false, "refused AND told: our bee has changed");
  assert.match(health().plainTree.last.what, /our bee .* other than its plain tree/);
});

test("our bee storing a larger save WITHOUT repair data: the save is kept, listed at level 0, and plainTree is red", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  const d = data(10_000);
  beeBytes = () => ({ root: plainRoot(d) });
  const ref = await bytesMod.uploadToBytes(d, ETHERNA, { failover: { parent: PARENT } });
  assert.equal(ref, plainRoot(d), "never a failed save during an outage");
  assert.equal("level" in ledger.getRelayEntry(ref)!, false, "it moves back as the plain tree it is");
  assert.equal(health().plainTree.ok, false);
  assert.match(health().plainTree.last.what, /our bee .* without the repair data/);
});

test("a save deeper than one tree level is listed under the root our bee gave, at level 1", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  beeBytes = () => ({ root: "ef".repeat(32) });
  const ref = await bytesMod.uploadToBytes(data(600 * 1024), ETHERNA, { failover: { parent: PARENT } });
  assert.equal(ref, "ef".repeat(32));
  assert.equal((ledger.getRelayEntry(ref) as { level?: number }).level, 1);
  assert.equal(health().plainTree.ok, true, "nothing here can compute a deeper tree, so nothing is judged");
});

test("Etherna storing a one-chunk save at a non-plain root keeps the save, and turns plainTree red", async () => {
  ethernaBytes = () => ({ root: "dd".repeat(32) });
  assert.equal(health().plainTree.ok, true);
  assert.equal(await bytesMod.uploadToBytes(data(4096), ETHERNA), "dd".repeat(32));
  assert.equal(health().plainTree.ok, false);
  assert.equal(health().plainTree.mismatches, 1);
  assert.match(health().plainTree.last.what, /Etherna .* other than its plain tree/);
});

test("Etherna storing a larger save WITHOUT repair data keeps the save, and turns plainTree red; any other root is not judged", async () => {
  // One byte past a chunk: parity applies from here.
  const d = data(4097);
  ethernaBytes = () => ({ root: plainRoot(d) });
  assert.equal(await bytesMod.uploadToBytes(d, ETHERNA), plainRoot(d));
  assert.equal(health().plainTree.mismatches, 1);
  assert.match(health().plainTree.last.what, /Etherna .* without the repair data/);
  failover.__resetFailoverStatsForTest();
  ethernaBytes = () => ({ root: "dd".repeat(32) });
  await bytesMod.uploadToBytes(d, ETHERNA);
  await bytesMod.uploadToBytes(data(600 * 1024), ETHERNA);
  assert.equal(health().plainTree.ok, true, "the canary, not the save, checks a level-1 root");
});

test("a slow Etherna /bytes failure pauses Etherna, as a SOC write's does", async () => {
  breaker.__resetEthernaBreaker({ slowMs: 0 });
  ethernaBytes = () => ({ status: 402 });
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA));
  assert.notEqual(breaker.ethernaPaused(), null);
});

test("timeouts grow with the save: 15 s plus 5 s a MB, at most two minutes", () => {
  assert.equal(plain.plainBytesTimeoutMs(1), 15_001);
  assert.equal(plain.plainBytesTimeoutMs(8 * 1024 * 1024), 55_000);
  assert.equal(plain.plainBytesTimeoutMs(100 * 1024 * 1024), 120_000);
});

// ---------------------------------------------------------------------------
// routeSave
// ---------------------------------------------------------------------------

test("routeSave: a refused batch goes ahead, marked, only when the failover can take it", () => {
  const refused = { batchId: ETH_BATCH, target: "etherna" as const, freeHosted: true };
  const refuse = () => {
    throw new router.PlatformBatchUnavailable("chain says gone", refused);
  };
  assert.throws(() => failover.routeSave(refuse), router.PlatformBatchUnavailable, "rail off");
  process.env.ETHERNA_FAILOVER = "auto";
  assert.deepEqual(failover.routeSave(refuse), { ...refused, ethernaRefused: "chain says gone" }, "keeps freeHosted for the quota");
  assert.throws(() => failover.routeSave(() => { throw new router.PlatformBatchUnavailable("no selection"); }), router.PlatformBatchUnavailable);
  assert.throws(() => failover.routeSave(() => { throw new Error("other"); }), /other/);
  assert.deepEqual(failover.routeSave(() => ETHERNA), ETHERNA);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("a root entry survives a restart, counts toward the cap, and pages `away` after an hour", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const root = "12".repeat(32);
  assert.equal(ledger.noteBytesFailover(root, PARENT, 1), true);
  restart();
  assert.equal(ledger.getRelayEntry(root)?.kind, "bytes");
  assert.equal(ledger.relayLedgerState().readable, true);
  now += ledger.FAILOVER_ALARM_MS;
  assert.equal(health().away.ok, false);
});

test("a malformed root entry refuses the whole ledger, never dropped", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const d = join(dir, ".data", "etherna-relay-ledger");
  mkdirSync(d, { recursive: true });
  const t = new Date(now).toISOString();
  writeFileSync(join(d, `${"34".repeat(32)}.json`), JSON.stringify({ kind: "bytes", status: "pending", at: t, updatedAt: t }));
  restart();
  assert.equal(ledger.relayLedgerState().readable, false);
  freshLedger();
  writeFileSync(join(dir, ".data", "etherna-relay-ledger", `${"35".repeat(32)}.json`), JSON.stringify({ kind: "blob", status: "failover", at: t, updatedAt: t }));
  restart();
  assert.equal(ledger.relayLedgerState().readable, false);
});

test("a root entry from before levels loads as level 0; a level this build cannot ask for refuses the ledger", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const d = join(dir, ".data", "etherna-relay-ledger");
  mkdirSync(d, { recursive: true });
  const t = new Date(now).toISOString();
  const old = "38".repeat(32);
  writeFileSync(join(d, `${old}.json`), JSON.stringify({ kind: "bytes", parent: PARENT, status: "failover", at: t, updatedAt: t }));
  restart();
  assert.equal(ledger.relayLedgerState().readable, true);
  assert.equal("level" in ledger.getRelayEntry(old)!, false);
  // A hand-made entry may spell absent as 0.
  writeFileSync(join(d, `${"3a".repeat(32)}.json`), JSON.stringify({ kind: "bytes", level: 0, status: "failover", at: t, updatedAt: t }));
  restart();
  assert.equal(ledger.relayLedgerState().readable, true);
  assert.equal("level" in ledger.getRelayEntry("3a".repeat(32))!, false);
  for (const level of [2, -1, "1", null]) {
    freshLedger();
    mkdirSync(join(dir, ".data", "etherna-relay-ledger"), { recursive: true });
    writeFileSync(join(dir, ".data", "etherna-relay-ledger", `${"39".repeat(32)}.json`), JSON.stringify({ kind: "bytes", level, status: "failover", at: t, updatedAt: t }));
    restart();
    assert.equal(ledger.relayLedgerState().readable, false, `level ${JSON.stringify(level)}`);
  }
});

test("a root is never made pending", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const root = "36".repeat(32);
  ledger.noteBytesFailover(root, PARENT, 1);
  const e = ledger.getRelayEntry(root)!;
  ledger.markPending({ address: root, updatedAt: e.updatedAt });
  assert.equal(ledger.getRelayEntry(root)?.status, "failover");
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

type Io = import("../src/lib/etherna/failover.js").SweepIo;
type BytesRead = import("../src/lib/swarm/plain-bytes.js").PlainBytesRead;
const ABSENT = { status: "absent" as const };

function fakeIo(bee: Record<string, BytesRead>, etherna: Record<string, "found" | "absent"> = {}) {
  const posted: Array<{ size: number; batchId: string; timeoutMs: number; level: number }> = [];
  const offered: string[] = [];
  const io: Io & { posted: typeof posted; offered: string[]; answer?: (d: Uint8Array) => string | { status?: number } ; routeFails?: boolean } = {
    posted,
    offered,
    readBee: async () => {
      throw new Error("a root is never read as a SOC");
    },
    readEtherna: async (a) => (etherna[a] === "found" ? { status: "found", raw: new Uint8Array(8) } : ABSENT),
    route: () => {
      if (io.routeFails) throw new router.PlatformBatchUnavailable("no batch");
      return { batchId: ETH_BATCH, target: "etherna" };
    },
    post: async () => {
      throw new Error("a root is never posted as a SOC");
    },
    readBytes: async (r) => bee[r] ?? ABSENT,
    postBytes: async (d, batchId, timeoutMs, level) => {
      posted.push({ size: d.length, batchId, timeoutMs, level });
      const a = io.answer ? io.answer(d) : storeRoot(d, level);
      if (typeof a !== "string") throw Object.assign(new Error("Etherna /bytes upload failed"), a);
      return a;
    },
    offer: async (a) => {
      offered.push(a);
    },
  };
  return io;
}

/** A root listed now, as our bee stored it at `level`, and old enough for the sweep to judge. */
function listed(d: Uint8Array, level: 0 | 1 = 1): string {
  const root = storeRoot(d, level);
  assert.equal(ledger.noteBytesFailover(root, PARENT, level), true);
  return root;
}
const settle = () => {
  now += ledger.SETTLE_MIN_AGE_MS;
};
const found = (d: Uint8Array): BytesRead => ({ status: "found", data: d });

test("sweep: the same bytes re-uploaded, Etherna answers the same root - offered and cleared", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const d = data(10_000);
  const root = listed(d);
  settle();
  const io = fakeIo({ [root]: found(d) });
  const r = await failover.sweepRelayLedger(io);
  assert.equal(r.migrated, 1);
  assert.deepEqual(io.posted, [{ size: d.length, batchId: ETH_BATCH, timeoutMs: plain.plainBytesTimeoutMs(d.length), level: 1 }]);
  assert.deepEqual(io.offered, [root]);
  assert.equal(ledger.getRelayEntry(root), undefined);
});

test("sweep: each root moves back at the level it was stored at, and an entry from before levels at 0", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const coded = data(10_000, 1);
  const fixed = data(10_000, 2);
  const one = data(3000, 3);
  const old = data(10_000, 4);
  const roots = [listed(coded, 1), listed(fixed, 0), listed(one, 1)];
  // Written by a build from before the field, straight to disk.
  const t = new Date(now).toISOString();
  writeFileSync(join(dir, ".data", "etherna-relay-ledger", `${plainRoot(old)}.json`), JSON.stringify({ kind: "bytes", parent: PARENT, status: "failover", at: t, updatedAt: t }));
  restart();
  roots.push(plainRoot(old));
  settle();
  const io = fakeIo({ [roots[0]]: found(coded), [roots[1]]: found(fixed), [roots[2]]: found(one), [roots[3]]: found(old) });
  const r = await failover.sweepRelayLedger(io);
  // A restart reloads in directory order. Etherna answers a larger file's root for
  // the level it is sent at, so all four moving proves each went at its own.
  assert.deepEqual(io.posted.map((p) => p.level).sort(), [0, 0, 1, 1]);
  assert.equal(r.migrated, 4, "each answered its own root");
  assert.equal(ledger.relayLedgerState().failover, 0);
});

test("sweep: the wrong level would be another root - a level-1 file re-uploaded at 0 stays on WoCo", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const d = data(10_000);
  // What a build from before levels does with this entry: it reads no level.
  const root = codedRoot(d);
  assert.equal(ledger.noteBytesFailover(root, PARENT, 0), true);
  settle();
  const io = fakeIo({ [root]: found(d) });
  await failover.sweepRelayLedger(io);
  assert.ok(ledger.getRelayEntry(root), "kept");
  assert.match(String(health().lastMigrationError?.error), /not the same tree/);
});

test("sweep: Etherna answering any other root keeps the entry - never cleared on a 2xx alone", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const d = data(10_000);
  const root = listed(d);
  settle();
  const io = fakeIo({ [root]: found(d) });
  io.answer = () => "ee".repeat(32);
  await failover.sweepRelayLedger(io);
  assert.ok(ledger.getRelayEntry(root), "kept");
  assert.deepEqual(io.offered, []);
  assert.match(String(health().lastMigrationError?.error), /not the same tree/);
});

test("sweep: Etherna as a whole refusing holds the root and ends the pass; a refusal of this root alone backs off and goes on", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const a = data(100, 1);
  const b = data(100, 2);
  const ra = listed(a);
  const rb = listed(b);
  settle();
  const io = fakeIo({ [ra]: found(a), [rb]: found(b) });
  io.answer = () => ({ status: 503 });
  await failover.sweepRelayLedger(io);
  assert.equal(io.posted.length, 1, "the pass stopped at the first");
  // Held to the back: the next due pass tries the other first.
  now += ledger.SETTLE_MIN_AGE_MS;
  io.posted.length = 0;
  io.answer = (d) => (d[0] === 1 ? { status: 402 } : storeRoot(d, 1));
  await failover.sweepRelayLedger(io);
  assert.equal(ledger.getRelayEntry(rb), undefined, "moved");
  assert.ok(ledger.getRelayEntry(ra), "this root refused: kept");
  assert.equal(io.posted.length, 2, "a per-root refusal does not end the pass");
});

test("sweep: no batch to move to holds the root", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const d = data(100);
  const root = listed(d);
  settle();
  const io = fakeIo({ [root]: found(d) });
  io.routeFails = true;
  await failover.sweepRelayLedger(io);
  assert.ok(ledger.getRelayEntry(root));
  assert.equal(io.posted.length, 0);
});

test("sweep: our copy gone and Etherna's too, twice - cleared; Etherna holding it - kept, never pending", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const gone = listed(data(100, 3));
  const onEtherna = listed(data(100, 4));
  settle();
  const io = fakeIo({}, { [onEtherna]: "found" });
  await failover.sweepRelayLedger(io);
  assert.ok(ledger.getRelayEntry(gone), "one absent answer is not a verdict");
  now += 2 * ledger.SETTLE_MIN_AGE_MS;
  await failover.sweepRelayLedger(io);
  assert.equal(ledger.getRelayEntry(gone), undefined);
  assert.equal(ledger.getRelayEntry(onEtherna)?.status, "failover");
  assert.equal(io.posted.length, 0);
});

test("sweep: our bee unable to answer keeps the root", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const root = listed(data(100));
  settle();
  await failover.sweepRelayLedger(fakeIo({ [root]: { status: "unavailable", reason: "bee HTTP 500" } }));
  assert.ok(ledger.getRelayEntry(root));
});

test("sweep: a pass moves at most its byte budget", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const a = data(5000, 5);
  const b = data(5000, 6);
  const ra = listed(a);
  const rb = listed(b);
  settle();
  const io = fakeIo({ [ra]: found(a), [rb]: found(b) });
  await failover.sweepRelayLedger(io, { settle: 50, migrate: 100, bytes: 4000 });
  assert.equal(io.posted.length, 1);
  await failover.sweepRelayLedger(io, { settle: 50, migrate: 100, bytes: 4000 });
  assert.equal(io.posted.length, 2);
  assert.equal(ledger.relayLedgerState().failover, 0);
});

// ---------------------------------------------------------------------------
// One sender, and the call sites
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
function sourceFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("every /bytes upload this server makes by hand goes through postPlainBytes, which always names a level", () => {
  const hits: string[] = [];
  for (const p of sourceFiles(SRC)) {
    // A POST endpoint is `<base>/bytes` with nothing after it; reads are `/bytes/<ref>`.
    for (const m of readFileSync(p, "utf-8").matchAll(/\}\/bytes`/g)) hits.push(`${p.slice(SRC.length)}@${m.index}`);
  }
  assert.equal(hits.length, 1, `/bytes senders: ${hits.join(", ")}`);
  assert.match(hits[0], /^lib\/swarm\/plain-bytes\.ts@/);
  const src = readFileSync(join(SRC, "lib/swarm/plain-bytes.ts"), "utf-8");
  const fn = src.slice(src.indexOf("export async function postPlainBytes("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /"Swarm-Redundancy-Level": String\(opts\.level\),\n/, "unconditionally");
  assert.match(body, /opts: \{ level: SaveLevel; timeoutMs: number; deferred: boolean \}/, "required: no caller can leave it to the store's default");
  // The legs of one save, and a deploy part on either store, take it from the one rule.
  const layer = readFileSync(join(SRC, "lib/swarm/bytes.ts"), "utf-8");
  assert.match(layer, /const level = saveLevel\(bytes\.length, opts\.expected !== undefined\);/);
  assert.deepEqual([...layer.matchAll(/postPlainBytes\("(etherna|wocoBee)", [^\n]*\{ level, timeoutMs/g)].map((m) => m[1]), ["etherna", "wocoBee"]);
  assert.equal([...layer.matchAll(/postPlainBytes\(/g)].length, 2, "no third sender in the save layer");
  assert.match(readFileSync(join(SRC, "lib/site/collection-publish.ts"), "utf-8"), /postPlainBytes\("wocoBee", selection\.batchId, data, \{ level: saveLevel\(data\.length, true\),/);
  // The move back hands the entry's level to the same sender.
  assert.match(
    readFileSync(join(SRC, "lib/etherna/failover.ts"), "utf-8"),
    /postBytes: \(data, batchId, timeoutMs, level\) => postPlainBytes\("etherna", batchId, data, \{ level, timeoutMs, deferred: true \}\),/,
  );
});

test("every save meant for Etherna asks for the failover", () => {
  const sites: Record<string, number> = {
    "lib/event/service.ts": 3,
    "routes/events.ts": 1,
    "lib/profile/service.ts": 1,
    "routes/sites.ts": 1,
    "lib/seating/plan-store.ts": 1,
    "routes/swarm.ts": 1,
  };
  for (const [file, n] of Object.entries(sites)) {
    const src = readFileSync(join(SRC, file), "utf-8");
    const calls = [...src.matchAll(/uploadToBytes\(([^;]*?)\);/gs)].map((m) => m[1]);
    const withFailover = calls.filter((c) => /failover|saveOpts/.test(c));
    assert.equal(withFailover.length, n, `${file}: ${calls.length} uploadToBytes calls`);
  }
  const svc = readFileSync(join(SRC, "lib/event/service.ts"), "utf-8");
  assert.match(svc, /const saveOpts = \{ failover: \{ parent: creatorAddress \} \};/);
  // Since slice 2b the event feed the server signs without a feed signer fails over
  // too, so a refused batch takes the whole create - and that write asks for it.
  assert.match(svc, /const batchSelection = routeSave\(chooseBatch\);/);
  assert.match(svc, /fresh: true,[\s\S]{0,120}dest: batchSelection, failover: \{ parent: creatorAddress \}/);
  // The order key's second leg is the WoCo copy browsers read: no selection, no failover.
  assert.match(svc, /\[uploadToBytes\(bytes\)\]/);
});
