/**
 * /api/health `postage.builds`: the builds batch the LIVE app is stamped on,
 * read from the `woco-build-batch` meta the deploy writes into index.html. When
 * that batch dies the app's files go with it, and nothing else watches it.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alarmGate } from "../src/lib/health/alarm-gate.js";

// `config/swarm.ts` captures POSTAGE_BATCH_ID at module load.
const CORE = "7dad2b8c0f1a" + "b".repeat(52);
process.env.POSTAGE_BATCH_ID = CORE;
delete process.env.ETHERNA_PLATFORM_BATCH;
delete process.env.ETHERNA_API_KEY;
delete process.env.POSTAGE_TTL_MIN_SECONDS;
delete process.env.POSTAGE_UTILIZATION_MAX_PCT;
delete process.env.BEE_CHAIN_LAG_MAX_BLOCKS;

const probes = await import("../src/lib/health/probes.js");

const BUILDS = "d2721376" + "c".repeat(56);
const DAY = 86_400;
const CORE_STAMP = { depth: 19, bucketDepth: 16, utilization: 2, batchTTL: 14 * DAY, usable: true, immutableFlag: false };
const CHAINSTATE = { block: 41_000_000 - 9, chainTip: 41_000_000 };
const page = (batch = BUILDS) =>
  `<!doctype html><html><head>\n    <base href="https://gateway.woco-net.com/bzz/${"e".repeat(64)}/">\n    <meta name="woco-feed" content="v1 f8af ${"1".repeat(64)} 18">\n    <meta name="woco-build-batch" content="${batch}">\n<title>WoCo</title></head></html>`;
const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });
const silent = () => {};

interface Over {
  html?: () => Promise<string | null>;
  buildsStamp?: () => Promise<Record<string, unknown>>;
}

function readers(o: Over = {}) {
  const asked: string[] = [];
  const r = {
    deposit: async () => 0n,
    chainstate: async () => ({ ...CHAINSTATE }),
    ethernaStamp: async () => ({ ...CORE_STAMP }),
    beeStamp: async (id: string) => {
      asked.push(id);
      if (id === BUILDS && o.buildsStamp) return o.buildsStamp();
      return id === BUILDS ? { ...CORE_STAMP, batchTTL: 3 * DAY } : { ...CORE_STAMP };
    },
    appIndexHtml: o.html ?? (async () => page()),
  };
  return { readers: r as unknown as Parameters<typeof probes.refreshPostage>[0], asked };
}

async function builds(o: Over = {}) {
  const { readers: r, asked } = readers(o);
  await probes.refreshPostage(r, silent, false);
  return { section: probes.postageHealth(), asked };
}

beforeEach(() => probes.__resetHealthProbes());
after(() => probes.__resetHealthProbes());

test("the meta parser: the deploy's tag, any case; nothing else", () => {
  assert.equal(probes.buildBatchFromIndexHtml(page()), BUILDS);
  assert.equal(probes.buildBatchFromIndexHtml(page(BUILDS.toUpperCase())), BUILDS);
  assert.equal(probes.buildBatchFromIndexHtml("<head><title>x</title></head>"), null);
  assert.equal(probes.buildBatchFromIndexHtml(page("abc")), null, "not a batch id");
});

test("the batch the live app names is the one read, and over two days it is green", async () => {
  const { section, asked } = await builds();
  assert.ok(asked.includes(BUILDS));
  assert.equal(section.builds.ok, true);
  assert.equal(section.builds.batchTTLDays, 3);
  assert.equal(section.builds.minTtlSeconds, 2 * DAY);
  assert.equal(section.ok, true);
});

test("under two days left: red, and the postage roll-up and the alarm gate go red with it", async () => {
  const { section } = await builds({ buildsStamp: async () => ({ ...CORE_STAMP, batchTTL: 2 * DAY - 1 }) });
  assert.equal(section.builds.ok, false);
  assert.match(section.builds.reason ?? "", /expires in 2 days - deploy on a new builds batch/);
  assert.equal(section.ok, false);
  const gate = alarmGate({ postage: section }, "postage.builds");
  assert.equal(gate.status, 503);
});

test("exactly two days left is still green", async () => {
  const { section } = await builds({ buildsStamp: async () => ({ ...CORE_STAMP, batchTTL: 2 * DAY }) });
  assert.equal(section.builds.ok, true);
});

test("the batch gone from the bee (expired) is red, never unknown", async () => {
  const { section } = await builds({ buildsStamp: async () => { throw notFound(); } });
  assert.equal(section.builds.ok, false);
  assert.equal(section.ok, false);
});

test("a batch that is not usable is red", async () => {
  const { section } = await builds({ buildsStamp: async () => ({ ...CORE_STAMP, batchTTL: 10 * DAY, usable: false }) });
  assert.equal(section.builds.ok, false);
});

test("unknown, and left out of the roll-up: no app configured, a page naming no batch, a failed read", async () => {
  for (const [what, html] of [
    ["no app configured", async () => null],
    ["deployed before this check", async () => "<html><head></head></html>"],
    ["page unreadable", async () => { throw new Error("timeout"); }],
  ] as const) {
    probes.__resetHealthProbes();
    const { section } = await builds({ html });
    assert.equal(section.builds.ok, null, what);
    assert.equal(section.ok, true, `${what}: the core batch alone decides the roll-up`);
  }
});

test("a stamp read that fails (not a 404) is unknown, not red", async () => {
  const { section } = await builds({ buildsStamp: async () => { throw Object.assign(new Error("x"), { status: 503 }); } });
  assert.equal(section.builds.ok, null);
});

test("the deploy writes the batch it used into the app's index.html", () => {
  const src = readFileSync(new URL("../../../scripts/upload-to-swarm-feed.cjs", import.meta.url), "utf8");
  assert.ok(src.includes('`<meta name="woco-build-batch" content="${BUILD_BATCH_ID.toLowerCase()}">`'));
  assert.match(src, /\$\{feedMeta\}\\n {4}\$\{batchMeta\}/, "injected beside the feed meta, in the patched <head>");
});
