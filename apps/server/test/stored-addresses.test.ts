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

/** What Etherna answers to the next write: an HTTP status, or 0 for no answer at all. */
let ethernaStatus = 201;
/** The root a store claims for a `/bytes` upload. */
let storeRoot = "12".repeat(32);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url === `${ETH}/token`) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
  if (url.startsWith(`${ETH}/api/v0.3/resources/`)) return new Response(null, { status: 200 });
  const toEtherna = url === `${ETH}/bytes` || url.startsWith(`${ETH}/soc/`);
  if (method === "POST" && toEtherna && ethernaStatus === 0) throw new TypeError("fetch failed");
  if (method === "POST" && (url === `${ETH}/bytes` || url === `${BEE}/bytes`)) {
    if (url === `${ETH}/bytes` && ethernaStatus >= 300) return new Response("no", { status: ethernaStatus });
    return new Response(JSON.stringify({ reference: storeRoot }), { status: 201 });
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
  storeRoot = "12".repeat(32);
  list.__resetStoredAddressesForTest({ now: () => now });
});

const files = (): string[] => (existsSync(listDir) ? readdirSync(listDir).sort() : []);
const read = (name: string) => JSON.parse(readFileSync(join(listDir, name), "utf-8"));
/** Every row on disk, whichever file holds it. */
const allSocs = (): string[] => files().flatMap((n) => read(n).batches[PLATFORM]?.soc ?? []).sort();
const soc = (n: number, batchId = PLATFORM) => list.noteStored({ kind: "soc", address: addr(n), batchId });
const bytes = (n: number, level: 0 | 1 = 1, size = 5000, batchId = PLATFORM) =>
  list.noteStored({ kind: "bytes", address: addr(n), batchId, level, size });
const blockTheDirectory = () => {
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(listDir, "in the way");
};

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
});

test("health is public: a verdict and no count of what was listed", () => {
  soc(1);
  bytes(2);
  assert.deepEqual(list.storedAddressesHealth(), { ok: true, recording: true, unsavedFiles: 0 });
});

test("the file name carries the day and a random tag: no time of day, no start time", () => {
  soc(1);
  const first = files()[0]!;
  assert.match(first, /^2026-11-22\.[0-9a-f]{12}\.0\.json$/);
  list.__resetStoredAddressesForTest({ now: () => now });
  soc(1);
  const tags = files().map((n) => n.split(".")[1]);
  assert.equal(new Set(tags).size, 2, "a new run, a new tag");
  for (const t of tags) assert.ok(!t!.includes(now.toString(36)) && !t!.includes(Date.now().toString(36).slice(0, 6)));
});

test("rows are sorted on disk, so the order they arrived in is not kept", () => {
  for (const n of [9, 3, 7, 1]) soc(n);
  bytes(8);
  bytes(2);
  bytes(2, 0);
  assert.deepEqual(read(files()[0]!).batches[PLATFORM], {
    soc: [addr(1), addr(3), addr(7), addr(9)],
    bytes: [[addr(2), 0, 5000], [addr(2), 1, 5000], [addr(8), 1, 5000]],
  });
});

test("another batch is not listed: an account's own batch would mark its rows with its owner", () => {
  soc(1, OTHER);
  bytes(2, 1, 5000, OTHER);
  assert.deepEqual(files(), []);
  // Nor does it hide the same address when the platform batch takes it later.
  soc(1);
  assert.deepEqual(allSocs(), [addr(1)]);
});

test("no platform batch configured: nothing is listed and health says so", () => {
  delete process.env.ETHERNA_PLATFORM_BATCH;
  soc(1);
  assert.deepEqual(files(), []);
  assert.deepEqual(list.storedAddressesHealth(), { ok: true, recording: false, unsavedFiles: 0 });
});

test("the batch and the address are compared without case or 0x", () => {
  process.env.ETHERNA_PLATFORM_BATCH = `0x${PLATFORM.toUpperCase()}`;
  list.noteStored({ kind: "soc", address: `0x${addr(0xabc).toUpperCase()}`, batchId: PLATFORM });
  // The sender's spelling of the batch too: a stamp header is not always lowercase.
  process.env.ETHERNA_PLATFORM_BATCH = PLATFORM;
  list.noteStored({ kind: "soc", address: addr(0xdef), batchId: `0x${PLATFORM.toUpperCase()}` });
  assert.deepEqual(read(files()[0]!).batches, { [PLATFORM]: { soc: [addr(0xabc), addr(0xdef)], bytes: [] } });
});

test("an address sent again is listed once; a file stored at the other level is listed again", () => {
  soc(1);
  soc(1);
  bytes(2, 1);
  bytes(2, 1);
  bytes(2, 0);
  assert.deepEqual(read(files()[0]!).batches[PLATFORM], { soc: [addr(1)], bytes: [[addr(2), 0, 5000], [addr(2), 1, 5000]] });
});

test("a signed chunk and a file are told apart: one never hides the other as a repeat", () => {
  bytes(7, 1);
  soc(7);
  assert.deepEqual(read(files()[0]!).batches[PLATFORM], { soc: [addr(7)], bytes: [[addr(7), 1, 5000]] });
});

test("a full file is closed and the next row opens a new one", () => {
  list.__resetStoredAddressesForTest({ now: () => now, maxRows: 2 });
  for (let i = 1; i <= 5; i++) soc(i);
  const names = files();
  assert.equal(names.length, 3);
  assert.deepEqual(names.map((n) => read(n).batches[PLATFORM].soc.length).sort(), [1, 2, 2]);
  assert.deepEqual(allSocs(), [1, 2, 3, 4, 5].map(addr));
});

test("the repeat check is the open file's alone: a closed file holds nothing in memory", () => {
  list.__resetStoredAddressesForTest({ now: () => now, maxRows: 2 });
  soc(1);
  soc(2);
  soc(3);
  soc(1);
  assert.deepEqual(allSocs(), [addr(1), addr(1), addr(2), addr(3)]);
});

test("midnight UTC opens a new file under the new day", () => {
  soc(1);
  now = T0 + DAY_MS;
  soc(2);
  const byDay = Object.fromEntries(files().map((n) => [read(n).day, read(n).batches[PLATFORM].soc]));
  assert.deepEqual(byDay, { "2026-11-22": [addr(1)], "2026-11-23": [addr(2)] });
  assert.ok(files().some((n) => n.startsWith("2026-11-23.")));
});

test("a clock that steps back opens another file, never an earlier one", () => {
  soc(1);
  now = T0 + DAY_MS;
  soc(2);
  now = T0;
  soc(3);
  assert.equal(files().length, 3);
  assert.deepEqual(allSocs(), [addr(1), addr(2), addr(3)]);
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
  blockTheDirectory();
  assert.doesNotThrow(() => soc(1));
  soc(2);
  let h = list.storedAddressesHealth();
  assert.equal(h.ok, false);
  assert.equal(h.unsavedFiles, 1);
  assert.equal(h.reason, "a file of the list could not be written");

  list.retryStoredAddresses();
  assert.equal(list.storedAddressesHealth().ok, false, "still blocked: still red");

  unlinkSync(listDir);
  list.retryStoredAddresses();
  h = list.storedAddressesHealth();
  assert.deepEqual(h, { ok: true, recording: true, unsavedFiles: 0 });
  assert.deepEqual(read(files()[0]!).batches[PLATFORM].soc, [addr(1), addr(2)]);
});

test("closed files that did not land are kept and written by the retry too", () => {
  list.__resetStoredAddressesForTest({ now: () => now, maxRows: 1 });
  blockTheDirectory();
  soc(1);
  soc(2);
  soc(3);
  assert.equal(list.storedAddressesHealth().unsavedFiles, 3);
  unlinkSync(listDir);
  list.retryStoredAddresses();
  assert.equal(list.storedAddressesHealth().ok, true);
  assert.deepEqual(allSocs(), [addr(1), addr(2), addr(3)]);
});

test("unwritten files past the ceiling are given up, and health stays red after the disk is back", () => {
  list.__resetStoredAddressesForTest({ now: () => now, maxRows: 1, maxUnsaved: 2 });
  blockTheDirectory();
  for (let i = 1; i <= 5; i++) soc(i);
  // Files 1 to 4 are closed (the 5th is open): two are kept, two given up.
  let h = list.storedAddressesHealth();
  assert.equal(h.lostFiles, 2);
  assert.equal(h.unsavedFiles, 3);
  unlinkSync(listDir);
  list.retryStoredAddresses();
  h = list.storedAddressesHealth();
  assert.equal(h.unsavedFiles, 0);
  assert.equal(h.ok, false, "rows were lost: the list is not complete, whatever the disk does now");
  assert.equal(h.lostFiles, 2);
  assert.equal(h.reason, "unwritten files of the list were given up");
  assert.deepEqual(allSocs(), [addr(3), addr(4), addr(5)]);
});

test("a row that cannot be noted turns health red until restart, and nothing throws", () => {
  assert.doesNotThrow(() => list.noteStored({ kind: "soc", address: "not hex", batchId: PLATFORM }));
  assert.deepEqual(files(), []);
  let h = list.storedAddressesHealth();
  assert.equal(h.ok, false);
  assert.equal(h.droppedRows, 1);
  assert.match(String(h.reason), /could not be noted/);

  // A sender that names no batch: nothing says the row was not the platform batch's.
  assert.doesNotThrow(() => list.noteStored({ kind: "soc", address: addr(1), batchId: undefined as unknown as string }));
  assert.equal(list.storedAddressesHealth().droppedRows, 2);

  soc(2);
  list.retryStoredAddresses();
  h = list.storedAddressesHealth();
  assert.equal(h.ok, false, "a later good write does not clear it");
  assert.match(String(h.reason), /could not be noted/);
});

// ---------------------------------------------------------------------------
// The two senders
// ---------------------------------------------------------------------------

const SOC = { ownerHex: "aa".repeat(20), identifierHex: "bb".repeat(32), sigHex: "cc".repeat(65), body: new Uint8Array(40) };
async function socAddress(): Promise<string> {
  const { calculateSocAddress } = await import("@woco/shared");
  return Buffer.from(calculateSocAddress(Buffer.from(SOC.identifierHex, "hex"), Buffer.from(SOC.ownerHex, "hex"))).toString("hex");
}

test("a signed chunk Etherna took is listed under its own address", async () => {
  const { postSocToEtherna } = await import("../src/lib/etherna/upload.js");
  await postSocToEtherna({ ...SOC, batchId: PLATFORM });
  assert.deepEqual(read(files()[0]!).batches, { [PLATFORM]: { soc: [await socAddress()], bytes: [] } });
});

test("a signed chunk Etherna refused is not listed", async () => {
  const { postSocToEtherna } = await import("../src/lib/etherna/upload.js");
  for (const status of [400, 402, 404, 499]) {
    ethernaStatus = status;
    await assert.rejects(postSocToEtherna({ ...SOC, batchId: PLATFORM }));
  }
  assert.deepEqual(files(), []);
});

test("a signed chunk whose send got no answer, or a 5xx, is listed: Etherna may hold it", async () => {
  const { postSocToEtherna } = await import("../src/lib/etherna/upload.js");
  ethernaStatus = 0;
  await assert.rejects(postSocToEtherna({ ...SOC, batchId: PLATFORM }));
  assert.deepEqual(allSocs(), [await socAddress()]);

  list.__resetStoredAddressesForTest({ now: () => now });
  for (const status of [500, 504]) {
    ethernaStatus = status;
    await assert.rejects(postSocToEtherna({ ...SOC, identifierHex: status === 500 ? "b1".repeat(32) : "b2".repeat(32), batchId: PLATFORM }));
  }
  assert.equal(allSocs().length, 3);
});

test("a signed chunk never sent (no Etherna token) is not listed", async () => {
  const { postSocToEtherna } = await import("../src/lib/etherna/upload.js");
  process.env.ETHERNA_ENABLED = "false";
  try {
    await assert.rejects(postSocToEtherna({ ...SOC, batchId: PLATFORM }), /token unavailable/);
    assert.deepEqual(files(), []);
  } finally {
    process.env.ETHERNA_ENABLED = "true";
  }
});

test("a file Etherna took is listed with the level asked and its size; one sent to our bee is not", async () => {
  const { postPlainBytes } = await import("../src/lib/swarm/plain-bytes.js");
  const data = new Uint8Array(7000);

  await postPlainBytes("wocoBee", PLATFORM, data, { level: 1, timeoutMs: 1000, deferred: true });
  assert.deepEqual(files(), []);

  for (const status of [503, 0]) {
    ethernaStatus = status;
    await assert.rejects(postPlainBytes("etherna", PLATFORM, data, { level: 1, timeoutMs: 1000, deferred: true }));
  }
  assert.deepEqual(files(), [], "no answer, no address to list");

  ethernaStatus = 201;
  await postPlainBytes("etherna", PLATFORM, data, { level: 1, timeoutMs: 1000, deferred: true });
  storeRoot = "34".repeat(32);
  await postPlainBytes("etherna", PLATFORM, new Uint8Array(100), { level: 0, timeoutMs: 1000, deferred: true });
  assert.deepEqual(read(files()[0]!).batches, { [PLATFORM]: { soc: [], bytes: [["12".repeat(32), 1, 7000], ["34".repeat(32), 0, 100]] } });
});

test("a save Etherna stored without the repair data asked for is listed at both levels", async () => {
  const { saveForEtherna } = await import("../src/lib/swarm/bytes.js");
  const { plainTreeRoot } = await import("../src/lib/swarm/plain-bytes.js");
  const data = new Uint8Array(9000).fill(7);
  storeRoot = plainTreeRoot(data)!;
  const saved = await saveForEtherna(data, { target: "etherna", batchId: PLATFORM });
  assert.equal(saved.ref, storeRoot);
  assert.deepEqual(read(files()[0]!).batches[PLATFORM].bytes, [[storeRoot, 0, 9000], [storeRoot, 1, 9000]]);
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

test("only the files known to talk to Etherna's gateway hold its address, each for a known reason", () => {
  // The server's Etherna base has one definition (gateway.ts). A new file using it,
  // or a known one using it once more, is a possible way into Etherna's store that
  // the list does not see: this fails until someone has looked.
  const uses: Record<string, number> = {};
  for (const p of sourceFiles(SRC)) {
    const n = [...code(p).matchAll(/\bETHERNA_FETCH_BASE\b/g)].length;
    if (n) uses[p.slice(SRC.length)] = n;
  }
  assert.deepEqual(uses, {
    "lib/etherna/batches.ts": 2,           // import + alias: the stamps and credit API, stores no content
    "lib/etherna/gateway.ts": 2,           // the definition and its boot notice
    "lib/etherna/upload.ts": 2,            // import + alias: postSocToEtherna (lists) and the offers call
    "lib/site/collection-publish.ts": 2,   // import + a READ of a manifest node
    "lib/swarm/bytes.ts": 2,               // import + alias: a READ of /bytes/{ref}
    "lib/swarm/plain-bytes.ts": 2,         // import + postPlainBytes (lists)
    "lib/swarm/soc-read.ts": 2,            // import + alias: a READ of /chunks/{address}
  });
  // Nothing else builds the base from its env name or spells the host out.
  const elsewhere = sourceFiles(SRC).filter((p) => !p.endsWith("lib/etherna/gateway.ts") && /process\.env\.ETHERNA_GATEWAY_URL|["'`]https?:\/\/gateway\.etherna\.io/.test(code(p)));
  assert.deepEqual(elsewhere.map((p) => p.slice(SRC.length)), []);
});

test("every request to Etherna's gateway is one of the known ones", () => {
  // Each template that starts at an Etherna base, by the path that follows it.
  const paths: string[] = [];
  for (const p of sourceFiles(SRC)) {
    for (const m of code(p).matchAll(/\$\{(?:toEtherna \? )?ETHERNA_(?:GW|FETCH_BASE)[^}]*\}([^`\s]*)/g)) paths.push(`${p.slice(SRC.length)} ${m[1]}`);
  }
  assert.deepEqual(paths.sort(), [
    "lib/etherna/batches.ts ${path}",
    "lib/etherna/batches.ts ${path}",
    "lib/etherna/batches.ts /stamps/${batchId}",
    "lib/etherna/upload.ts /api/v0.3/resources/${ref}/offers",
    "lib/etherna/upload.ts /soc/${owner}/${opts.identifierHex}?sig=${opts.sigHex}",
    "lib/site/collection-publish.ts /bytes/${address}",
    "lib/swarm/bytes.ts /bytes/${ref}",
    "lib/swarm/plain-bytes.ts /bytes",
    "lib/swarm/soc-read.ts /chunks/${address}",
  ]);
});

test("the file sender lists what Etherna answered, and only for Etherna", () => {
  const src = code(join(SRC, "lib/swarm/plain-bytes.ts"));
  const fn = src.slice(src.indexOf("export async function postPlainBytes("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const noted = body.indexOf('if (toEtherna) noteStored({ kind: "bytes"');
  assert.ok(noted > body.indexOf("answered without a reference"), "noted only once the store answered a reference");
  assert.ok(noted < body.indexOf("return root;"), "noted before the root is handed back");
});

test("the server starts the retry and reports the list on health", () => {
  const index = code(join(SRC, "index.ts"));
  assert.match(index, /^startStoredAddresses\(\);$/m);
  assert.match(index, /^\s*storedAddresses: storedAddressesHealth\(\),$/m);
});
