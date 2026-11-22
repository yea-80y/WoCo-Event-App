/**
 * The stored-address list (`lib/swarm/stored-addresses.ts`): what it holds, what
 * it must never hold, and that the two functions that put anything on Etherna
 * are the ones that write it. Etherna and bee are a stubbed `fetch`; the list
 * lives in a temp cwd.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BEE = "http://bee.test";
const ETH = "http://etherna.test";
const PLATFORM = "cd".repeat(32);
const OTHER = "ef".repeat(32);
const T0 = Date.parse("2026-11-22T10:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const addr = (n: number) => n.toString(16).padStart(64, "0");

process.env.BEE_URL = BEE;
process.env.ETHERNA_GATEWAY_URL = ETH;
process.env.ETHERNA_TOKEN_ENDPOINT = `${ETH}/token`;
process.env.ETHERNA_ENABLED = "true";
process.env.ETHERNA_API_KEY = "id.secret";
process.env.POSTAGE_BATCH_ID = "ab".repeat(32);
delete process.env.ETHERNA_FAILOVER;

/** What the stores answer to the next write: a status, or success. */
let ethernaStatus = 201;
const ROOT = "12".repeat(32);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url === `${ETH}/token`) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  if (method === "POST" && (url === `${ETH}/bytes` || url === `${BEE}/bytes`)) {
    if (url === `${ETH}/bytes` && ethernaStatus >= 300) return new Response("no", { status: ethernaStatus });
    return new Response(JSON.stringify({ reference: ROOT }), { status: 201 });
  }
  if (method === "POST" && url.startsWith(`${ETH}/soc/`)) return new Response(ethernaStatus < 300 ? "{}" : "no", { status: ethernaStatus });
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

let list: typeof import("../src/lib/swarm/stored-addresses.js");
let dir: string;
let listDir: string;
let originalCwd: string;
let now = T0;

before(async () => {
  originalCwd = process.cwd();
  list = await import("../src/lib/swarm/stored-addresses.js");
});

after(() => {
  process.chdir(originalCwd);
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "woco-stored-addresses-"));
  listDir = join(dir, ".data", "stored-addresses");
  process.chdir(dir);
  process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
  now = T0;
  ethernaStatus = 201;
  list.__resetStoredAddressesForTest({ now: () => now });
});

const files = (): string[] => (existsSync(listDir) ? readdirSync(listDir).sort() : []);
const read = (name: string) => JSON.parse(readFileSync(join(listDir, name), "utf-8"));
const soc = (n: number, batchId = PLATFORM) => list.noteStored({ kind: "soc", address: addr(n), batchId });
const bytes = (n: number, level: 0 | 1 = 1, size = 5000, batchId = PLATFORM) =>
  list.noteStored({ kind: "bytes", address: addr(n), batchId, level, size });

test("a signed chunk and a file on the platform batch are listed, and the file holds nothing else", () => {
  soc(1);
  bytes(2, 1, 9000);
  assert.equal(files().length, 1);
  assert.deepEqual(read(files()[0]!), {
    v: 1,
    day: "2026-11-22",
    batches: { [PLATFORM]: { soc: [addr(1)], bytes: [[addr(2), 1, 9000]] } },
  });
  assert.equal(statSync(join(listDir, files()[0]!)).mode & 0o777, 0o600);
  assert.deepEqual(list.storedAddressesHealth(), { ok: true, recording: true, rowsThisRun: 2, filesThisRun: 1, unsavedFiles: 0 });
});

test("the file name carries the day and no time of day", () => {
  soc(1);
  assert.match(files()[0]!, /^2026-11-22\.[0-9a-z]+\.0\.json$/);
});

test("another batch is not listed: an account's own batch would mark its rows with its owner", () => {
  soc(1, OTHER);
  bytes(2, 1, 5000, OTHER);
  assert.deepEqual(files(), []);
  assert.equal(list.storedAddressesHealth().rowsThisRun, 0);
});

test("no platform batch configured: nothing is listed and health says so", () => {
  delete process.env.ETHERNA_PLATFORM_BATCH;
  soc(1);
  assert.deepEqual(files(), []);
  assert.equal(list.storedAddressesHealth().recording, false);
  assert.equal(list.storedAddressesHealth().ok, true);
});

test("the batch and the address are compared without case or 0x", () => {
  process.env.ETHERNA_PLATFORM_BATCH = `0x${PLATFORM.toUpperCase()}`;
  list.noteStored({ kind: "soc", address: `0x${addr(0xabc).toUpperCase()}`, batchId: PLATFORM });
  assert.deepEqual(read(files()[0]!).batches, { [PLATFORM]: { soc: [addr(0xabc)], bytes: [] } });
});

test("an address sent again is listed once; a file stored at the other level is listed again", () => {
  soc(1);
  soc(1);
  bytes(2, 1);
  bytes(2, 1);
  bytes(2, 0);
  assert.deepEqual(read(files()[0]!).batches[PLATFORM], { soc: [addr(1)], bytes: [[addr(2), 1, 5000], [addr(2), 0, 5000]] });
  assert.equal(list.storedAddressesHealth().rowsThisRun, 3);
});

test("a full file is closed and the next row opens a new one", () => {
  list.__resetStoredAddressesForTest({ now: () => now, maxRows: 2 });
  for (let i = 1; i <= 5; i++) soc(i);
  const names = files();
  assert.equal(names.length, 3);
  assert.deepEqual(names.map((n) => read(n).batches[PLATFORM].soc), [[addr(1), addr(2)], [addr(3), addr(4)], [addr(5)]]);
});

test("midnight UTC opens a new file under the new day", () => {
  soc(1);
  now = T0 + DAY_MS;
  soc(2);
  const byDay = Object.fromEntries(files().map((n) => [read(n).day, read(n).batches[PLATFORM].soc]));
  assert.deepEqual(byDay, { "2026-11-22": [addr(1)], "2026-11-23": [addr(2)] });
});

test("a new run never opens or changes a file an earlier run wrote", () => {
  soc(1);
  const first = files()[0]!;
  const before = readFileSync(join(listDir, first), "utf-8");
  list.__resetStoredAddressesForTest({ now: () => now });
  soc(1);
  soc(2);
  assert.equal(files().length, 2);
  assert.equal(readFileSync(join(listDir, first), "utf-8"), before);
  const second = files().find((n) => n !== first)!;
  // A restart forgets what was listed: the repeat is the reader's to fold.
  assert.deepEqual(read(second).batches[PLATFORM].soc, [addr(1), addr(2)]);
});

test("an unreadable file from an earlier run is left exactly as it is", () => {
  mkdirSync(listDir, { recursive: true });
  const damaged = join(listDir, "2026-11-22.old.0.json");
  writeFileSync(damaged, "{ not json");
  soc(1);
  assert.equal(readFileSync(damaged, "utf-8"), "{ not json");
  assert.equal(files().length, 2);
  assert.equal(list.storedAddressesHealth().ok, true);
});

test("a write that does not land keeps its rows, turns health red, and lands on the retry", () => {
  // The list's directory cannot be made: a file sits where it belongs.
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(listDir, "in the way");
  assert.doesNotThrow(() => soc(1));
  soc(2);
  let h = list.storedAddressesHealth();
  assert.equal(h.ok, false);
  assert.equal(h.unsavedFiles, 1);
  assert.equal(h.rowsThisRun, 2);
  assert.match(String(h.lastError), /could not write/);

  list.retryStoredAddresses();
  assert.equal(list.storedAddressesHealth().ok, false, "still blocked: still red");

  unlinkSync(listDir);
  list.retryStoredAddresses();
  h = list.storedAddressesHealth();
  assert.equal(h.ok, true);
  assert.equal(h.unsavedFiles, 0);
  assert.equal(h.lastError, undefined);
  assert.deepEqual(read(files()[0]!).batches[PLATFORM].soc, [addr(1), addr(2)]);
});

test("closed files that did not land are kept and written by the retry too", () => {
  list.__resetStoredAddressesForTest({ now: () => now, maxRows: 1 });
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(listDir, "in the way");
  soc(1);
  soc(2);
  soc(3);
  assert.equal(list.storedAddressesHealth().unsavedFiles, 3);
  unlinkSync(listDir);
  list.retryStoredAddresses();
  assert.equal(list.storedAddressesHealth().ok, true);
  assert.deepEqual(files().map((n) => read(n).batches[PLATFORM].soc[0]).sort(), [addr(1), addr(2), addr(3)]);
});

test("a malformed address is not listed and nothing throws", () => {
  assert.doesNotThrow(() => list.noteStored({ kind: "soc", address: "not hex", batchId: PLATFORM }));
  assert.doesNotThrow(() => list.noteStored({ kind: "soc", address: undefined as unknown as string, batchId: PLATFORM }));
  assert.deepEqual(files(), []);
});

// ---------------------------------------------------------------------------
// The two senders
// ---------------------------------------------------------------------------

const SOC = { ownerHex: "aa".repeat(20), identifierHex: "bb".repeat(32), sigHex: "cc".repeat(65), body: new Uint8Array(40) };

test("a signed chunk Etherna took is listed under its own address; one it refused is not", async () => {
  const { postSocToEtherna } = await import("../src/lib/etherna/upload.js");
  const { calculateSocAddress } = await import("@woco/shared");
  const address = Buffer.from(calculateSocAddress(Buffer.from(SOC.identifierHex, "hex"), Buffer.from(SOC.ownerHex, "hex"))).toString("hex");

  ethernaStatus = 500;
  await assert.rejects(postSocToEtherna({ ...SOC, batchId: PLATFORM }));
  assert.deepEqual(files(), []);

  ethernaStatus = 201;
  await postSocToEtherna({ ...SOC, batchId: PLATFORM });
  assert.deepEqual(read(files()[0]!).batches, { [PLATFORM]: { soc: [address], bytes: [] } });
});

test("a file Etherna took is listed with the level asked and its size; one sent to our bee is not", async () => {
  const { postPlainBytes } = await import("../src/lib/swarm/plain-bytes.js");
  const data = new Uint8Array(7000);

  await postPlainBytes("wocoBee", PLATFORM, data, { level: 1, timeoutMs: 1000, deferred: true });
  assert.deepEqual(files(), []);

  ethernaStatus = 503;
  await assert.rejects(postPlainBytes("etherna", PLATFORM, data, { level: 1, timeoutMs: 1000, deferred: true }));
  assert.deepEqual(files(), []);

  ethernaStatus = 201;
  await postPlainBytes("etherna", PLATFORM, data, { level: 1, timeoutMs: 1000, deferred: true });
  assert.deepEqual(read(files()[0]!).batches, { [PLATFORM]: { soc: [], bytes: [[ROOT, 1, 7000]] } });
});

// ---------------------------------------------------------------------------
// The ratchet: nothing reaches Etherna's store around the two senders
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
function sourceFiles(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const code = (p: string) => readFileSync(p, "utf-8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("one function puts a file on Etherna, and it lists what Etherna took", () => {
  // An upload goes to the bare `/bytes`, `/bzz` or `/chunks` of an Etherna base; a read names an address after it.
  const hits: string[] = [];
  for (const p of sourceFiles(SRC)) {
    for (const m of code(p).matchAll(/`[^`\n]*ETHERNA_[A-Z_]+[^`\n]*\/(bytes|bzz|chunks)`/g)) hits.push(`${p.slice(SRC.length)}: ${m[0]}`);
  }
  assert.equal(hits.length, 1, `Etherna upload senders: ${hits.join(" | ")}`);
  assert.match(hits[0]!, /^lib\/swarm\/plain-bytes\.ts: /);

  const src = readFileSync(join(SRC, "lib/swarm/plain-bytes.ts"), "utf-8");
  const fn = src.slice(src.indexOf("export async function postPlainBytes("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const noted = body.indexOf('if (toEtherna) noteStored({ kind: "bytes"');
  assert.ok(noted > body.indexOf("answered without a reference"), "noted only once the store answered a reference");
  assert.ok(noted < body.indexOf("return root;"), "noted before the root is handed back");
});

test("the one function that sends a signed chunk to Etherna lists it once Etherna took it", () => {
  const src = readFileSync(join(SRC, "lib/etherna/upload.ts"), "utf-8");
  const fn = src.slice(src.indexOf("export async function postSocToEtherna("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const noted = body.indexOf('noteStored({ kind: "soc"');
  assert.ok(noted > body.indexOf("if (!res.ok)"), "noted after the refusal check");
  assert.ok(noted < body.indexOf("} catch (err)"), "noted inside the send, not on its failure");
  // Its being the only sender is pinned in test/etherna-failover.test.ts.
});
