/**
 * /api/health `postage.releases`: the batch site runtime releases are stored on
 * (`RELEASE_BATCH_ID`), read from our own bee's chain-wide batch store. The
 * server never writes to that batch, so nothing else would notice it lapsing -
 * and pages built on its releases would go blank with every other section green.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { alarmGate } from "../src/lib/health/alarm-gate.js";

// `config/swarm.ts` captures POSTAGE_BATCH_ID at module load.
const CORE = "7dad2b8c0f1a" + "b".repeat(52);
const RELEASES = "0badc0de" + "a".repeat(56);
process.env.POSTAGE_BATCH_ID = CORE;
delete process.env.ETHERNA_PLATFORM_BATCH;
delete process.env.ETHERNA_API_KEY;
delete process.env.POSTAGE_TTL_MIN_SECONDS;
delete process.env.POSTAGE_UTILIZATION_MAX_PCT;
delete process.env.BEE_CHAIN_LAG_MAX_BLOCKS;

const probes = await import("../src/lib/health/probes.js");

const DAY = 86_400;
const CORE_STAMP = { depth: 19, bucketDepth: 16, utilization: 2, batchTTL: 14 * DAY, usable: true, immutableFlag: false };
const notFound = () => Object.assign(new Error("HTTP 404"), { status: 404 });
const silent = () => {};

interface Over {
  releases?: () => Promise<Record<string, unknown>>;
  core?: () => Promise<Record<string, unknown>>;
  chainstate?: () => Promise<Record<string, unknown>>;
}

function readers(o: Over = {}) {
  const asked: string[] = [];
  const r = {
    deposit: async () => 0n,
    chainstate: o.chainstate ?? (async () => ({ block: 41_000_000 - 9, chainTip: 41_000_000 })),
    ethernaStamp: async () => { throw new Error("Etherna is never asked about the releases batch"); },
    beeStamp: async () => ({ ...CORE_STAMP }),
    beeBatch: async (id: string) => {
      asked.push(id);
      if (id === RELEASES) return o.releases ? o.releases() : { batchID: RELEASES, depth: 19, batchTTL: 5 * DAY };
      return o.core ? o.core() : { batchID: CORE, depth: 19, batchTTL: 14 * DAY };
    },
    appIndexHtml: async () => null,
  };
  return { readers: r as unknown as Parameters<typeof probes.refreshPostage>[0], asked };
}

async function releases(o: Over = {}, id: string | null = RELEASES) {
  if (id === null) delete process.env.RELEASE_BATCH_ID;
  else process.env.RELEASE_BATCH_ID = id;
  const { readers: r, asked } = readers(o);
  await probes.refreshPostage(r, silent, false);
  return { section: probes.postageHealth(), asked };
}

beforeEach(() => probes.__resetHealthProbes());
after(() => {
  probes.__resetHealthProbes();
  delete process.env.RELEASE_BATCH_ID;
});

test("the configured batch is read from our bee's batch store, and over two days it is green", async () => {
  const { section, asked } = await releases();
  assert.ok(asked.includes(RELEASES));
  assert.equal(section.releases.ok, true);
  assert.equal(section.releases.configured, true);
  assert.equal(section.releases.batch, "0badc0deaaaa…");
  assert.equal(section.releases.batchTTLDays, 5);
  assert.equal(section.releases.minTtlSeconds, 2 * DAY);
  assert.equal(section.ok, true);
});

test("the id is read whatever its case", async () => {
  const { section, asked } = await releases({}, RELEASES.toUpperCase());
  assert.ok(asked.includes(RELEASES));
  assert.equal(section.releases.ok, true);
});

test("under two days left: red, and the postage roll-up and the alarm gate go red with it", async () => {
  const { section } = await releases({ releases: async () => ({ batchTTL: 2 * DAY - 1 }) });
  assert.equal(section.releases.ok, false);
  assert.match(section.releases.reason ?? "", /the releases batch expires in 2 days - top it up/);
  assert.equal(section.ok, false);
  assert.equal(alarmGate({ postage: section }, "postage.releases").status, 503);
});

test("exactly two days left is still green", async () => {
  const { section } = await releases({ releases: async () => ({ batchTTL: 2 * DAY }) });
  assert.equal(section.releases.ok, true);
});

test("gone from the chain, with our bee at the tip and holding our own batch: red", async () => {
  const { section } = await releases({ releases: async () => { throw notFound(); } });
  assert.equal(section.releases.ok, false);
  assert.match(section.releases.reason ?? "", /has expired/);
  assert.equal(section.ok, false);
});

test("a 404 our bee cannot vouch for is unknown, not red: far behind the tip, or a store without our own batch", async () => {
  const behind = await releases({
    releases: async () => { throw notFound(); },
    chainstate: async () => ({ block: 41_000_000 - 500, chainTip: 41_000_000 }),
  });
  assert.equal(behind.section.releases.ok, null);
  probes.__resetHealthProbes();
  const wiped = await releases({ releases: async () => { throw notFound(); }, core: async () => { throw notFound(); } });
  assert.equal(wiped.section.releases.ok, null);
  assert.match(wiped.section.releases.reason ?? "", /cannot say/);
});

test("a read that fails (not a 404), or an answer with no TTL, is unknown and left out of the roll-up", async () => {
  const failed = await releases({ releases: async () => { throw Object.assign(new Error("x"), { status: 503 }); } });
  assert.equal(failed.section.releases.ok, null);
  assert.equal(failed.section.ok, true, "the core batch alone decides the roll-up");
  probes.__resetHealthProbes();
  const blank = await releases({ releases: async () => ({ depth: 19 }) });
  assert.equal(blank.section.releases.ok, null);
});

// A batch runs out by passing through the red zone. The read after it has gone is the
// one our bee can least vouch for, so the alarm must not clear on it.
const low = { releases: async () => ({ batchTTL: DAY / 2 }) };
async function next(o: Over) {
  const { readers: r } = readers(o);
  await probes.refreshPostage(r, silent, false);
  return probes.postageHealth();
}

test("red, then a read that fails: still red, and the alarm gate still pages", async () => {
  assert.equal((await releases(low)).section.releases.ok, false);
  const section = await next({ releases: async () => { throw Object.assign(new Error("x"), { status: 503 }); } });
  assert.equal(section.releases.ok, false);
  assert.match(section.releases.reason ?? "", /had 0\.5 days left when our bee last read it - top it up/);
  assert.equal(section.releases.batchTTL, null, "no TTL is shown that was not read this pass");
  assert.equal(alarmGate({ postage: section }, "postage.releases").status, 503);
});

test("red, then a 404 our bee cannot vouch for (the batch has just run out, our bee is behind): still red", async () => {
  await releases(low);
  const behind = await next({
    releases: async () => { throw notFound(); },
    chainstate: async () => ({ block: 41_000_000 - 40, chainTip: 41_000_000 }),
  });
  assert.equal(behind.releases.ok, false);
  assert.match(behind.releases.reason ?? "", /cannot say .* had 0\.5 days left/);
  const blank = await next({ releases: async () => ({ depth: 19 }) });
  assert.equal(blank.releases.ok, false);
});

test("red, then topped up and read: green again, and a later failed read is unknown, not red", async () => {
  await releases(low);
  assert.equal((await next({ releases: async () => ({ batchTTL: 9 * DAY }) })).releases.ok, true);
  const failed = await next({ releases: async () => { throw Object.assign(new Error("x"), { status: 503 }); } });
  assert.equal(failed.releases.ok, null);
});

test("a low reading for one batch does not turn another batch red", async () => {
  await releases(low);
  const other = "f".repeat(64);
  process.env.RELEASE_BATCH_ID = other;
  const { readers: r } = readers();
  const reader = r as unknown as { beeBatch: (id: string) => Promise<Record<string, unknown>> };
  reader.beeBatch = async (id: string) => {
    if (id === other) throw Object.assign(new Error("x"), { status: 503 });
    return { batchID: CORE, depth: 19, batchTTL: 14 * DAY };
  };
  await probes.refreshPostage(r, silent, false);
  assert.equal(probes.postageHealth().releases.ok, null);
});

test("not configured: unknown, not asked, not in the roll-up", async () => {
  const { section, asked } = await releases({}, null);
  assert.equal(section.releases.configured, false);
  assert.equal(section.releases.ok, null);
  assert.ok(!asked.includes(RELEASES));
  assert.equal(section.ok, true);
});

test("a value that is not a batch id is red: a typo must not pass for an alarm", async () => {
  const { section } = await releases({}, "0badc0de");
  assert.equal(section.releases.ok, false);
  assert.match(section.releases.reason ?? "", /not a batch id/);
});

test("a reading for a batch no longer configured is not shown for the new one", async () => {
  await releases();
  process.env.RELEASE_BATCH_ID = "f".repeat(64);
  const section = probes.postageHealth();
  assert.equal(section.releases.batchTTL, null);
  assert.equal(section.releases.ok, null);
});
