/**
 * The sub-ENS minting watch on `/api/health` (#598).
 *
 * WHAT THIS TEST IS FOR. Minting a name can stop in two ways that nothing
 * outside would notice, because every existing name keeps resolving: the
 * registry stops listing WoCoRegistrar, or the sponsor that pays runs dry.
 * Registry v2.2 makes the first one an ordinary governance outcome —
 * `acceptAdmin` drops every registrar, so a handover batch that forgot
 * `addRegistrar(WoCoRegistrar)` stops minting until it lands. Each rule is
 * pinned on its own, so a mutation to a comparison or a verdict turns a test
 * red rather than moving a value nobody asserts on.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

import { getSubEnsDeployment } from "@woco/shared";
import {
  DEFAULT_SUB_ENS_SPONSOR_MIN_ETH,
  evaluateRegistrarEnrolled,
  evaluateSponsorBalance,
  readThresholdsFromEnv,
} from "../src/lib/health/alarms.js";

delete process.env.SUB_ENS_SPONSOR_MIN_ETH;
delete process.env.SUB_ENS_CHAIN_ID;
delete process.env.SUB_ENS_REGISTRY_ADDRESS;
delete process.env.SUB_ENS_REGISTRAR_ADDRESS;
const SPONSOR_KEY = Wallet.createRandom().privateKey;
process.env.WOCO_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;

const probes = await import("../src/lib/health/probes.js");

const ETH = 10n ** 18n;
const MIN_WEI = (5n * ETH) / 10_000n; // 0.0005
const SERVER_REGISTRY = getSubEnsDeployment(42161).registry.toLowerCase();

function readers(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    deposit: async () => 0n,
    beeStamp: async () => ({}),
    chainstate: async () => ({}),
    ethernaStamp: async () => ({}),
    ensNameExpires: async () => 0n,
    registrarEnrolment: async () => ({ registry: SERVER_REGISTRY, enrolled: true }),
    sponsorBalance: async () => (13n * ETH) / 10_000n, // 0.0013, LIVE 2026-09-19
  };
  return { ...base, ...over } as Parameters<typeof probes.refreshSubEnsMinting>[0];
}

const silent = () => {};

beforeEach(() => {
  probes.__resetHealthProbes();
  delete process.env.SUB_ENS_SPONSOR_MIN_ETH;
  process.env.WOCO_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;
});

after(() => probes.__resetHealthProbes());

// ---------------------------------------------------------------------------
// The pure verdicts
// ---------------------------------------------------------------------------

test("an enrolled registrar is healthy; a dropped one is an ALARM that says what to do", () => {
  assert.deepEqual(evaluateRegistrarEnrolled({ enrolled: true }), { ok: true });
  const v = evaluateRegistrarEnrolled({ enrolled: false });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /addRegistrar\(WoCoRegistrar\)/);
});

test("an enrolment that could not be read is UNKNOWN — never healthy, never an alarm", () => {
  assert.deepEqual(evaluateRegistrarEnrolled({ enrolled: null, reason: "timed out" }), {
    ok: null,
    reason: "timed out",
  });
});

test("the sponsor floor is a floor: at the minimum is healthy, one wei under is an alarm", () => {
  assert.equal(evaluateSponsorBalance({ balanceWei: MIN_WEI, minWei: MIN_WEI }).ok, true);
  assert.equal(evaluateSponsorBalance({ balanceWei: MIN_WEI - 1n, minWei: MIN_WEI }).ok, false);
  assert.equal(evaluateSponsorBalance({ balanceWei: 0n, minWei: MIN_WEI }).ok, false);
  assert.equal(evaluateSponsorBalance({ balanceWei: null, minWei: MIN_WEI }).ok, null);
});

// ---------------------------------------------------------------------------
// The threshold
// ---------------------------------------------------------------------------

test("the default floor is 0.0005 ETH", () => {
  assert.equal(DEFAULT_SUB_ENS_SPONSOR_MIN_ETH, "0.0005");
  const t = readThresholdsFromEnv({});
  assert.equal(t.subEnsMinting.sponsorMinEth, "0.0005");
  assert.equal(t.subEnsMinting.configError, undefined);
});

test("a valid override is honoured", () => {
  assert.equal(readThresholdsFromEnv({ SUB_ENS_SPONSOR_MIN_ETH: "0.002" }).subEnsMinting.sponsorMinEth, "0.002");
});

test("an unreadable SUB_ENS_SPONSOR_MIN_ETH falls back to the default AND says so — it never throws", () => {
  for (const bad of ["0", "-1", "1e-3", "lots", "0.0000000000000000001"]) {
    const t = readThresholdsFromEnv({ SUB_ENS_SPONSOR_MIN_ETH: bad });
    assert.equal(t.subEnsMinting.sponsorMinEth, "0.0005", `"${bad}" must fall back`);
    assert.match(t.subEnsMinting.configError ?? "", /SUB_ENS_SPONSOR_MIN_ETH/);
  }
});

test("a bad threshold surfaces on the section rather than taking the server down", async () => {
  process.env.SUB_ENS_SPONSOR_MIN_ETH = "nonsense";
  await probes.refreshSubEnsMinting(readers(), silent);
  const s = probes.subEnsMintingHealth();
  assert.match(s.configError ?? "", /SUB_ENS_SPONSOR_MIN_ETH/);
  assert.equal(s.sponsorMinEth, "0.0005");
});

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

test("LIVE state 2026-09-19: enrolled, 0.0013 ETH — healthy, and it says where it looked", async () => {
  await probes.refreshSubEnsMinting(readers(), silent);
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, true);
  assert.equal(s.chainId, 42161);
  assert.equal(s.registrar, getSubEnsDeployment(42161).registrar);
  assert.equal(s.registry, SERVER_REGISTRY);
  assert.equal(s.serverRegistry, SERVER_REGISTRY);
  assert.equal(s.sponsor, new Wallet(SPONSOR_KEY).address);
  assert.equal(s.sponsorBalanceEth, "0.0013");
  assert.equal(s.stale, false);
  assert.ok(s.checkedAt);
});

test("a dropped registrar makes the whole section false", async () => {
  await probes.refreshSubEnsMinting(
    readers({ registrarEnrolment: async () => ({ registry: SERVER_REGISTRY, enrolled: false }) }),
    silent,
  );
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, false);
  assert.equal(s.checks.registrarEnrolled.ok, false);
  assert.equal(s.checks.sponsorBalance.ok, true);
});

test("a registrar minting into a different registry than the server reads is an ALARM, even if enrolled there", async () => {
  const elsewhere = "0x" + "ab".repeat(20);
  await probes.refreshSubEnsMinting(
    readers({ registrarEnrolment: async () => ({ registry: elsewhere, enrolled: true }) }),
    silent,
  );
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, false);
  assert.equal(s.registry, elsewhere);
  assert.match(s.checks.registrarEnrolled.reason ?? "", /different registry/);
});

test("a sponsor below the floor makes the whole section false", async () => {
  await probes.refreshSubEnsMinting(readers({ sponsorBalance: async () => MIN_WEI - 1n }), silent);
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, false);
  assert.equal(s.checks.sponsorBalance.ok, false);
});

test("no sponsor key at all is an ALARM, not an unknown — nothing can be minted", async () => {
  delete process.env.WOCO_SPONSOR_PRIVATE_KEY;
  await probes.refreshSubEnsMinting(readers({ sponsorBalance: probes.liveReaders.sponsorBalance }), silent);
  const s = probes.subEnsMintingHealth();
  assert.equal(s.checks.sponsorBalance.ok, false);
  assert.match(s.checks.sponsorBalance.reason ?? "", /WOCO_SPONSOR_PRIVATE_KEY/);
  assert.equal(s.sponsor, null);
  assert.equal(s.ok, false);
});

test("an RPC that cannot answer leaves the section UNKNOWN with a failure class, and an alarm still wins", async () => {
  const down = async () => {
    throw Object.assign(new Error("server response 503 Service Unavailable"), { code: "SERVER_ERROR" });
  };
  await probes.refreshSubEnsMinting(readers({ registrarEnrolment: down, sponsorBalance: down }), silent);
  let s = probes.subEnsMintingHealth();
  assert.equal(s.ok, null);
  assert.equal(s.checks.registrarEnrolled.reason, "rpc SERVER_ERROR");
  assert.equal(s.registry, null);

  await probes.refreshSubEnsMinting(readers({ registrarEnrolment: down, sponsorBalance: async () => 0n }), silent);
  s = probes.subEnsMintingHealth();
  assert.equal(s.ok, false, "a real alarm is never masked by an unknown beside it");
});

test("library error text never reaches the section — only the server log", async () => {
  const KEY = "SECRETKEY123";
  const lines: string[] = [];
  await probes.refreshSubEnsMinting(
    readers({
      sponsorBalance: async () => {
        throw Object.assign(new Error(`server response 503 (info={ "requestUrl": "https://arb.example/v2/${KEY}" })`), {
          code: "SERVER_ERROR",
        });
      },
    }),
    (l) => lines.push(l),
  );
  const published = JSON.stringify(probes.subEnsMintingHealth());
  assert.ok(!published.includes(KEY));
  assert.ok(!published.includes("arb.example"));
  assert.ok(lines.some((l) => l.includes(KEY)), "the transition log carries the library detail");
});

test("the section goes stale at three missed ticks", async () => {
  await probes.refreshSubEnsMinting(readers(), silent);
  const at = Date.parse(probes.subEnsMintingHealth().checkedAt!);
  assert.equal(probes.subEnsMintingHealth(at + 3 * probes.PROBE_INTERVAL_MS - 1).stale, false);
  assert.equal(probes.subEnsMintingHealth(at + 3 * probes.PROBE_INTERVAL_MS).stale, true);
});

test("a section never read is stale and unknown", () => {
  const s = probes.subEnsMintingHealth();
  assert.equal(s.stale, true);
  assert.equal(s.ok, null);
});

test("a standing alarm logs once, not once per tick, and a recovery is logged", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const dropped = readers({ registrarEnrolment: async () => ({ registry: SERVER_REGISTRY, enrolled: false }) });
  await probes.refreshSubEnsMinting(dropped, log);
  await probes.refreshSubEnsMinting(dropped, log);
  let mine = lines.filter((l) => l.includes("subEns.minting.registrar"));
  assert.equal(mine.length, 1);
  assert.match(mine[0]!, /ALARM/);

  await probes.refreshSubEnsMinting(readers(), log);
  mine = lines.filter((l) => l.includes("subEns.minting.registrar"));
  assert.equal(mine.length, 2);
  assert.match(mine[1]!, /: ok/);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("/api/health serves the section under subEns.minting, and top-level ok stays liveness-only", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8");
  const start = src.indexOf('app.get("/api/health"');
  assert.ok(start > 0, "the health handler moved");
  const handler = src.slice(start, src.indexOf('app.get("/api/eth-price"'));
  assert.match(handler, /\n\s*minting: subEnsMintingHealth\(\),/);
  assert.match(handler, /\n\s*ok: true,/);
});

test("the probe runs on the shared timer", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)), "utf-8");
  const tick = src.slice(src.indexOf("const tick = () =>"), src.indexOf("tick();"));
  assert.match(tick, /refreshSubEnsMinting\(\)/);
});

test("enrolment is asked of the registry the REGISTRAR mints into", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)), "utf-8");
  const reader = src.slice(src.indexOf("registrarEnrolment: async"), src.indexOf("sponsorBalance: async"));
  assert.match(reader, /\.registry\(\)/);
  assert.match(reader, /registrars\(registrar\)/);
});
