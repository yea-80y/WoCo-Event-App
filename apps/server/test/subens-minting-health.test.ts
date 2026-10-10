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
  evaluateCswFactory,
  evaluateGlobalMint,
  evaluateRegistrarEnrolled,
  evaluateSponsorAuthorised,
  evaluateSponsorBalance,
  readThresholdsFromEnv,
} from "../src/lib/health/alarms.js";

delete process.env.SUB_ENS_SPONSOR_MIN_ETH;
delete process.env.SUB_ENS_CHAIN_ID;
delete process.env.SUB_ENS_REGISTRY_ADDRESS;
delete process.env.SUB_ENS_REGISTRAR_ADDRESS;
// The NAMES key (registrar v2.2 split). The events key is a different one.
const SPONSOR_KEY = Wallet.createRandom().privateKey;
const EVENTS_KEY = Wallet.createRandom().privateKey;
process.env.SUB_ENS_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;
process.env.WOCO_SPONSOR_PRIVATE_KEY = EVENTS_KEY;

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
    registrarPolicy: async () => ({ sponsorAuthorised: true, globalMint: "unsupported" as const }),
    cswFactoryCodehash: async () => probes.CSW_FACTORY_CODEHASH,
  };
  return { ...base, ...over } as Parameters<typeof probes.refreshSubEnsMinting>[0];
}

const silent = () => {};

beforeEach(() => {
  probes.__resetHealthProbes();
  delete process.env.SUB_ENS_SPONSOR_MIN_ETH;
  process.env.SUB_ENS_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;
  process.env.WOCO_SPONSOR_PRIVATE_KEY = EVENTS_KEY;
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
  delete process.env.SUB_ENS_SPONSOR_PRIVATE_KEY;
  await probes.refreshSubEnsMinting(readers({ sponsorBalance: probes.liveReaders.sponsorBalance }), silent);
  const s = probes.subEnsMintingHealth();
  assert.equal(s.checks.sponsorBalance.ok, false);
  assert.match(s.checks.sponsorBalance.reason ?? "", /SUB_ENS_SPONSOR_PRIVATE_KEY/);
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
  const start = src.indexOf("function healthReport()"); // the report /api/health serves (#672)
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

// ---------------------------------------------------------------------------
// Sponsor authorisation, the registrar-wide cap, the CSW factory (Fable
// sponsor-key consult §6, §11.1)
// ---------------------------------------------------------------------------

test("an authorised sponsor is healthy; a removed one is an ALARM; unread is UNKNOWN", () => {
  assert.deepEqual(evaluateSponsorAuthorised({ authorised: true }), { ok: true });
  const v = evaluateSponsorAuthorised({ authorised: false });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /not an authorised sponsor/);
  assert.equal(evaluateSponsorAuthorised({ authorised: null, reason: "timed out" }).ok, null);
});

test("the global cap alarms at zero headroom and only there", () => {
  assert.equal(evaluateGlobalMint({ reading: { remaining: 1, windowResetsAt: 1 } }).ok, true);
  const spent = evaluateGlobalMint({ reading: { remaining: 0, windowResetsAt: 1 } });
  assert.equal(spent.ok, false);
  assert.match(spent.reason ?? "", /leaked/);
  assert.equal(evaluateGlobalMint({ reading: null, reason: "x" }).ok, null);
});

test("a registrar from before the cap is healthy, not unknown", () => {
  assert.deepEqual(evaluateGlobalMint({ reading: "unsupported" }), { ok: true });
});

test("only a revert with NO data reads as 'no cap on this registrar'", async () => {
  const { makeError } = await import("ethers");
  const call = (data: string | null) =>
    makeError("reverted", "CALL_EXCEPTION", {
      action: "call",
      data,
      reason: null,
      transaction: { to: "0x" + "1".repeat(40), data: "0x" },
      invocation: null,
      revert: null,
    });
  assert.equal(probes.revertedWithoutData(call("0x")), true);
  assert.equal(probes.revertedWithoutData(call(null)), true);
  assert.equal(probes.revertedWithoutData(call("0x08c379a0")), false, "a revert with a reason is not a missing function");
  assert.equal(probes.revertedWithoutData(makeError("timeout", "TIMEOUT", { operation: "call" })), false);
  assert.equal(probes.revertedWithoutData(new Error("socket hang up")), false);
});

test("the CSW factory only alarms while Coinbase login is on", () => {
  const expected = probes.CSW_FACTORY_CODEHASH;
  const wrong = "0x" + "00".repeat(32);
  assert.deepEqual(evaluateCswFactory({ codehash: wrong, expected, required: false }), { ok: true });
  assert.deepEqual(evaluateCswFactory({ codehash: null, expected, required: false }), { ok: true });
  assert.deepEqual(evaluateCswFactory({ codehash: expected.toUpperCase().replace("0X", "0x"), expected, required: true }), { ok: true });
  assert.equal(evaluateCswFactory({ codehash: wrong, expected, required: true }).ok, false);
  assert.equal(evaluateCswFactory({ codehash: null, expected, required: true, reason: "x" }).ok, null);
});

test("the pinned factory is the canonical v1 address and codehash (read on Arbitrum One 2026-09-19)", () => {
  assert.equal(probes.CSW_FACTORY, "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a");
  assert.equal(probes.CSW_FACTORY_CODEHASH, "0xc4900c000fd23885462a115b872741ad2b1e7ff2d7889aee18bc4d4bef3728f6");
});

test("a removed sponsor makes the whole section false", async () => {
  await probes.refreshSubEnsMinting(
    readers({ registrarPolicy: async () => ({ sponsorAuthorised: false, globalMint: "unsupported" }) }),
    silent,
  );
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, false);
  assert.equal(s.checks.sponsorAuthorised.ok, false);
});

test("a spent global cap makes the whole section false, and the numbers are shown", async () => {
  await probes.refreshSubEnsMinting(
    readers({
      registrarPolicy: async () => ({ sponsorAuthorised: true, globalMint: { remaining: 0, windowResetsAt: 1_800_003_600 } }),
    }),
    silent,
  );
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, false);
  assert.deepEqual(s.globalMint, { remaining: 0, windowResetsAt: 1_800_003_600 });
});

test("headroom is reported before it hits zero, and does not alarm", async () => {
  await probes.refreshSubEnsMinting(
    readers({
      registrarPolicy: async () => ({ sponsorAuthorised: true, globalMint: { remaining: 12, windowResetsAt: 1_800_003_600 } }),
    }),
    silent,
  );
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, true);
  assert.deepEqual(s.globalMint, { remaining: 12, windowResetsAt: 1_800_003_600 });
});

test("a registrar-policy read that fails leaves the section UNKNOWN, not healthy", async () => {
  await probes.refreshSubEnsMinting(
    readers({ registrarPolicy: async () => { throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } }),
    silent,
  );
  const s = probes.subEnsMintingHealth();
  assert.equal(s.ok, null);
  assert.equal(s.checks.sponsorAuthorised.ok, null);
  assert.equal(s.checks.globalMint.ok, null);
  assert.equal(s.stale, false);
});

test("the section is only fresh once the registrar policy has been read too", async () => {
  await probes.refreshSubEnsMinting(readers(), silent);
  assert.equal(probes.subEnsMintingHealth().stale, false);
  const src = readFileSync(fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)), "utf-8");
  assert.match(src, /const reads = \[enrolmentReading\.at, sponsorReading\.at, policyReading\.at\];/);
});

test("the CSW factory is read, and required, only while Coinbase login is on", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)), "utf-8");
  assert.match(src, /if \(FEATURES\.coinbaseLoginAllowed\) \{\s*try \{\s*cswFactoryReading =/);
  assert.match(src, /required: FEATURES\.coinbaseLoginAllowed,/);
  assert.match(src, /keccak256\(await withTimeout\(subEnsChain\(\)\.getCode\(CSW_FACTORY\)/);
});

test("the sponsor asked about is the key this build mints with", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)), "utf-8");
  const policy = src.slice(src.indexOf("registrarPolicy: async () =>"), src.indexOf("cswFactoryCodehash: async () =>"));
  assert.match(policy, /sponsor = getSubEnsSponsorAddress\(\);/);
  assert.match(policy, /registrar\.authorisedSponsors\(sponsor\)/);
});

test("the minting watch looks at the NAMES key, never the events key", async () => {
  await probes.refreshSubEnsMinting(readers(), silent);
  const s = probes.subEnsMintingHealth();
  assert.equal(s.sponsor, new Wallet(SPONSOR_KEY).address);
  assert.notEqual(s.sponsor, new Wallet(EVENTS_KEY).address);
  const src = readFileSync(fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)), "utf-8");
  assert.doesNotMatch(src, /getSponsorAddress\(/, "the events key's accessor must not appear in the probes");
});

test("one key under both names is a configError on the section too", async () => {
  process.env.WOCO_SPONSOR_PRIVATE_KEY = SPONSOR_KEY;
  await probes.refreshSubEnsMinting(readers(), silent);
  assert.match(probes.subEnsMintingHealth().configError ?? "", /must not be the same key/);
  process.env.WOCO_SPONSOR_PRIVATE_KEY = EVENTS_KEY;
  assert.equal(probes.subEnsMintingHealth().configError, undefined);
});
