/**
 * #1032 — the server's view of the latest site runtime release: discovery only,
 * never moved backwards by a lagging replica, never replaced by a bad read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SITE_RUNTIME_FORMAT, SITE_RUNTIME_RELEASE_OWNER, SITE_RUNTIME_FEED_TOPIC } from "@woco/shared";
import { createSiteRuntimeReleaseCache, beeRuntimeFeedRead, type RuntimeFeedRead } from "../src/lib/site/runtime-release.js";

const H = (c: string) => c.repeat(64);
const release = (version: number) => ({
  format: SITE_RUNTIME_FORMAT,
  version,
  commit: "b".repeat(40),
  builtAt: "2026-11-02T15:00:00.000Z",
  dist: { files: 251, bytes: 8_900_000 },
  roots: { woco: { root: H("1"), indexDocument: "multi-site.html", edges: { "assets/": H("2") }, files: {} } },
});
const ok = (v: unknown): RuntimeFeedRead => ({ status: "ok", payload: new TextEncoder().encode(JSON.stringify(v)) });

function scripted(reads: RuntimeFeedRead[]) {
  let i = 0, clock = 0, calls = 0;
  const cache = createSiteRuntimeReleaseCache(async () => { calls++; return reads[Math.min(i++, reads.length - 1)]!; }, () => clock);
  return { cache, tick: (ms: number) => { clock += ms; }, calls: () => calls };
}

test("nothing published yet: no release, and that is not an error", async () => {
  const { cache } = scripted([{ status: "absent" }]);
  assert.equal(await cache.get(0), null);
  const h = cache.health();
  assert.equal(h.configured, false);
  assert.equal(h.lastError, null);
  assert.equal(h.ok, true);
});

test("a valid descriptor is held and reported", async () => {
  const { cache } = scripted([ok(release(3))]);
  assert.equal((await cache.get(0))?.version, 3);
  assert.deepEqual([cache.health().configured, cache.health().version], [true, 3]);
});

test("a malformed or failed read keeps the release held, and says so", async () => {
  const { cache } = scripted([ok(release(3)), ok({ ...release(4), commit: "nope" }), { status: "error", error: new Error("502") }, { status: "absent" }]);
  await cache.get(0);
  for (const expect of [/malformed/, /^read failed$/, /absent, keeping/]) {
    assert.equal((await cache.get(0))?.version, 3);
    assert.match(cache.health().lastError ?? "", expect);
  }
});

test("health is public: a read failure reports a fixed reason, never the error text", async () => {
  const secretish = new Error("connect ECONNREFUSED http://bee-node:1633/feeds/abc");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { cache } = scripted([{ status: "error", error: secretish }]);
    await cache.get(0);
    assert.equal(cache.health().lastError, "read failed");
    assert.ok(!JSON.stringify(cache.health()).includes("bee-node"));
  } finally {
    console.warn = warn;
  }
});

test("peek answers from memory without reading", async () => {
  const { cache, calls } = scripted([ok(release(2))]);
  assert.equal(cache.peek(), null);
  assert.equal(calls(), 0);
  await cache.get(0);
  assert.equal(cache.peek()?.version, 2);
  assert.equal(calls(), 1);
});

test("a lower version is a lagging replica, never a rollback; a higher one replaces", async () => {
  const { cache } = scripted([ok(release(5)), ok(release(4)), ok(release(6))]);
  await cache.get(0);
  assert.equal((await cache.get(0))?.version, 5);
  assert.match(cache.health().lastError ?? "", /lagging replica/);
  assert.equal((await cache.get(0))?.version, 6);
  assert.equal(cache.health().lastError, null);
});

test("answers from memory inside the max age, and concurrent callers share one read", async () => {
  const { cache, tick, calls } = scripted([ok(release(1)), ok(release(2))]);
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls(), 1);
  tick(60_000);
  assert.equal((await cache.get())?.version, 1, "inside 10 min: no read");
  assert.equal(calls(), 1);
  tick(10 * 60_000);
  assert.equal((await cache.get())?.version, 2);
  assert.equal(calls(), 2);
});

test("the live read asks bee for the deploy key's feed, and maps only bee's 'no update found' to absent", async () => {
  let asked: unknown[] = [];
  const beeThat = (fail: unknown) => () => ({
    makeFeedReader: (topic: { toHex(): string }, owner: string) => {
      asked = [topic.toHex(), owner];
      return { downloadPayload: async () => { throw fail; } };
    },
  }) as never;
  assert.deepEqual(await beeRuntimeFeedRead(beeThat({ status: 404, responseBody: { message: "no update found" } }))(), { status: "absent" });
  const { Topic } = await import("@ethersphere/bee-js");
  assert.deepEqual(asked, [Topic.fromString(SITE_RUNTIME_FEED_TOPIC).toHex(), SITE_RUNTIME_RELEASE_OWNER.slice(2)]);
  assert.equal((await beeRuntimeFeedRead(beeThat({ status: 404, responseBody: { message: "lookup at failed" } }))()).status, "error");
  assert.equal((await beeRuntimeFeedRead(beeThat(new Error("ECONNREFUSED")))()).status, "error");
});

test("GET /runtime and /runtime/kit are registered before /:id, or 'runtime' would read as a site id", () => {
  const src = readFileSync(new URL("../src/routes/sites.ts", import.meta.url), "utf8");
  const runtime = src.indexOf('sitesRouter.get("/runtime"');
  const kit = src.indexOf('sitesRouter.get("/runtime/kit/:store"');
  const byId = src.indexOf('sitesRouter.get("/:id"');
  assert.ok(runtime > 0 && kit > 0 && byId > 0 && runtime < byId && kit < byId);
});

// --- Slice 3: the release gates publishing, so it is verified and never goes back ---

function marked(reads: RuntimeFeedRead[], mark: number | null | "unreadable", saveOk = true) {
  const saved: number[] = [];
  let i = 0, calls = 0;
  const hw = { load: () => (saved.length ? saved.at(-1)! : mark), save: (v: number) => (saved.push(v), saveOk) };
  const cache = createSiteRuntimeReleaseCache(async () => { calls++; return reads[Math.min(i++, reads.length - 1)]!; }, () => 0, hw);
  return { cache, saved, calls: () => calls };
}

test("a restart is not handed an older release: below the high-water mark is ignored", async () => {
  const { cache, saved } = marked([ok(release(4)), ok(release(5)), ok(release(6))], 5);
  assert.equal(await cache.get(0), null);
  assert.match(cache.health().lastError ?? "", /below the high-water mark 5/);
  assert.equal((await cache.get(0))?.version, 5);
  assert.deepEqual(saved, [], "the mark already says 5");
  assert.equal((await cache.get(0))?.version, 6);
  assert.deepEqual(saved, [6]);
});

test("a mark that cannot be recorded means the release is not accepted", async () => {
  const { cache } = marked([ok(release(2))], null, false);
  assert.equal(await cache.get(0), null);
  assert.match(cache.health().lastError ?? "", /could not record/);
});

test("an unreadable high-water file accepts nothing, never reads, and turns health red", async () => {
  const err = console.error;
  console.error = () => {};
  try {
    const { cache, calls } = marked([ok(release(9))], "unreadable");
    assert.equal(await cache.get(0), null);
    assert.equal(calls(), 0);
    assert.deepEqual([cache.health().ok, cache.health().lastError], [false, "high-water file unreadable"]);
  } finally {
    console.error = err;
  }
});

test("the high-water file: absent is none, damage is unreadable, a save reads back", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileHighWater } = await import("../src/lib/site/runtime-release.js");
  const dir = mkdtempSync(join(tmpdir(), "woco-hw-"));
  try {
    const file = join(dir, "hw.json");
    const hw = fileHighWater(file);
    assert.equal(hw.load(), null);
    assert.equal(hw.save(3), true);
    assert.equal(hw.load(), 3);
    for (const bad of ["{", '{"version":0}', '{"version":"3"}', '{"version":1.5}', "[]"]) {
      writeFileSync(file, bad);
      assert.equal(hw.load(), "unreadable", bad);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live read accepts only an update whose signature verifies, with the payload bee returned", async () => {
  const { FeedIndex } = await import("@ethersphere/bee-js");
  const payload = new TextEncoder().encode(JSON.stringify(release(2)));
  const beeAt = (index: number) => () => ({
    makeFeedReader: () => ({ downloadPayload: async () => ({ payload: { toUint8Array: () => payload }, feedIndex: FeedIndex.fromBigInt(BigInt(index)) }) }),
  }) as never;
  let askedIndex = -1;
  const found = (p: Uint8Array) => async (i: number) => { askedIndex = i; return { status: "found" as const, soc: { payload: p } as never }; };

  assert.deepEqual(await beeRuntimeFeedRead(beeAt(7), found(payload))(), { status: "ok", payload });
  assert.equal(askedIndex, 7, "the update at the index bee found");
  const other = payload.slice();
  other[0] ^= 1;
  assert.match((await beeRuntimeFeedRead(beeAt(7), found(other))() as { error: Error }).error.message, /differs/);
  assert.match((await beeRuntimeFeedRead(beeAt(7), async () => ({ status: "absent" }))() as { error: Error }).error.message, /did not verify/);
  assert.match((await beeRuntimeFeedRead(beeAt(7), async () => ({ status: "unavailable", reason: "signature does not recover to owner" }))() as { error: Error }).error.message, /does not recover/);
  assert.equal((await beeRuntimeFeedRead(beeAt(7), async () => { throw new Error("boom"); })()).status, "error");
});

test("verifyReleaseUpdate asks for the deploy key's SOC at the feed identifier bee-js writes", async () => {
  const { beeFeedUpdateIdentifier } = await import("@woco/shared");
  const { Topic, FeedIndex } = await import("@ethersphere/bee-js");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { bytesToHex, concatBytes } = await import("@noble/hashes/utils.js");
  // bee-js feed update identifier: keccak256(topic || index as 8-byte big-endian).
  const expected = keccak_256(concatBytes(Topic.fromString(SITE_RUNTIME_FEED_TOPIC).toUint8Array(), FeedIndex.fromBigInt(3n).toUint8Array()));
  assert.equal(bytesToHex(beeFeedUpdateIdentifier(SITE_RUNTIME_FEED_TOPIC, 3)), bytesToHex(expected));
});
