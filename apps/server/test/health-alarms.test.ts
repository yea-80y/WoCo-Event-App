/**
 * The postage + paymaster alarms on `/api/health` (#421, #522).
 *
 * WHAT THESE TESTS ARE FOR. Both failure modes are silent: a dead postage batch
 * still returns 200 on every upload, and an empty paymaster deposit fails ops
 * the server never sees. The only thing standing between those and another
 * found-by-hand incident is the arithmetic below, so each rule is pinned
 * individually — a mutation to any one of them has to turn a test red, not just
 * shift a number in a JSON blob nobody asserts on.
 *
 * The bee numbers marked LIVE are what the production node actually reported on
 * 2026-09-11, including the case a percentage threshold cannot express: 7 of 8
 * bucket slots used is 87.5%, sails under a 90% ceiling, and the next chunk into
 * that bucket overwrites an older one.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PAYMASTER_MIN_ETH,
  DEFAULT_TTL_MIN_SECONDS,
  DEFAULT_UTILIZATION_MAX_PCT,
  DEFAULT_CHAIN_LAG_MAX_BLOCKS,
  bucketCapacity,
  combine,
  evaluateChainLag,
  evaluatePaymaster,
  evaluateStamp,
  isStale,
  readThresholdsFromEnv,
} from "../src/lib/health/alarms.js";

// `config/swarm.ts` captures POSTAGE_BATCH_ID at module load, so the batch has
// to exist in env before the probe module is imported at all.
const BATCH = "7dad2b8c0f1a" + "b".repeat(52);
process.env.POSTAGE_BATCH_ID = BATCH;
delete process.env.ETHERNA_PLATFORM_BATCH;
delete process.env.ETHERNA_API_KEY;
delete process.env.PAYMASTER_DEPOSIT_MIN_ETH;
delete process.env.POSTAGE_TTL_MIN_SECONDS;
delete process.env.POSTAGE_UTILIZATION_MAX_PCT;
delete process.env.BEE_CHAIN_LAG_MAX_BLOCKS;

const probes = await import("../src/lib/health/probes.js");

const THRESHOLDS = {
  ttlMinSeconds: DEFAULT_TTL_MIN_SECONDS,
  utilizationMaxPct: DEFAULT_UTILIZATION_MAX_PCT,
  chainLagMaxBlocks: DEFAULT_CHAIN_LAG_MAX_BLOCKS,
};

/** LIVE, production bee, 2026-09-11. batchTTL is 16.2 days in seconds. */
const LIVE_STAMP = {
  depth: 19,
  bucketDepth: 16,
  utilization: 7,
  batchTTL: 1_399_680,
  usable: true,
  immutableFlag: false,
};
const LIVE_CHAINSTATE = { block: 41_000_000 - 9, chainTip: 41_000_000 };

const ETH = 10n ** 18n;

function readers(over: Partial<Record<keyof typeof base, unknown>> = {}) {
  const base = {
    deposit: async () => (2n * ETH) / 1000n, // 0.002 ETH
    beeStamp: async () => ({ ...LIVE_STAMP }),
    chainstate: async () => ({ ...LIVE_CHAINSTATE }),
    ethernaStamp: async () => ({ ...LIVE_STAMP }),
  };
  return { ...base, ...over } as Parameters<typeof probes.refreshPostage>[0];
}

const silent = () => {};

beforeEach(() => {
  probes.__resetHealthProbes();
  delete process.env.PAYMASTER_DEPOSIT_MIN_ETH;
  delete process.env.POSTAGE_TTL_MIN_SECONDS;
  delete process.env.POSTAGE_UTILIZATION_MAX_PCT;
  delete process.env.BEE_CHAIN_LAG_MAX_BLOCKS;
  delete process.env.ETHERNA_PLATFORM_BATCH;
  delete process.env.ETHERNA_API_KEY;
});

after(() => probes.__resetHealthProbes());

// ---------------------------------------------------------------------------
// The live case a percentage cannot express
// ---------------------------------------------------------------------------

test("LIVE production values: 7 of 8 bucket slots is an alarm, TTL and chain lag are not", () => {
  const v = evaluateStamp(LIVE_STAMP, THRESHOLDS);

  assert.equal(v.bucketCap, 8, "2^(19-16) — per bucket, not the whole batch");
  assert.equal(
    v.utilization.ok,
    false,
    "7/8 is 87.5% and passes a 90% ceiling, but the next chunk overwrites an older one",
  );
  assert.match(v.utilization.reason ?? "", /7\/8/);
  assert.equal(v.ttl.ok, true, "16.2 days is over the 7-day floor");
  assert.equal(v.usable.ok, true);
  assert.equal(v.ok, false, "one false sub-check makes the batch section false");

  const lag = evaluateChainLag(LIVE_CHAINSTATE, DEFAULT_CHAIN_LAG_MAX_BLOCKS);
  assert.equal(lag.ok, true);
  assert.equal(lag.lag, 9);
});

test("bucket capacity is per bucket", () => {
  assert.equal(bucketCapacity(19, 16), 8);
  assert.equal(bucketCapacity(24, 16), 256);
});

test("the percentage rule catches a large bucket the absolute rule would not", () => {
  // cap 256, one slot left is 255 — but 90% of 256 is 231, so 240 must already alarm.
  const v = evaluateStamp({ ...LIVE_STAMP, depth: 24, utilization: 240 }, THRESHOLDS);
  assert.equal(v.bucketCap, 256);
  assert.equal(v.utilization.ok, false);
  assert.equal(evaluateStamp({ ...LIVE_STAMP, depth: 24, utilization: 100 }, THRESHOLDS).utilization.ok, true);
});

test("TTL below the floor, and an expired batch, both alarm", () => {
  assert.equal(evaluateStamp({ ...LIVE_STAMP, utilization: 1, batchTTL: 4_300 }, THRESHOLDS).ttl.ok, false);
  assert.equal(evaluateStamp({ ...LIVE_STAMP, utilization: 1, batchTTL: 0 }, THRESHOLDS).ttl.ok, false);
  assert.equal(evaluateStamp({ ...LIVE_STAMP, utilization: 1 }, THRESHOLDS).ttl.ok, true);
});

test("a batch bee calls unusable is an alarm on its own", () => {
  const v = evaluateStamp({ ...LIVE_STAMP, utilization: 1, usable: false }, THRESHOLDS);
  assert.equal(v.usable.ok, false);
  assert.equal(v.ok, false);
});

// ---------------------------------------------------------------------------
// Chain lag
// ---------------------------------------------------------------------------

test("a bee behind the postage contract is an alarm, and an unreadable chainstate is unknown", () => {
  assert.equal(evaluateChainLag({ block: 100, chainTip: 1_000 }, DEFAULT_CHAIN_LAG_MAX_BLOCKS).ok, false);
  assert.equal(evaluateChainLag({ block: 999, chainTip: 1_000 }, DEFAULT_CHAIN_LAG_MAX_BLOCKS).ok, true);
  const unread = evaluateChainLag({ block: null, chainTip: null }, DEFAULT_CHAIN_LAG_MAX_BLOCKS);
  assert.equal(unread.ok, null);
  assert.equal(unread.lag, null);
});

// ---------------------------------------------------------------------------
// Paymaster
// ---------------------------------------------------------------------------

test("paymaster deposit below the minimum alarms; above it does not; unreadable is unknown", () => {
  const minWei = ETH / 2000n; // 0.0005
  assert.equal(evaluatePaymaster({ depositWei: minWei - 1n, minWei }).ok, false);
  assert.equal(evaluatePaymaster({ depositWei: minWei, minWei }).ok, true);
  const unread = evaluatePaymaster({ depositWei: null, minWei, reason: "RPC down" });
  assert.equal(unread.ok, null, "an RPC that could not answer is not evidence of a funded paymaster");
  assert.equal(unread.reason, "RPC down");
});

// ---------------------------------------------------------------------------
// Thresholds from env
// ---------------------------------------------------------------------------

test("defaults are used when nothing is set", () => {
  const cfg = readThresholdsFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(cfg.paymaster.minEth, DEFAULT_PAYMASTER_MIN_ETH);
  assert.equal(cfg.postage.ttlMinSeconds, DEFAULT_TTL_MIN_SECONDS);
  assert.equal(cfg.postage.utilizationMaxPct, DEFAULT_UTILIZATION_MAX_PCT);
  assert.equal(cfg.postage.chainLagMaxBlocks, DEFAULT_CHAIN_LAG_MAX_BLOCKS);
  assert.equal(cfg.paymaster.configError, undefined);
  assert.equal(cfg.postage.configError, undefined);
});

test("a valid override is honoured", () => {
  const cfg = readThresholdsFromEnv({
    PAYMASTER_DEPOSIT_MIN_ETH: "0.01",
    POSTAGE_TTL_MIN_SECONDS: "86400",
    POSTAGE_UTILIZATION_MAX_PCT: "75",
    BEE_CHAIN_LAG_MAX_BLOCKS: "100",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.paymaster.minEth, "0.01");
  assert.equal(cfg.postage.ttlMinSeconds, 86_400);
  assert.equal(cfg.postage.utilizationMaxPct, 75);
  assert.equal(cfg.postage.chainLagMaxBlocks, 100);
});

test("an unreadable threshold falls back to the default AND says so — it never throws", () => {
  const cfg = readThresholdsFromEnv({
    PAYMASTER_DEPOSIT_MIN_ETH: "banana",
    POSTAGE_TTL_MIN_SECONDS: "-1",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.paymaster.minEth, DEFAULT_PAYMASTER_MIN_ETH);
  assert.match(cfg.paymaster.configError ?? "", /PAYMASTER_DEPOSIT_MIN_ETH/);
  assert.equal(cfg.postage.ttlMinSeconds, DEFAULT_TTL_MIN_SECONDS);
  assert.match(cfg.postage.configError ?? "", /POSTAGE_TTL_MIN_SECONDS/);
});

test("a bad PAYMASTER_DEPOSIT_MIN_ETH surfaces on the section instead of taking the server down", async () => {
  process.env.PAYMASTER_DEPOSIT_MIN_ETH = "0.0005 ETH";
  await probes.refreshPaymaster(readers(), silent);
  const s = probes.paymasterHealth();
  assert.equal(s.minEth, DEFAULT_PAYMASTER_MIN_ETH);
  assert.match(s.configError ?? "", /PAYMASTER_DEPOSIT_MIN_ETH/);
  assert.equal(s.ok, true, "0.002 ETH still clears the default floor");
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test("false beats null beats true — an alarm is never masked by an unknown", () => {
  assert.equal(combine([{ ok: true }, { ok: null }, { ok: false }]), false);
  assert.equal(combine([{ ok: true }, { ok: null }]), null);
  assert.equal(combine([{ ok: true }, { ok: true }]), true);
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

test("a reading three intervals old is stale, and a reading that never happened is stale", () => {
  const interval = 60_000;
  assert.equal(isStale(null, 1_000_000, interval), true);
  assert.equal(isStale(1_000_000 - interval * 3, 1_000_000, interval), true);
  assert.equal(isStale(1_000_000 - interval * 2, 1_000_000, interval), false);
});

test("the postage section reports stale once the refresher has missed three ticks", async () => {
  await probes.refreshPostage(readers(), silent);
  const fresh = probes.postageHealth();
  assert.equal(fresh.stale, false);
  assert.notEqual(fresh.checkedAt, null);

  const later = probes.postageHealth(Date.now() + probes.PROBE_INTERVAL_MS * 3);
  assert.equal(later.stale, true, "a check that cannot check has to be visible");
});

test("the paymaster section reports stale on the same rule", async () => {
  await probes.refreshPaymaster(readers(), silent);
  assert.equal(probes.paymasterHealth().stale, false);
  assert.equal(probes.paymasterHealth(Date.now() + probes.PROBE_INTERVAL_MS * 3).stale, true);
});

// ---------------------------------------------------------------------------
// A probe that could not read is NULL — never true, never false
// ---------------------------------------------------------------------------

test("a bee that cannot be reached leaves the batch UNKNOWN, not healthy and not dead", async () => {
  await probes.refreshPostage(
    readers({ beeStamp: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } }),
    silent,
  );
  const s = probes.postageHealth();
  assert.equal(s.bee.ok, null);
  assert.equal(s.bee.checks.ttl.ok, null);
  assert.equal(s.bee.checks.utilization.ok, null);
  assert.equal(s.bee.checks.usable.ok, null);
  assert.equal(s.bee.error, "network ECONNREFUSED");
  assert.equal(s.ok, null, "unknown must not roll up as healthy");
});

test("a 200 that is not a stamp is UNKNOWN too — a partial answer must not produce a verdict", async () => {
  await probes.refreshPostage(readers({ beeStamp: async () => ({ usable: true }) }), silent);
  const s = probes.postageHealth();
  assert.equal(s.bee.ok, null);
  assert.match(s.bee.reason ?? "", /missing fields/);
});

test("an unreadable chainstate leaves the chain check UNKNOWN", async () => {
  await probes.refreshPostage(
    readers({
      beeStamp: async () => ({ ...LIVE_STAMP, utilization: 1 }),
      chainstate: async () => { throw new Error("timed out"); },
    }),
    silent,
  );
  const s = probes.postageHealth();
  assert.equal(s.chain.ok, null);
  assert.equal(s.chain.lag, null);
  assert.equal(s.ok, null);
});

test("an RPC that cannot answer leaves the paymaster UNKNOWN", async () => {
  await probes.refreshPaymaster(
    readers({ deposit: async () => { throw Object.assign(new Error("server response 503"), { code: "SERVER_ERROR" }); } }),
    silent,
  );
  const s = probes.paymasterHealth();
  assert.equal(s.ok, null);
  assert.equal(s.depositEth, null);
  assert.equal(s.error, "rpc SERVER_ERROR");
});

test("a real alarm still wins over an unknown in the same section", async () => {
  await probes.refreshPostage(
    readers({ chainstate: async () => { throw new Error("timed out"); } }),
    silent,
  );
  assert.equal(probes.postageHealth().bee.ok, false, "LIVE values are a utilization alarm");
  assert.equal(probes.postageHealth().ok, false);
});

// ---------------------------------------------------------------------------
// Chain lag on the live section
// ---------------------------------------------------------------------------

test("a lagging bee makes the whole postage section false", async () => {
  await probes.refreshPostage(
    readers({
      beeStamp: async () => ({ ...LIVE_STAMP, utilization: 1 }),
      chainstate: async () => ({ block: 40_000_000, chainTip: 41_000_000 }),
    }),
    silent,
  );
  const s = probes.postageHealth();
  assert.equal(s.bee.ok, true);
  assert.equal(s.chain.ok, false, "1,000,000 blocks behind — every postage answer it gives is stale");
  assert.equal(s.chain.lag, 1_000_000);
  assert.equal(s.ok, false);
});

// ---------------------------------------------------------------------------
// Etherna
// ---------------------------------------------------------------------------

test("an unconfigured Etherna batch is reported, but does not pin the roll-up to unknown", async () => {
  await probes.refreshPostage(readers({ beeStamp: async () => ({ ...LIVE_STAMP, utilization: 1 }) }), silent);
  const s = probes.postageHealth();
  assert.equal(s.etherna.configured, false);
  assert.equal(s.etherna.ok, null);
  assert.match(s.etherna.reason ?? "", /ETHERNA/);
  assert.equal(s.ok, true, "not applicable is not the same as could not read");
});

test("a configured Etherna batch is read and can alarm on its own", async () => {
  process.env.ETHERNA_PLATFORM_BATCH = "1187f1af" + "c".repeat(56);
  process.env.ETHERNA_API_KEY = "id.secret";
  await probes.refreshPostage(
    readers({
      beeStamp: async () => ({ ...LIVE_STAMP, utilization: 1 }),
      ethernaStamp: async () => ({ ...LIVE_STAMP, utilization: 1, batchTTL: 345_600 }),
    }),
    silent,
  );
  const s = probes.postageHealth();
  assert.equal(s.etherna.configured, true);
  assert.equal(s.etherna.checks.ttl.ok, false, "4 days left is under the 7-day floor");
  assert.equal(s.etherna.ok, false);
  assert.equal(s.ok, false);
});

// ---------------------------------------------------------------------------
// No secrets on a public endpoint
// ---------------------------------------------------------------------------

test("batch ids are truncated — this endpoint is public", async () => {
  await probes.refreshPostage(readers(), silent);
  const body = JSON.stringify(probes.postageHealth());
  assert.ok(!body.includes(BATCH), "the full batch id must never reach the response");
  assert.equal(probes.postageHealth().bee.batch, "7dad2b8c0f1a…");
});

/**
 * Measured, not imagined: ethers 6.x puts `info={ "requestUrl": "…/v2/<key>" }`
 * into a SERVER_ERROR message, so a keyed RPC URL would have been published by
 * one 503 from the provider. The section gets the class; the log gets the text.
 */
test("library error text never reaches the public sections — only the server log", async () => {
  const KEY = "SECRETKEY123";
  const BODY = "SECRETBODY456";
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  process.env.ETHERNA_PLATFORM_BATCH = BATCH;
  process.env.ETHERNA_API_KEY = "id.secret";
  await probes.refreshPaymaster(
    readers({
      deposit: async () => {
        throw Object.assign(
          new Error(`server response 503 Service Unavailable (info={ "requestUrl": "https://arb.example/v2/${KEY}" })`),
          { code: "SERVER_ERROR" },
        );
      },
    }),
    log,
  );
  await probes.refreshPostage(
    readers({
      beeStamp: async () => { throw Object.assign(new Error(`GET /stamps/${BATCH} → 404`), { status: 404 }); },
      chainstate: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
      ethernaStamp: async () => { throw Object.assign(new Error(`GET /stamps/${BATCH} → 401: ${BODY}`), { status: 401 }); },
    }),
    log,
  );
  const pm = probes.paymasterHealth();
  const pg = probes.postageHealth();
  const published = JSON.stringify({ pm, pg });
  assert.ok(!published.includes(KEY), "the RPC key must never reach the response");
  assert.ok(!published.includes(BATCH), "the full batch id must never reach the response");
  assert.ok(!published.includes(BODY), "an upstream response body must never reach the response");
  assert.equal(pm.error, "rpc SERVER_ERROR");
  assert.equal(pm.ok, null);
  assert.equal(pg.bee.error, "HTTP 404");
  assert.equal(pg.chain.reason, "timed out");
  assert.equal(pg.etherna.error, "HTTP 401");
  // The operator still gets the raw text — once, on the crossing, in the log.
  assert.ok(lines.some((l) => l.includes(KEY)), "the transition log carries the library detail");
  assert.ok(lines.some((l) => l.includes(BODY)));
});

test("the paymaster section names both ceilings, because the server can only see one", async () => {
  await probes.refreshPaymaster(readers(), silent);
  const s = probes.paymasterHealth();
  assert.equal(s.chainId, 42161, "must follow KERNEL_CHAIN_ID, so a chain move moves the alarm");
  assert.equal(s.entryPoint, "0x0000000071727De22E5E9d8BAf0edAc6f37da032");
  assert.equal(s.address, "0xc99c11AD232a24e1158156b1F46495Cc8069c08f");
  assert.equal(s.depositEth, "0.002");
  assert.match(s.note, /dashboard-only/);
});

// ---------------------------------------------------------------------------
// Logging discipline
// ---------------------------------------------------------------------------

test("a standing alarm logs once, not once per tick", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const dead = readers({ beeStamp: async () => ({ ...LIVE_STAMP, usable: false, utilization: 1 }) });

  await probes.refreshPostage(dead, log);
  await probes.refreshPostage(dead, log);

  const usableLines = lines.filter((l) => l.includes("postage.bee.usable"));
  assert.equal(usableLines.length, 1, "a warning on every tick is a warning nobody reads");
  assert.match(usableLines[0]!, /ALARM/);
});

test("a crossing back to healthy is logged", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  await probes.refreshPostage(readers({ beeStamp: async () => ({ ...LIVE_STAMP, usable: false, utilization: 1 }) }), log);
  await probes.refreshPostage(readers({ beeStamp: async () => ({ ...LIVE_STAMP, utilization: 1 }) }), log);
  const usableLines = lines.filter((l) => l.includes("postage.bee.usable"));
  assert.equal(usableLines.length, 2);
  assert.match(usableLines[1]!, /ok/);
});

// ---------------------------------------------------------------------------
// Source pin — the sections have to stay ON the endpoint
// ---------------------------------------------------------------------------

test("/api/health still serves both sections, and its top-level ok stays liveness-only", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8");
  const start = src.indexOf('app.get("/api/health"');
  assert.ok(start > 0, "the health handler moved");
  const handler = src.slice(start, src.indexOf('app.get("/api/eth-price"'));

  assert.match(handler, /\n\s*ok: true,/, "top-level ok is liveness and must not become a roll-up");
  assert.match(handler, /\n\s*postage: postageHealth\(\),/);
  assert.match(handler, /\n\s*paymaster: paymasterHealth\(\),/);
});
