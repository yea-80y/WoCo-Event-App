/**
 * The `woco.eth` renewal watch on `/api/health` (#420).
 *
 * WHAT THIS TEST IS FOR. The failure is the quietest one the platform has: the
 * parent name expires, nothing changes for 90 days because records keep
 * resolving through the grace, and then every `*.woco.eth` name — organiser
 * sites and the app's own frontend — goes dark on one day. There is no
 * auto-renew and there is not meant to be (owner, 2026-09-11: one manual
 * transaction a year from the Safe), so this arithmetic IS the mitigation.
 * Each rule is pinned on its own: a mutation to any threshold or sign has to
 * turn a test red rather than shift a number nobody asserts on.
 *
 * The value marked LIVE is what mainnet actually returned on 2026-09-11.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { id } from "ethers";

import {
  ENS_BASE_REGISTRAR_MAINNET,
  ENS_GRACE_PERIOD_DAYS,
  SUB_ENS_PARENT,
  SUB_ENS_PARENT_LABEL,
} from "@woco/shared";
import {
  DEFAULT_ENS_EXPIRY_MIN_DAYS,
  evaluateEnsExpiry,
  readThresholdsFromEnv,
} from "../src/lib/health/alarms.js";

delete process.env.ENS_EXPIRY_MIN_DAYS;
delete process.env.ENS_MAINNET_RPC_URL;

const probes = await import("../src/lib/health/probes.js");

/** A round instant, so seconds → milliseconds is exact in both directions. */
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY_MS = 86_400_000;

/** LIVE, mainnet BaseRegistrar.nameExpires(labelhash("woco")), 2026-09-11. */
const LIVE_EXPIRES_AT_SEC = 1_799_929_835n;

const inDays = (days: number): bigint => BigInt((NOW + days * DAY_MS) / 1000);

function readers(over: Partial<Record<string, unknown>> = {}) {
  const base = {
    deposit: async () => 0n,
    beeStamp: async () => ({}),
    chainstate: async () => ({}),
    ethernaStamp: async () => ({}),
    ensNameExpires: async () => inDays(365),
  };
  return { ...base, ...over } as Parameters<typeof probes.refreshEnsExpiry>[0];
}

const silent = () => {};

beforeEach(() => {
  probes.__resetHealthProbes();
  delete process.env.ENS_EXPIRY_MIN_DAYS;
});

after(() => probes.__resetHealthProbes());

// ---------------------------------------------------------------------------
// The pure evaluator
// ---------------------------------------------------------------------------

test("LIVE mainnet reading: the registration and its grace, spelled out", () => {
  const v = evaluateEnsExpiry({ expiresAtSec: LIVE_EXPIRES_AT_SEC, minDays: 120, now: NOW });
  assert.equal(v.expiresAt, "2027-01-14T12:30:35.000Z");
  assert.equal(v.graceEndsAt, "2027-04-14T12:30:35.000Z", "expiry + the 90-day owner-only grace");
  assert.equal(v.ok, true, "125 days out on 2026-09-11 — over the 120-day floor, just");
});

test("the threshold is a floor, not a window: 121 and 120 pass, 119 alarms", () => {
  const at = (days: number) =>
    evaluateEnsExpiry({ expiresAtSec: inDays(days), minDays: DEFAULT_ENS_EXPIRY_MIN_DAYS, now: NOW });

  assert.equal(at(121).ok, true);
  assert.equal(at(120).ok, true, "exactly at the floor is still ok — `>=`, not `>`");
  assert.equal(at(119).ok, false);
  assert.equal(at(119).daysRemaining, 119);
  assert.match(at(119).reason ?? "", /renew from the Safe/);
});

test("past expiry is an ALARM, not a relaxed state — and graceEndsAt says how long the door stays open", () => {
  const v = evaluateEnsExpiry({ expiresAtSec: inDays(-5), minDays: 120, now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.daysRemaining, -5);
  assert.equal(
    v.graceEndsAt,
    new Date(NOW - 5 * DAY_MS + ENS_GRACE_PERIOD_DAYS * DAY_MS).toISOString(),
    "expiry + 90 days",
  );
  assert.match(v.reason ?? "", /EXPIRED 5d ago/);
  assert.match(v.reason ?? "", /records still resolve/);
});

test("past the grace the reason stops promising that records resolve", () => {
  const v = evaluateEnsExpiry({ expiresAtSec: inDays(-(ENS_GRACE_PERIOD_DAYS + 1)), minDays: 120, now: NOW });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /RELEASED/);
  assert.doesNotMatch(v.reason ?? "", /still resolve/);
});

test("zero is `not registered` — an alarm, because it means the name is gone or the label is wrong", () => {
  const v = evaluateEnsExpiry({ expiresAtSec: 0n, minDays: 120, now: NOW });
  assert.equal(v.ok, false, "a registrar that has never issued this label is not an unknown");
  assert.equal(v.reason, "not registered");
  assert.equal(v.expiresAt, null, "epoch zero is not a date worth publishing");
  assert.equal(v.graceEndsAt, null);
});

test("a read that could not happen is UNKNOWN — never healthy, never expired", () => {
  const v = evaluateEnsExpiry({ expiresAtSec: null, minDays: 120, now: NOW, reason: "rpc SERVER_ERROR" });
  assert.equal(v.ok, null);
  assert.equal(v.reason, "rpc SERVER_ERROR");
  assert.equal(v.daysRemaining, null);
});

// ---------------------------------------------------------------------------
// The thrown-error path, end to end through the probe
// ---------------------------------------------------------------------------

test("an RPC that throws leaves the section unknown with a failure CLASS, not a message", async () => {
  await probes.refreshEnsExpiry(
    readers({
      ensNameExpires: async () => {
        throw Object.assign(new Error("server response 503 Service Unavailable"), { code: "SERVER_ERROR" });
      },
    }),
    silent,
  );
  const s = probes.subEnsParentHealth();
  assert.equal(s.ok, null);
  assert.equal(s.reason, "rpc SERVER_ERROR");
  assert.equal(s.expiresAt, null);
  assert.equal(s.lastReadAt, null, "a failed attempt is not a read");
});

test("a network refusal and a timeout are their own classes", async () => {
  await probes.refreshEnsExpiry(
    readers({
      ensNameExpires: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    }),
    silent,
  );
  assert.equal(probes.subEnsParentHealth().reason, "network ECONNREFUSED");

  await probes.refreshEnsExpiry(
    readers({
      ensNameExpires: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    }),
    silent,
  );
  assert.equal(probes.subEnsParentHealth().reason, "timed out");
});

// ---------------------------------------------------------------------------
// Staleness — a watch that cannot watch must not read as silence
// ---------------------------------------------------------------------------

test("the section goes stale at three missed six-hour ticks", async () => {
  assert.equal(probes.subEnsParentHealth().stale, true, "never read is stale");
  assert.equal(probes.subEnsParentHealth().lastReadAt, null);

  await probes.refreshEnsExpiry(readers(), silent);
  const fresh = probes.subEnsParentHealth();
  assert.equal(fresh.stale, false);
  assert.notEqual(fresh.lastReadAt, null);

  const now = Date.now();
  assert.equal(
    probes.subEnsParentHealth(now + probes.ENS_EXPIRY_PROBE_INTERVAL_MS * 2).stale,
    false,
    "two missed ticks is not yet evidence the refresher died",
  );
  assert.equal(probes.subEnsParentHealth(now + probes.ENS_EXPIRY_PROBE_INTERVAL_MS * 3).stale, true);
});

test("staleness follows the last SUCCESSFUL read, not the last attempt", async () => {
  await probes.refreshEnsExpiry(readers(), silent);
  const readAt = probes.subEnsParentHealth().lastReadAt;
  assert.ok(readAt);
  const readMs = Date.parse(readAt);

  // A strictly later attempt, so "last run" and "last read" are different
  // instants — otherwise a probe that timed staleness off the wrong one would
  // pass this test by coincidence.
  await new Promise((r) => setTimeout(r, 5));
  await probes.refreshEnsExpiry(
    readers({ ensNameExpires: async () => { throw new Error("boom"); } }),
    silent,
  );

  const s = probes.subEnsParentHealth(readMs + probes.ENS_EXPIRY_PROBE_INTERVAL_MS * 3);
  assert.equal(s.lastReadAt, readAt, "a failing probe must not refresh the age of the knowledge");
  assert.equal(s.ok, null, "and it is unknown, not the last happy answer");
  assert.equal(s.stale, true, "a day of failed reads has to be visible, not fresh-looking");
});

test("six hours, and the interval is not an env knob", () => {
  assert.equal(probes.ENS_EXPIRY_PROBE_INTERVAL_MS, 6 * 60 * 60 * 1000);
  const src = readFileSync(
    fileURLToPath(new URL("../src/lib/health/probes.ts", import.meta.url)),
    "utf-8",
  );
  assert.doesNotMatch(src, /ENS_EXPIRY_PROBE_INTERVAL_MS\s*=\s*Number\(|env\.ENS_EXPIRY_PROBE_INTERVAL_MS/);
});

// ---------------------------------------------------------------------------
// Env — a typo must not take the server down, and must not pass silently
// ---------------------------------------------------------------------------

test("the default is used when nothing is set", () => {
  const cfg = readThresholdsFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(cfg.ensParent.minDays, DEFAULT_ENS_EXPIRY_MIN_DAYS);
  assert.equal(cfg.ensParent.minDays, 120);
  assert.equal(cfg.ensParent.configError, undefined);
});

test("a valid override is honoured", () => {
  const cfg = readThresholdsFromEnv({ ENS_EXPIRY_MIN_DAYS: "200" } as NodeJS.ProcessEnv);
  assert.equal(cfg.ensParent.minDays, 200);
  assert.equal(cfg.ensParent.configError, undefined);
});

test("an unreadable ENS_EXPIRY_MIN_DAYS falls back to 120 AND says so — it never throws", () => {
  for (const raw of ["abc", "0", "-1", "7.5"]) {
    const cfg = readThresholdsFromEnv({ ENS_EXPIRY_MIN_DAYS: raw } as NodeJS.ProcessEnv);
    assert.equal(cfg.ensParent.minDays, DEFAULT_ENS_EXPIRY_MIN_DAYS, `${raw} must not be honoured`);
    assert.match(cfg.ensParent.configError ?? "", /ENS_EXPIRY_MIN_DAYS/);
  }
});

test("a bad threshold surfaces on the section rather than taking the server down", async () => {
  process.env.ENS_EXPIRY_MIN_DAYS = "abc";
  await probes.refreshEnsExpiry(readers(), silent);
  const s = probes.subEnsParentHealth();
  assert.equal(s.minDays, DEFAULT_ENS_EXPIRY_MIN_DAYS);
  assert.match(s.configError ?? "", /ENS_EXPIRY_MIN_DAYS/);
  assert.equal(s.ok, true, "365 days out still clears the default floor");
});

// ---------------------------------------------------------------------------
// No secrets on a public endpoint
// ---------------------------------------------------------------------------

/**
 * Measured, not imagined: ethers 6.x puts `info={ "requestUrl": "…/v2/<key>" }`
 * into a SERVER_ERROR message. `ENS_MAINNET_RPC_URL` may later hold a keyed
 * endpoint, so one 503 from the provider would publish the key on an endpoint
 * anyone can poll. The section gets the class; the log gets the text.
 */
test("library error text never reaches the section — only the server log", async () => {
  const KEY = "SECRETKEY123";
  const URL_WITH_KEY = `https://eth-mainnet.example/v2/${KEY}`;
  const lines: string[] = [];

  await probes.refreshEnsExpiry(
    readers({
      ensNameExpires: async () => {
        throw Object.assign(
          new Error(`server response 503 Service Unavailable (info={ "requestUrl": "${URL_WITH_KEY}" })`),
          { code: "SERVER_ERROR" },
        );
      },
    }),
    (l) => lines.push(l),
  );

  const published = JSON.stringify(probes.subEnsParentHealth());
  assert.ok(!published.includes(KEY), "the RPC key must never reach the response");
  assert.ok(!published.includes(URL_WITH_KEY), "nor the endpoint it is embedded in");
  assert.ok(!published.includes("eth-mainnet.example"), "nor the host on its own");
  assert.equal(probes.subEnsParentHealth().reason, "rpc SERVER_ERROR");

  // The operator still gets the raw text — once, on the crossing, in the log.
  assert.ok(lines.some((l) => l.includes(KEY)), "the transition log carries the library detail");
});

// ---------------------------------------------------------------------------
// Logging discipline
// ---------------------------------------------------------------------------

test("a standing alarm logs once, not once per tick, and a recovery is logged", async () => {
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const expiring = readers({ ensNameExpires: async () => inDays(10) });

  await probes.refreshEnsExpiry(expiring, log);
  await probes.refreshEnsExpiry(expiring, log);
  let mine = lines.filter((l) => l.includes("subEns.parent.expiry"));
  assert.equal(mine.length, 1, "a warning on every tick is a warning nobody reads");
  assert.match(mine[0]!, /ALARM/);

  await probes.refreshEnsExpiry(readers(), log);
  mine = lines.filter((l) => l.includes("subEns.parent.expiry"));
  assert.equal(mine.length, 2);
  assert.match(mine[1]!, /ok/);
});

// ---------------------------------------------------------------------------
// The name being watched, and where the section is served
// ---------------------------------------------------------------------------

test("the watched name and registrar are the real ones, from one place", () => {
  assert.equal(SUB_ENS_PARENT_LABEL, "woco");
  assert.equal(SUB_ENS_PARENT, "woco.eth");
  assert.equal(ENS_BASE_REGISTRAR_MAINNET, "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85");
  // labelhash is keccak256 of the LABEL ALONE. The namehash of "woco.eth" is a
  // different number and BaseRegistrar would answer 0 for it — the alarm would
  // read "not registered" forever, or worse, be mistaken for one.
  assert.equal(
    id(SUB_ENS_PARENT_LABEL),
    "0x03bd0c8a4856f9cc05f6baadebc6efe245e2f4cd7e5ff6599f7c87386584d566",
  );
  assert.equal(probes.subEnsParentHealth().name, "woco.eth");
});

test("/api/health still serves the section under subEns.parent", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8");
  const start = src.indexOf('app.get("/api/health"');
  assert.ok(start > 0, "the health handler moved");
  const handler = src.slice(start, src.indexOf('app.get("/api/eth-price"'));

  assert.match(handler, /\n\s*parent: subEnsParentHealth\(\),/);
  assert.match(handler, /\n\s*ok: true,/, "top-level ok stays liveness-only — this must not fold in");
});
