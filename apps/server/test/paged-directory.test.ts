/**
 * Paged creator directories (#950): page 0 is a feed update holding the newest
 * items and, past one page, the ref of ONE immutable blob holding the rest. The
 * blob is uploaded first and page 0 written last, so page 0 is the whole commit.
 *
 * Before #950 the overflow pages were feeds rewritten in place: a write that
 * failed between them and page 0 tore the directory, and every later write had
 * to refuse it for good. Pinned here against the shared fake bee:
 *  - a failed page 0 leaves the old page 0 naming the old blob: it reads whole,
 *    and the next write builds on it (THE BUG);
 *  - a refused blob upload writes nothing;
 *  - an overflow that cannot be read or decoded is refused by the write path and
 *    an error for display, never page 0 alone; it is read from our bee only;
 *  - a pre-#950 directory reads whole and moves to a blob on its next write;
 *  - a page 0 naming a blob says `pages: 1`, which a pre-#950 reader takes as an
 *    overflow feed that is missing - it refuses rather than drop the blob's items.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "ethers";
import { Topic } from "@ethersphere/bee-js";
import { startFakeBee, type FakeBee } from "./helpers/fake-bee.js";

const DEAD = "http://127.0.0.1:9";
const KEY = Wallet.createRandom().privateKey;
const OWNER = new Wallet(KEY).address.slice(2).toLowerCase();

let bee: FakeBee;
/** An Etherna gateway that answers every `/bytes` read with a forged directory. */
let etherna: Server;
let ethernaReads = 0;
let dir: string;
let originalCwd: string;
let feeds: typeof import("../src/lib/swarm/feeds.js");
let bytes: typeof import("../src/lib/swarm/bytes.js");
let paged: typeof import("../src/lib/swarm/paged-feed.js");

before(async () => {
  bee = await startFakeBee();
  etherna = createServer((req, res) => {
    ethernaReads++;
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(JSON.stringify({ v: 1, items: [{ id: "forged", pad: "" }] }));
  });
  await new Promise<void>((r) => etherna.listen(0, "127.0.0.1", r));
  process.env.BEE_URL = bee.url;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_GATEWAY_URL = `http://127.0.0.1:${(etherna.address() as AddressInfo).port}`;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
  process.env.FEED_PRIVATE_KEY = KEY;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-paged-directory-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  feeds = await import("../src/lib/swarm/feeds.js");
  bytes = await import("../src/lib/swarm/bytes.js");
  paged = await import("../src/lib/swarm/paged-feed.js");
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
});

after(async () => {
  await bee.close();
  await new Promise<void>((r) => etherna.close(() => r()));
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  bee.reset();
  feeds.__feedWriteTestHooks.clearCache();
  feeds.__feedWriteTestHooks.setClock(null);
});

interface Item {
  id: string;
  pad: string;
}
interface Page0 {
  v: 1;
  items: Item[];
  updatedAt: string;
  pages?: number;
  overflow?: string;
}

let dirNo = 0;
const newName = () => `d${++dirNo}-${Date.now()}`;
const topicOf = (name: string, page: number) => Topic.fromString(page === 0 ? `woco/test/paged/${name}` : `woco/test/paged/${name}/p${page}`);
const topicHex = (name: string, page = 0) => topicOf(name, page).toHex().replace(/^0x/, "").toLowerCase();
const directory = (name: string) => ({
  topic: (p: number) => topicOf(name, p),
  envelope: ({ items, updatedAt }: { items: Item[]; updatedAt: string }) => ({ v: 1, items, updatedAt }),
  items: (env: unknown) => (env as Partial<Page0>).items,
});

/** Every update written to page 0, oldest first. */
const page0Writes = (name: string) => bee.payloads(OWNER, topicHex(name)).map((p) => feeds.decodeJsonFeed<Page0>(p)!);
const latest = (name: string) => page0Writes(name).at(-1)!;
const blob = (ref: string) => JSON.parse(new TextDecoder().decode(bee.blobs.get(ref)!)) as { v: number; items: Item[] };

const small = (id: string): Item => ({ id, pad: "" });
/** ~950 bytes: four fill page 0. */
const big = (id: string): Item => ({ id, pad: "P".repeat(920) });
const ids = (items: Item[]) => items.map((i) => i.id);
const bigs = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => big(`${prefix}${n - i}`)); // newest first

test("one page: page 0 alone, `pages: 0`, no blob", async () => {
  const name = newName();
  const blobsBefore = bee.blobs.size;
  await paged.writePagedDirectory(directory(name), [small("a"), small("b"), small("c")]);
  const p0 = latest(name);
  assert.deepEqual(ids(p0.items), ["a", "b", "c"]);
  assert.equal(p0.pages, 0);
  assert.equal(p0.overflow, undefined);
  assert.equal(bee.blobs.size, blobsBefore);
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ["a", "b", "c"]);
});

test("past one page: the newest items on page 0, the rest in ONE blob it names, read back whole and in order", async () => {
  const name = newName();
  const ten = bigs(10, "e");
  await paged.writePagedDirectory(directory(name), ten);
  assert.equal(page0Writes(name).length, 1);
  const p0 = latest(name);
  assert.deepEqual(ids(p0.items), ["e10", "e9", "e8", "e7"]);
  assert.equal(p0.pages, 1);
  assert.match(p0.overflow!, /^[0-9a-f]{64}$/);
  assert.deepEqual(blob(p0.overflow!), { v: 1, items: ten.slice(4) });
  // Page 0 stays one plain JSON update under 4096 bytes (no gzip fallback).
  const raw = bee.payloads(OWNER, topicHex(name)).at(-1)!;
  assert.equal(raw[0], "{".charCodeAt(0));
  assert.ok(raw.indexOf(0) <= 4096);
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(ten));
  const shown = await paged.readPagedDirectoryForDisplay(directory(name));
  assert.equal(shown.status, "ok");
  assert.deepEqual(ids(shown.status === "ok" ? shown.data.items : []), ids(ten));
});

test("page 0 is sized WITH the ref: across the boundary where the ref tips it over, it stays one plain JSON update under 4096 bytes", async () => {
  // Item sizes stepped through the ~85 bytes the ref adds: some step fits four
  // items without the ref and only three with it.
  for (let pad = 880; pad <= 980; pad += 5) {
    const name = newName();
    const items = Array.from({ length: 10 }, (_, i): Item => ({ id: `e${10 - i}`, pad: "P".repeat(pad) }));
    await paged.writePagedDirectory(directory(name), items);
    const raw = bee.payloads(OWNER, topicHex(name)).at(-1)!;
    const end = raw.indexOf(0);
    assert.equal(raw[0], "{".charCodeAt(0), `pad ${pad}: plain JSON, not the gzip fallback`);
    assert.ok(end === -1 || end <= 4096, `pad ${pad}: under 4096 bytes`);
    assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(items));
  }
});

test("THE BUG (#950): page 0's write fails after the blob uploaded - the old page 0 still reads whole, and the next write builds on it", async (t) => {
  t.mock.method(console, "log", () => {});
  const name = newName();
  const eight = bigs(8, "e");
  await paged.writePagedDirectory(directory(name), eight);
  const committed = latest(name);

  // e9 shifts every item: a new blob is uploaded, then page 0's upload fails. Before
  // #950 this rewrote overflow feeds in place and left a directory every later
  // write refused ("torn"); e1 read as lost and e5 twice.
  const nine = [big("e9"), ...eight];
  bee.uploadFails(OWNER, topicHex(name), true);
  await assert.rejects(paged.writePagedDirectory(directory(name), nine));
  assert.equal(page0Writes(name).length, 1, "page 0 is the commit: still the first write");
  assert.ok(bee.blobs.has(committed.overflow!), "the blob it names was never touched");
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(eight), "every item once");

  bee.uploadFails(OWNER, topicHex(name), false);
  const base = (await paged.readPagedDirectoryForWrite(directory(name))).items;
  await paged.writePagedDirectory(directory(name), [big("e9"), ...base]);
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(nine));
});

test("a refused blob upload writes nothing: page 0 untouched", async () => {
  const name = newName();
  await paged.writePagedDirectory(directory(name), bigs(4, "e"));
  bee.net.bytesUploadFails = true;
  await assert.rejects(paged.writePagedDirectory(directory(name), bigs(5, "e")), /batch not usable|402/);
  assert.equal(page0Writes(name).length, 1);
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(bigs(4, "e")));
});

test("an overflow blob that cannot be read: the write path refuses, display reads an error - never page 0 alone", async () => {
  const name = newName();
  await paged.writePagedDirectory(directory(name), bigs(8, "e"));
  const ref = latest(name).overflow!;
  const kept = bee.blobs.get(ref)!;
  bee.blobs.delete(ref);
  await assert.rejects(paged.readPagedDirectoryForWrite(directory(name)), /overflow [0-9a-f]{16} unreadable.*refusing to write/);
  assert.deepEqual(await paged.readPagedDirectoryForDisplay(directory(name)), { status: "error" });
  bee.blobs.set(ref, kept);
  assert.equal((await paged.readPagedDirectoryForWrite(directory(name))).items.length, 8);
});

test("the overflow is read from our bee only, never from Etherna, whose answer nothing checks against the ref", async () => {
  const name = newName();
  await paged.writePagedDirectory(directory(name), bigs(8, "e"));
  const ref = latest(name).overflow!;
  process.env.ETHERNA_ENABLED = "true";
  try {
    ethernaReads = 0;
    assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(bigs(8, "e")));
    const kept = bee.blobs.get(ref)!;
    bee.blobs.delete(ref);
    await assert.rejects(paged.readPagedDirectoryForWrite(directory(name)), /unreadable/, "Etherna's copy is never taken instead");
    assert.deepEqual(await paged.readPagedDirectoryForDisplay(directory(name)), { status: "error" });
    bee.blobs.set(ref, kept);
    assert.equal(ethernaReads, 0);
  } finally {
    delete process.env.ETHERNA_ENABLED;
  }
});

test("an overflow that does not decode, is another shape, or is no ref at all: refused", async () => {
  const page0 = (overflow: string) => ({ v: 1, items: [small("a")], updatedAt: new Date().toISOString(), pages: 1, overflow });
  const cases: Array<[string, RegExp]> = [
    [await bytes.uploadToBytes("not json at all"), /did not decode/],
    [await bytes.uploadToBytes("null"), /did not decode/],
    [await bytes.uploadToBytes(JSON.stringify({ v: 2, items: [] })), /did not decode/],
    [await bytes.uploadToBytes(JSON.stringify({ v: 1, entries: [] })), /did not decode/],
    ["zz", /no valid overflow ref/],
    ["AB".repeat(32), /no valid overflow ref/],
  ];
  for (const [overflow, why] of cases) {
    const name = newName();
    await feeds.writeFeedPage(topicOf(name, 0), feeds.encodeJsonFeed(page0(overflow)));
    await assert.rejects(paged.readPagedDirectoryForWrite(directory(name)), why);
    assert.deepEqual(await paged.readPagedDirectoryForDisplay(directory(name)), { status: "error" });
  }
});

test("a page 0 whose items are missing does not decode: refused, never read as empty", async () => {
  const name = newName();
  await feeds.writeFeedPage(topicOf(name, 0), feeds.encodeJsonFeed({ v: 1, updatedAt: new Date().toISOString(), pages: 0 }));
  await assert.rejects(paged.readPagedDirectoryForWrite(directory(name)), /page 0 did not decode/);
});

test("shrinking back to one page drops the blob: `pages: 0`, no overflow", async () => {
  const name = newName();
  await paged.writePagedDirectory(directory(name), bigs(8, "e"));
  await paged.writePagedDirectory(directory(name), bigs(2, "e"));
  const p0 = latest(name);
  assert.equal(p0.pages, 0);
  assert.equal(p0.overflow, undefined);
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ["e2", "e1"]);
});

test("an item too large for page 0 beside the ref goes to the blob with everything after it", async () => {
  const name = newName();
  const huge: Item = { id: "huge", pad: "H".repeat(5000) };
  await paged.writePagedDirectory(directory(name), [huge, small("b")]);
  const p0 = latest(name);
  assert.deepEqual(p0.items, []);
  assert.deepEqual(ids(blob(p0.overflow!).items), ["huge", "b"]);
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ["huge", "b"]);
});

test("a pre-#950 directory (an overflow FEED stamped like page 0) reads whole, and its next write moves the overflow into a blob", async () => {
  const name = newName();
  const updatedAt = "2026-10-20T00:00:00.000Z";
  await feeds.writeFeedPage(topicOf(name, 1), feeds.encodeJsonFeed({ v: 1, items: [small("old2"), small("old1")], updatedAt }));
  await feeds.writeFeedPage(topicOf(name, 0), feeds.encodeJsonFeed({ v: 1, items: [small("old4"), small("old3")], updatedAt, pages: 1 }));
  const shown = await paged.readPagedDirectoryForDisplay(directory(name));
  assert.deepEqual(ids(shown.status === "ok" ? shown.data.items : []), ["old4", "old3", "old2", "old1"]);

  const base = (await paged.readPagedDirectoryForWrite(directory(name))).items;
  assert.deepEqual(ids(base), ["old4", "old3", "old2", "old1"]);
  const all = [...bigs(5, "new"), ...base];
  await paged.writePagedDirectory(directory(name), all);
  assert.ok(latest(name).overflow, "now a blob");
  assert.deepEqual(ids((await paged.readPagedDirectoryForWrite(directory(name))).items), ids(all));
  assert.equal(bee.payloads(OWNER, topicHex(name, 1)).length, 1, "the old overflow feed is left as it was");
});

test("a page 0 naming a blob says `pages: 1`: read without the blob, as a pre-#950 build would, it is refused, never page 0 alone", async () => {
  const name = newName();
  await paged.writePagedDirectory(directory(name), bigs(8, "e"));
  const p0 = latest(name);
  assert.equal(p0.pages, 1);
  // A build from before #950 does not know `overflow`: it reads `pages: 1` as overflow
  // feed 1, which was never written. The legacy branch here is that reader's code.
  const blind = newName();
  const { overflow: _ignored, ...withoutBlob } = p0;
  await feeds.writeFeedPage(topicOf(blind, 0), feeds.encodeJsonFeed(withoutBlob));
  await assert.rejects(paged.readPagedDirectoryForWrite(directory(blind)), /overflow page 1 of 1 missing/);
});
