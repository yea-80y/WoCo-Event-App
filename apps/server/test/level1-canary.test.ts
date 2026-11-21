/**
 * The boot canary for level-1 saves (`level1-canary.ts`): the three files are the
 * bytes whose roots were measured on both stores, a run asks Etherna for level 1 on
 * the platform batch, and only a completed run concludes anything. Etherna is a
 * stubbed `fetch`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const ETH = "http://etherna.test";
const PLATFORM = "cd".repeat(32);
/** sha256 of the 614,400-byte canary file as Etherna serves it at its pinned root (2026-11-21). */
const DEEP_SHA256 = "dab65257ab97d0fbe14cdfb6cbcf110df412c10e047f7d7d7bd20a9c8ca9e8c8";

process.env.BEE_URL = "http://bee.test";
process.env.ETHERNA_GATEWAY_URL = ETH;
process.env.ETHERNA_TOKEN_ENDPOINT = `${ETH}/token`;
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
delete process.env.ETHERNA_FAILOVER;

type Call = { headers: Record<string, string>; size: number };
const calls: Call[] = [];
/** Etherna's answer to the n-th /bytes POST: a root, a status, or null = the pinned root for that size. */
let answer: (n: number, size: number) => string | { status: number } | null = () => null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === `${ETH}/token`) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  if (url === `${ETH}/bytes` && init?.method === "POST") {
    const size = (init.body as Uint8Array).length;
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ headers, size });
    const a = answer(calls.length - 1, size);
    if (a && typeof a !== "string") return new Response("no", { status: a.status });
    return new Response(JSON.stringify({ reference: a ?? canary.LEVEL1_CANARY.find((c) => c.size === size)!.root }), { status: 201 });
  }
  throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
}) as typeof fetch;

let canary: typeof import("../src/lib/etherna/level1-canary.js");
let failover: typeof import("../src/lib/etherna/failover.js");
let breaker: typeof import("../src/lib/etherna/breaker.js");
let plainRoot: (d: Uint8Array) => string;

before(async () => {
  ({ bytesTreeRoot: plainRoot } = await import("@woco/shared/swarm/bytes-tree"));
  canary = await import("../src/lib/etherna/level1-canary.js");
  failover = await import("../src/lib/etherna/failover.js");
  breaker = await import("../src/lib/etherna/breaker.js");
});

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
  answer = () => null;
  process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
  breaker.__resetEthernaBreaker();
  failover.__resetFailoverStatsForTest();
});

const plainTree = () => (failover.ethernaFailoverHealth() as { plainTree: { ok: boolean; mismatches: number; canary: string; last?: { size: number; what: string } } }).plainTree;
const sha256 = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

test("the canary files are the bytes that were measured: one chunk, one tree level, two tree levels", () => {
  // FROZEN: the roots our bee (2.8.3) and Etherna both gave on 2026-11-21. A change here is a new measurement.
  assert.deepEqual(canary.LEVEL1_CANARY, [
    { size: 3000, root: "ce7f28b2b1a2692a54e9c1a4d697ad9ee488711b2a2e8fa5c7f6082cd80d8a83" },
    { size: 102_400, root: "59ee33e100ce68cf97870353e5efb9bae91eaffa737721f2663b0a0c4cf5c33d" },
    { size: 614_400, root: "0babb408ae76193dddd716fb65c9809e04482adf0dfac71270fbe55126ed1149" },
  ]);
  const [one, mid, deep] = canary.LEVEL1_CANARY;
  // A one-chunk file has its plain root at any level: the pinned root is computable here.
  assert.equal(plainRoot(canary.canaryBytes(one!.size)), one!.root);
  // The live test printed this file's PLAIN root beside its level-1 one (2026-11-21).
  assert.equal(plainRoot(canary.canaryBytes(mid!.size)), "d61ebd3fcb974cb779cd4d28324ce201377384865648658e9711df134f2ab8a8");
  assert.notEqual(mid!.root, plainRoot(canary.canaryBytes(mid!.size)), "a level-1 root");
  // Past 512 KiB nothing here builds the tree: the bytes themselves are pinned, as read back from Etherna.
  assert.equal(sha256(canary.canaryBytes(deep!.size)), DEEP_SHA256);
  assert.ok(deep!.size > 119 * 4096, "two tree levels at level 1: 119 data chunks fill one parent");
});

test("a run saves each file to the platform batch at level 1, deferred, and reports ok", async () => {
  assert.equal(plainTree().canary, "not run");
  assert.equal(await canary.runLevel1Canary(), true);
  assert.deepEqual(calls.map((c) => c.size), [3000, 102_400, 614_400]);
  for (const c of calls) {
    assert.equal(c.headers["swarm-redundancy-level"], "1");
    assert.equal(c.headers["swarm-postage-batch-id"], PLATFORM);
    assert.equal(c.headers["swarm-deferred-upload"], "true");
  }
  assert.equal(plainTree().canary, "ok");
  assert.equal(plainTree().ok, true);
});

test("Etherna answering any file with another root turns plainTree red and names the canary", async () => {
  for (const wrong of [0, 1, 2]) {
    failover.__resetFailoverStatsForTest();
    answer = (n) => (n % 3 === wrong ? "ee".repeat(32) : null);
    assert.equal(await canary.runLevel1Canary(), true, "it ran: the verdict stands, no retry");
    assert.equal(plainTree().canary, "mismatch");
    assert.equal(plainTree().ok, false);
    assert.equal(plainTree().mismatches, 1);
    assert.equal(plainTree().last!.size, canary.LEVEL1_CANARY[wrong]!.size);
    assert.match(plainTree().last!.what, /level-1 canary/);
  }
});

test("a run that could not be made concludes nothing: Etherna failing, paused, or no batch", async () => {
  answer = (n) => (n === 1 ? { status: 503 } : null);
  assert.equal(await canary.runLevel1Canary(), false);
  assert.equal(plainTree().canary, "not run");
  assert.equal(plainTree().ok, true, "an outage is not a mismatch");

  answer = () => null;
  breaker.__resetEthernaBreaker({ slowMs: 0 });
  breaker.noteEthernaFailure("test", performance.now());
  calls.length = 0;
  assert.equal(await canary.runLevel1Canary(), false);
  assert.equal(calls.length, 0, "paused: Etherna is not asked");
  breaker.__resetEthernaBreaker();

  delete process.env.ETHERNA_PLATFORM_BATCH;
  assert.equal(await canary.runLevel1Canary(), false);
  assert.equal(calls.length, 0, "no batch that takes a write: nothing is sent");
  assert.equal(plainTree().canary, "not run");
});

test("it starts only where this server saves to Etherna", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/etherna/level1-canary.ts", import.meta.url), "utf-8");
  assert.match(src, /if \(process\.env\.ETHERNA_ENABLED !== "true" \|\| !process\.env\.ETHERNA_PLATFORM_BATCH\) return;/);
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
  assert.match(index, /\nstartLevel1Canary\(\);\n/);
});
