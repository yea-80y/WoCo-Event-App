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

test("GET /runtime is registered before /:id, or 'runtime' would read as a site id", () => {
  const src = readFileSync(new URL("../src/routes/sites.ts", import.meta.url), "utf8");
  const runtime = src.indexOf('sitesRouter.get("/runtime"');
  const byId = src.indexOf('sitesRouter.get("/:id"');
  assert.ok(runtime > 0 && byId > 0 && runtime < byId);
});
