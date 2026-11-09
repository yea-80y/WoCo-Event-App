/**
 * The Etherna failover for `/bytes` saves (#912 slice 2a): the save layer in
 * `uploadToBytes`, `routeSave`, the ledger's root entries and the sweep that
 * moves a root back. Bee, Etherna and the proxy are a stubbed `fetch`; the
 * ledger lives in a temp cwd.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
/** Etherna's answer to a /bytes POST: a status, or a root to claim (default: the plain tree). */
let ethernaBytes: () => { status: number } | { root: string } | null = () => null;
let beeBytes: () => { status: number } | { root: string } | null = () => null;
let plainRoot: (d: Uint8Array) => string;

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
  const store = url === `${ETH}/bytes` ? ethernaBytes() : url === `${BEE}/bytes` ? beeBytes() : undefined;
  if (store !== undefined && method === "POST") {
    if (store && "status" in store) return new Response("no", { status: store.status });
    const reference = store?.root ?? plainRoot(body!);
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

test("an Etherna save is level 0 and deferred, on the routed batch, and returns Etherna's root", async () => {
  const d = data(10_000);
  const ref = await bytesMod.uploadToBytes(d, ETHERNA);
  assert.equal(ref, plainRoot(d));
  const [p] = posts(ETH);
  assert.equal(p.headers["swarm-redundancy-level"], "0");
  assert.equal(p.headers["swarm-deferred-upload"], "true");
  assert.equal(p.headers["swarm-postage-batch-id"], ETH_BATCH);
  assert.equal(p.headers["authorization"], "Bearer t");
  assert.equal(posts(BEE).length, 0);
  assert.equal(ledger.relayLedgerState().failover, 0);
});

test("an Etherna save never takes another redundancy level", async () => {
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { redundancyLevel: 2 as never }), /level 0/);
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

test("auto: Etherna cannot write - two short tries, then stamped on WoCo at level 0, listed and whitelisted", async () => {
  process.env.ETHERNA_FAILOVER = "auto";
  ethernaBytes = () => ({ status: 503 });
  const d = data(10_000);
  const ref = await bytesMod.uploadToBytes(d, ETHERNA, { failover: { parent: PARENT } });
  assert.equal(ref, plainRoot(d), "the address it would have had on Etherna");
  assert.equal(posts(ETH).length, failover.FAILOVER_ETHERNA_ATTEMPTS);
  const [w] = posts(BEE);
  assert.equal(w.headers["swarm-redundancy-level"], "0");
  assert.equal(w.headers["swarm-postage-batch-id"], WOCO_BATCH);
  assert.deepEqual(ledger.getRelayEntry(ref), { kind: "bytes", parent: PARENT, status: "failover", at: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
  assert.ok(calls.some((c) => c.url === `${PROXY}/admin/whitelist`), "readers falling back to our gateway find it");
  assert.equal(health().sinceBoot.failedOver, 1);
  assert.equal(ledger.relayLedgerState().failoverBytes, 1);
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
  assert.equal(ledger.noteBytesFailover("11".repeat(32), PARENT), true);
  assert.equal(ledger.noteBytesFailover("22".repeat(32), PARENT), false, "full");
  ethernaBytes = () => ({ status: 402 });
  await assert.rejects(bytesMod.uploadToBytes(data(10), ETHERNA, { failover: { parent: PARENT } }));
  assert.equal(posts(BEE).length, 0);
});

test("our bee storing a small save at a root other than the plain tree fails it, nothing listed", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  beeBytes = () => ({ root: "ee".repeat(32) });
  await assert.rejects(bytesMod.uploadToBytes(data(5000), ETHERNA, { failover: { parent: PARENT } }), /level-0 root/);
  assert.equal(ledger.relayLedgerState().failover, 0);
});

test("a save deeper than one tree level is listed under the root our bee gave", async () => {
  process.env.ETHERNA_FAILOVER = "force";
  beeBytes = () => ({ root: "ef".repeat(32) });
  const ref = await bytesMod.uploadToBytes(data(600 * 1024), ETHERNA, { failover: { parent: PARENT } });
  assert.equal(ref, "ef".repeat(32));
  assert.ok(ledger.getRelayEntry(ref));
});

test("Etherna storing a small save at a non-plain root keeps the save, and turns plainTree red", async () => {
  ethernaBytes = () => ({ root: "dd".repeat(32) });
  assert.equal(health().plainTree.ok, true);
  assert.equal(await bytesMod.uploadToBytes(data(5000), ETHERNA), "dd".repeat(32));
  assert.equal(health().plainTree.ok, false);
  assert.equal(health().plainTree.mismatches, 1);
  // Over one level nothing is computed here, so nothing is judged.
  failover.__resetFailoverStatsForTest();
  await bytesMod.uploadToBytes(data(600 * 1024), ETHERNA);
  assert.equal(health().plainTree.ok, true);
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
  assert.equal(ledger.noteBytesFailover(root, PARENT), true);
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

test("a root is never made pending", () => {
  process.env.ETHERNA_FAILOVER = "auto";
  const root = "36".repeat(32);
  ledger.noteBytesFailover(root, PARENT);
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
  const posted: Array<{ size: number; batchId: string; timeoutMs: number }> = [];
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
    postBytes: async (d, batchId, timeoutMs) => {
      posted.push({ size: d.length, batchId, timeoutMs });
      const a = io.answer ? io.answer(d) : plainRoot(d);
      if (typeof a !== "string") throw Object.assign(new Error("Etherna /bytes upload failed"), a);
      return a;
    },
    offer: async (a) => {
      offered.push(a);
    },
  };
  return io;
}

/** A root listed now and old enough for the sweep to judge. */
function listed(d: Uint8Array): string {
  const root = plainRoot(d);
  assert.equal(ledger.noteBytesFailover(root, PARENT), true);
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
  assert.deepEqual(io.posted, [{ size: d.length, batchId: ETH_BATCH, timeoutMs: plain.plainBytesTimeoutMs(d.length) }]);
  assert.deepEqual(io.offered, [root]);
  assert.equal(ledger.getRelayEntry(root), undefined);
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
  io.answer = (d) => (d[0] === 1 ? { status: 402 } : plainRoot(d));
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

test("every /bytes upload this server makes by hand goes through postPlainBytes, which always sends level 0", () => {
  const hits: string[] = [];
  for (const p of sourceFiles(SRC)) {
    // A POST endpoint is `<base>/bytes` with nothing after it; reads are `/bytes/<ref>`.
    for (const m of readFileSync(p, "utf-8").matchAll(/\}\/bytes`/g)) hits.push(`${p.slice(SRC.length)}@${m.index}`);
  }
  assert.equal(hits.length, 1, `/bytes senders: ${hits.join(", ")}`);
  assert.match(hits[0], /^lib\/swarm\/plain-bytes\.ts@/);
  const src = readFileSync(join(SRC, "lib/swarm/plain-bytes.ts"), "utf-8");
  const fn = src.slice(src.indexOf("export async function postPlainBytes("));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /"Swarm-Redundancy-Level": "0",\n/, "unconditionally");
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
  // Without a feed signer the server signs the event feed onto this batch itself, and
  // a server-signed Etherna write has no failover: a refused batch stays refused.
  assert.match(svc, /const batchSelection = creatorFeedSigner \? routeSave\(chooseBatch\) : chooseBatch\(\);/);
  // The order key's second leg is the WoCo copy browsers read: no selection, no failover.
  assert.match(svc, /\[uploadToBytes\(bytes\)\]/);
});
