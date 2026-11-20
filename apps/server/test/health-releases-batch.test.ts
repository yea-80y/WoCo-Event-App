/**
 * /api/health `postage.releases`: the batches site runtime releases are stored on
 * (`RELEASE_BATCH_ID`, one or several), read from our own bee's chain-wide batch
 * store. The server never writes to them, so nothing else would notice one lapsing -
 * and pages built on its releases would go blank with every other section green.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { alarmGate } from "../src/lib/health/alarm-gate.js";

// `config/swarm.ts` captures POSTAGE_BATCH_ID at module load.
const CORE = "7dad2b8c0f1a" + "b".repeat(52);
const RELEASES = "0badc0de" + "a".repeat(56);
const OLDER = "01dba7c4" + "d".repeat(56);
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
const unreachable = () => Object.assign(new Error("x"), { status: 503 });
const silent = () => {};

type Answer = () => Promise<Record<string, unknown>>;
interface Over {
  releases?: Answer;
  older?: Answer;
  core?: Answer;
  chainstate?: Answer;
}

function readers(o: Over = {}) {
  const asked: string[] = [];
  const r = {
    deposit: async () => 0n,
    chainstate: o.chainstate ?? (async () => ({ block: 41_000_000 - 9, chainTip: 41_000_000 })),
    ethernaStamp: async () => { throw new Error("Etherna is never asked about a releases batch"); },
    beeStamp: async () => ({ ...CORE_STAMP }),
    beeBatch: async (id: string) => {
      asked.push(id);
      if (id === RELEASES) return o.releases ? o.releases() : { batchID: RELEASES, depth: 19, batchTTL: 5 * DAY };
      if (id === OLDER) return o.older ? o.older() : { batchID: OLDER, depth: 19, batchTTL: 9 * DAY };
      if (id === CORE) return o.core ? o.core() : { batchID: CORE, depth: 19, batchTTL: 14 * DAY };
      throw unreachable();
    },
    appIndexHtml: async () => null,
  };
  return { readers: r as unknown as Parameters<typeof probes.refreshPostage>[0], asked };
}

/** One pass with `RELEASE_BATCH_ID` set to `id` (null = unset). */
async function releases(o: Over = {}, id: string | null = RELEASES) {
  if (id === null) delete process.env.RELEASE_BATCH_ID;
  else process.env.RELEASE_BATCH_ID = id;
  const { readers: r, asked } = readers(o);
  await probes.refreshPostage(r, silent, false);
  const section = probes.postageHealth();
  return { section, asked, first: section.releases.batches[0] };
}
/** A further pass, the configuration left as it is. */
async function next(o: Over) {
  const { readers: r } = readers(o);
  await probes.refreshPostage(r, silent, false);
  const section = probes.postageHealth();
  return { section, first: section.releases.batches[0] };
}

beforeEach(() => probes.__resetHealthProbes());
after(() => {
  probes.__resetHealthProbes();
  delete process.env.RELEASE_BATCH_ID;
});

test("the configured batch is read from our bee's batch store, and over two days it is green", async () => {
  const { section, asked, first } = await releases();
  assert.ok(asked.includes(RELEASES));
  assert.equal(section.releases.ok, true);
  assert.equal(section.releases.configured, true);
  assert.equal(section.releases.minTtlSeconds, 2 * DAY);
  assert.equal(section.releases.batches.length, 1);
  assert.equal(first?.ok, true);
  assert.equal(first?.batch, "0badc0deaaaa…");
  assert.equal(first?.batchTTL, 5 * DAY);
  assert.equal(first?.batchTTLDays, 5);
  assert.equal(section.releases.reason, undefined);
  assert.equal(section.ok, true);
});

test("the id is read whatever its case", async () => {
  const { section, asked } = await releases({}, RELEASES.toUpperCase());
  assert.ok(asked.includes(RELEASES));
  assert.equal(section.releases.ok, true);
});

test("under two days left: red, and the postage roll-up and the alarm gate go red with it", async () => {
  const { section, first } = await releases({ releases: async () => ({ batchTTL: 2 * DAY - 1 }) });
  assert.equal(section.releases.ok, false);
  assert.equal(first?.ok, false);
  assert.match(section.releases.reason ?? "", /releases batch 0badc0deaaaa… expires in 2 days - top it up/);
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

test("a 404 our bee cannot vouch for, with no earlier reading, is unknown: far behind the tip, or a store without our own batch", async () => {
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

test("a read that fails (not a 404), or an answer with no TTL, with no earlier reading, is unknown and left out of the roll-up", async () => {
  const failed = await releases({ releases: async () => { throw unreachable(); } });
  assert.equal(failed.section.releases.ok, null);
  assert.equal(failed.section.ok, true, "the core batch alone decides the roll-up");
  probes.__resetHealthProbes();
  const blank = await releases({ releases: async () => ({ depth: 19 }) });
  assert.equal(blank.section.releases.ok, null);
});

// A batch runs out by passing through the red zone. The read after it has gone is the
// one our bee can least vouch for, so the alarm must not clear on it.
const low = { releases: async () => ({ batchTTL: DAY / 2 }) };

test("red, then a read that fails: still red, and the alarm gate still pages", async () => {
  assert.equal((await releases(low)).section.releases.ok, false);
  const { section, first } = await next({ releases: async () => { throw unreachable(); } });
  assert.equal(section.releases.ok, false);
  assert.match(section.releases.reason ?? "", /0badc0deaaaa… had 0\.5 days left when our bee last read it - top it up/);
  assert.equal(first?.batchTTL, null, "no TTL is shown that was not read this pass");
  assert.equal(alarmGate({ postage: section }, "postage.releases").status, 503);
});

test("red, then a 404 our bee cannot vouch for (the batch has just run out, our bee is behind): still red", async () => {
  await releases(low);
  const behind = await next({
    releases: async () => { throw notFound(); },
    chainstate: async () => ({ block: 41_000_000 - 40, chainTip: 41_000_000 }),
  });
  assert.equal(behind.section.releases.ok, false);
  assert.match(behind.section.releases.reason ?? "", /cannot say .* had 0\.5 days left/);
  const blank = await next({ releases: async () => ({ depth: 19 }) });
  assert.equal(blank.section.releases.ok, false);
});

test("red, then gone with our bee able to vouch for it: red, and the reason is that it expired", async () => {
  await releases(low);
  const { section } = await next({ releases: async () => { throw notFound(); } });
  assert.equal(section.releases.ok, false);
  assert.equal(section.releases.reason, "not on chain: the releases batch has expired");
});

test("a batch last read at exactly two days, then a read that fails, is unknown: only a red reading is kept", async () => {
  await releases({ releases: async () => ({ batchTTL: 2 * DAY }) });
  assert.equal((await next({ releases: async () => { throw unreachable(); } })).section.releases.ok, null);
  probes.__resetHealthProbes();
  await releases({ releases: async () => ({ batchTTL: 2 * DAY - 1 }) });
  assert.equal((await next({ releases: async () => { throw unreachable(); } })).section.releases.ok, false);
});

test("red, then topped up and read: green again, and a later failed read is unknown, not red", async () => {
  await releases(low);
  assert.equal((await next({ releases: async () => ({ batchTTL: 9 * DAY }) })).section.releases.ok, true);
  assert.equal((await next({ releases: async () => { throw unreachable(); } })).section.releases.ok, null);
});

test("a low reading for one batch does not turn another batch red", async () => {
  await releases(low);
  const { section } = await releases({ older: async () => { throw unreachable(); } }, OLDER);
  assert.equal(section.releases.ok, null);
  assert.equal(section.releases.batches.length, 1);
  assert.equal(section.releases.batches[0]?.batch, "01dba7c4dddd…");
});

// A replaced batch stays on the list while published pages still load their code from it.
test("several batches are each read and reported, in the order configured", async () => {
  const { section, asked } = await releases({}, ` ${RELEASES} , ${OLDER.toUpperCase()} `);
  assert.ok(asked.includes(RELEASES) && asked.includes(OLDER));
  assert.equal(section.releases.ok, true);
  assert.deepEqual(section.releases.batches.map((b) => [b.batch, b.batchTTLDays, b.ok]), [["0badc0deaaaa…", 5, true], ["01dba7c4dddd…", 9, true]]);
});

test("one of several batches under two days: the section is red and names that batch", async () => {
  const { section } = await releases({ older: async () => ({ batchTTL: DAY }) }, `${RELEASES},${OLDER}`);
  assert.equal(section.releases.ok, false);
  assert.deepEqual(section.releases.batches.map((b) => b.ok), [true, false]);
  assert.match(section.releases.reason ?? "", /^releases batch 01dba7c4dddd… expires in 1 days/);
  assert.equal(alarmGate({ postage: section }, "postage.releases").status, 503);
});

test("one of several batches unreadable and none red: unknown; one red wins over one unreadable", async () => {
  const unknown = await releases({ older: async () => { throw unreachable(); } }, `${RELEASES},${OLDER}`);
  assert.equal(unknown.section.releases.ok, null);
  probes.__resetHealthProbes();
  const red = await releases({ releases: async () => ({ batchTTL: DAY }), older: async () => { throw unreachable(); } }, `${RELEASES},${OLDER}`);
  assert.equal(red.section.releases.ok, false);
  assert.match(red.section.releases.reason ?? "", /^releases batch 0badc0deaaaa… expires/);
});

test("a batch named twice is read and reported once", async () => {
  const { section } = await releases({}, `${RELEASES},${RELEASES.toUpperCase()}`);
  assert.equal(section.releases.batches.length, 1);
});

test("not configured: unknown, not asked, not in the roll-up", async () => {
  const { section, asked } = await releases({}, null);
  assert.equal(section.releases.configured, false);
  assert.equal(section.releases.ok, null);
  assert.deepEqual(section.releases.batches, []);
  assert.ok(!asked.includes(RELEASES));
  assert.equal(section.ok, true);
});

test("a value that is not a batch id is red, alone or in a list: a typo must not pass for an alarm", async () => {
  for (const value of ["0badc0de", `${RELEASES},0badc0de`, `${RELEASES},`, `${RELEASES} ${OLDER}`]) {
    probes.__resetHealthProbes();
    const { section, asked } = await releases({}, value);
    assert.equal(section.releases.ok, false, value);
    assert.match(section.releases.reason ?? "", /not a batch id/);
    assert.ok(!asked.includes(RELEASES), "nothing is read for a list that does not parse");
  }
});

test("a reading for a batch no longer configured is not shown for the new one", async () => {
  await releases();
  process.env.RELEASE_BATCH_ID = "f".repeat(64);
  const section = probes.postageHealth();
  assert.equal(section.releases.batches[0]?.batchTTL, null);
  assert.equal(section.releases.ok, null);
});
