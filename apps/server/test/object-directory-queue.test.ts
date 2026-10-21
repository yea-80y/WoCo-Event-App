/**
 * The creator object directory (`woco/object/creator/{addr}`), #942: a creator's
 * first confirmed series could be missing from it for good, the same bee 2.8
 * skip-list loss as the site directory (#944) and the event index - and the old
 * write path made it likelier by reading page 0 twice (strict, then leniently
 * for the categories) before its own index-0 probe.
 *
 * Pinned against the shared fake bee:
 *  - upserts and category edits share one ordered queue and one strict read per
 *    attempt, categories taken from that read's page-0 envelope;
 *  - an awaited caller (the manager's PUT routes, a badge mint) is answered after
 *    ONE attempt - "retrying" when bee cannot read the directory yet - and the
 *    retry completes without it;
 *  - an unreadable directory is never written as empty;
 *  - page 0 is written last (it commits the page count, not the contents): a
 *    page 0 claiming a missing overflow page, or overflow pages stamped by
 *    another write (a torn write), is never rewritten from (`paged-feed.ts`).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Topic } from "@ethersphere/bee-js";
import { objectCreatorDirectoryTopic, type ObjectCategory, type ObjectDirectory, type ObjectDirectoryEntry } from "@woco/shared";
import { startFakeBee, socAddress, type FakeBee } from "./helpers/fake-bee.js";

const DEAD = "http://127.0.0.1:9";
const KEY = Wallet.createRandom().privateKey;
const OWNER = new Wallet(KEY).address.slice(2).toLowerCase();

let bee: FakeBee;
let dir: string;
let originalCwd: string;
let feeds: typeof import("../src/lib/swarm/feeds.js");
let directory: typeof import("../src/lib/object/directory.js");
let retryHooks: typeof import("../src/lib/swarm/first-write-retry.js").__firstWriteRetryTestHooks;

const sleeps: number[] = [];
let onSleep: ((ms: number) => void | Promise<void>) | null = null;

before(async () => {
  bee = await startFakeBee();
  process.env.BEE_URL = bee.url;
  process.env.PROXY_URL = DEAD;
  process.env.ETHERNA_GATEWAY_URL = DEAD;
  process.env.ETHERNA_TOKEN_ENDPOINT = `${DEAD}/token`;
  process.env.FEED_PRIVATE_KEY = KEY;
  process.env.POSTAGE_BATCH_ID = "aa".repeat(32);
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-object-directory-"));
  process.chdir(dir);
  mkdirSync(join(dir, ".data"));

  feeds = await import("../src/lib/swarm/feeds.js");
  directory = await import("../src/lib/object/directory.js");
  ({ __firstWriteRetryTestHooks: retryHooks } = await import("../src/lib/swarm/first-write-retry.js"));
  feeds.__feedWriteTestHooks.setBaseBackoffMs(0);
  retryHooks.setSleep(async (ms) => {
    sleeps.push(ms);
    await onSleep?.(ms);
  });
});

after(async () => {
  retryHooks.setSleep(null);
  await bee.close();
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  bee.reset();
  sleeps.length = 0;
  onSleep = null;
  feeds.__feedWriteTestHooks.clearCache();
  feeds.__feedWriteTestHooks.setClock(null);
});

const newCreator = () => Wallet.createRandom().address.toLowerCase();
const dirTopicHex = (creator: string, page = 0) =>
  Topic.fromString(objectCreatorDirectoryTopic(creator, page)).toHex().replace(/^0x/, "").toLowerCase();
const skip = (creator: string, on: boolean) => bee.skipTopic(OWNER, dirTopicHex(creator), on);

function writes(creator: string): ObjectDirectory[] {
  return bee.payloads(OWNER, dirTopicHex(creator)).map((p) => feeds.decodeJsonFeed<ObjectDirectory>(p)!);
}

let refNo = 0;
function object(extra: Partial<ObjectDirectoryEntry> = {}): ObjectDirectoryEntry {
  const ref = (++refNo).toString(16).padStart(64, "0");
  return {
    manifestRef: `0x${ref}` as ObjectDirectoryEntry["manifestRef"],
    kind: "ticket",
    name: `Series ${refNo}`,
    supply: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}
const category = (id: string): ObjectCategory => ({ id, label: `Label ${id}`, sortIndex: 0 });

test("THE BUG: a creator's first series, directory skip-listed -> retried past the window and written", async () => {
  const creator = newCreator();
  const a = object();
  skip(creator, true);
  onSleep = () => skip(creator, false);
  await directory.upsertCreatorObject(creator, a).written;
  assert.deepEqual(sleeps, [70_000]);
  assert.equal(writes(creator).length, 1);
  assert.deepEqual(writes(creator)[0]!.objects, [a]);
});

test("an awaited caller is answered after ONE attempt - 'retrying' mid-wait, nothing written yet - and the retry completes", { timeout: 20_000 }, async (t) => {
  t.mock.method(console, "warn", () => {});
  const creator = newCreator();
  const a = object({ name: "Edited" });
  skip(creator, true);
  let release!: () => void;
  const minute = new Promise<void>((r) => (release = r));
  onSleep = () => minute;
  const q = directory.upsertCreatorObject(creator, a);
  assert.equal(await q.firstAttempt, "retrying");
  assert.equal(writes(creator).length, 0, "the request is answered while the retry waits");
  skip(creator, false);
  release();
  await q.written;
  assert.deepEqual(writes(creator).at(-1)!.objects, [a]);
});

test("an awaited caller on a readable directory hears 'written'", { timeout: 20_000 }, async () => {
  const creator = newCreator();
  assert.equal(await directory.setCreatorObjectCategories(creator, [category("c1")]).firstAttempt, "written");
  assert.deepEqual(writes(creator).at(-1)!.categories, [category("c1")]);
});

test("categories and upserts interleaved during a retry: one write, objects in upsert order, the later category list wins", async (t) => {
  t.mock.method(console, "warn", () => {});
  const creator = newCreator();
  const a = object();
  const b = object();
  const a2 = { ...a, name: "A renamed" };
  skip(creator, true);
  onSleep = () => {
    directory.setCreatorObjectCategories(creator, [category("first")]);
    directory.upsertCreatorObject(creator, b);
    directory.setCreatorObjectCategories(creator, [category("second")]);
    directory.upsertCreatorObject(creator, a2);
    skip(creator, false);
  };
  await directory.upsertCreatorObject(creator, a).written;
  await new Promise((r) => setImmediate(r));
  assert.equal(writes(creator).length, 1, "all five changes in one write");
  const w = writes(creator)[0]!;
  assert.deepEqual(w.objects, [a2, b], "most recently upserted first, replaced whole");
  assert.deepEqual(w.categories, [category("second")]);
});

test("an upsert reads page 0 ONCE per attempt and keeps the categories from that strict read", async () => {
  const creator = newCreator();
  const a = object();
  await directory.setCreatorObjectCategories(creator, [category("keep")]).written;
  await directory.upsertCreatorObject(creator, a).written;
  const before = bee.lookupsOf(dirTopicHex(creator));
  const b = object();
  await directory.upsertCreatorObject(creator, b).written;
  assert.equal(bee.lookupsOf(dirTopicHex(creator)) - before, 1, "one page-0 lookup: no second, lenient read for categories");
  const w = writes(creator).at(-1)!;
  assert.deepEqual(w.objects, [b, a]);
  assert.deepEqual(w.categories, [category("keep")]);
});

test("an existing directory that cannot be read is never written as empty - objects and categories survive", async () => {
  const creator = newCreator();
  let clock = 1_000_000;
  feeds.__feedWriteTestHooks.setClock(() => clock);
  const a = object();
  await directory.setCreatorObjectCategories(creator, [category("c")]).written;
  await directory.upsertCreatorObject(creator, a).written;
  clock += feeds.READ_YOUR_WRITES_MS + 1;
  skip(creator, true);
  const n = writes(creator).length;
  onSleep = () => {
    assert.equal(writes(creator).length, n, "nothing written while unreadable");
    skip(creator, false);
  };
  const b = object();
  await directory.upsertCreatorObject(creator, b).written;
  assert.deepEqual(sleeps, [70_000]);
  const w = writes(creator).at(-1)!;
  assert.deepEqual(w.objects, [b, a]);
  assert.deepEqual(w.categories, [category("c")]);
});

test("the request callers wait for ONE attempt, never for the retry; event creation waits for nothing", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");
  const routes = src("../src/routes/objects.ts");
  assert.match(routes, /await setCreatorObjectCategories\(parentAddress, categories\)\.firstAttempt;/);
  assert.match(routes, /await upsertCreatorObject\(parentAddress, updated\)\.firstAttempt;/);
  assert.match(src("../src/lib/object/issuance.ts"), /await upsertCreatorObject\(creatorAddress, entry\)\.firstAttempt;/);
  assert.match(src("../src/lib/event/service.ts"), /void upsertCreatorObject\(updated\.creatorAddress, \{[\s\S]*?\}\)\.written\.catch\(/);
});

test("growing onto page 1: a failed page-1 write leaves page 0 as it was; the retry writes page 1 BEFORE page 0", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const creator = newCreator();
  const big = () => object({ name: "N".repeat(700) }); // ~900 bytes: four fill page 0
  const four = [big(), big(), big(), big()];
  await Promise.all(four.map((o) => directory.upsertCreatorObject(creator, o).written));
  assert.equal(writes(creator).length, 1);
  assert.equal(writes(creator)[0]!.pages, 0, "one page before the fifth");
  const page1 = dirTopicHex(creator, 1);
  bee.uploadFails(OWNER, page1, true);
  onSleep = () => {
    assert.equal(writes(creator).length, 1, "page 0 untouched");
    bee.uploadFails(OWNER, page1, false);
    bee.posted.length = 0;
  };
  await directory.upsertCreatorObject(creator, big()).written;
  assert.deepEqual(sleeps, [70_000]);
  assert.deepEqual(bee.posted, [socAddress(OWNER, page1, 0n), socAddress(OWNER, dirTopicHex(creator), 1n)], "page 1, then page 0");
  assert.equal(writes(creator).at(-1)!.pages, 1);
  assert.equal((await directory.getCreatorObjects(creator)).length, 5);
});

test("a page 0 claiming a MISSING overflow page is never rewritten from what was read", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const creator = newCreator();
  await feeds.writeFeedPage(
    Topic.fromString(objectCreatorDirectoryTopic(creator)),
    feeds.encodeJsonFeed({ v: 1, owner: creator, objects: [object()], categories: [], updatedAt: new Date().toISOString(), pages: 1 }),
  );
  await assert.rejects(directory.upsertCreatorObject(creator, object()).written, /overflow page 1 of 1 missing/);
  assert.equal(writes(creator).length, 1);
});

test("overflow pages stamped by another write than page 0 (a torn write) are never rewritten from", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const creator = newCreator();
  const env = (updatedAt: string, pages?: number) => ({ v: 1, owner: creator, objects: [object()], categories: [], updatedAt, ...(pages ? { pages } : {}) });
  await feeds.writeFeedPage(Topic.fromString(objectCreatorDirectoryTopic(creator, 1)), feeds.encodeJsonFeed(env("2026-10-21T00:00:02.000Z")));
  await feeds.writeFeedPage(Topic.fromString(objectCreatorDirectoryTopic(creator)), feeds.encodeJsonFeed(env("2026-10-21T00:00:01.000Z", 1)));
  await assert.rejects(directory.upsertCreatorObject(creator, object()).written, /torn/);
  assert.equal(writes(creator).length, 1);
});
