/**
 * The ticket minting watch on `/api/health` (#662).
 *
 * The events ledger caps each sponsor's mints per hour, and the checkout gate
 * refuses a sale the cap cannot mint. From outside that reads as "tickets not
 * on sale" — so this section is where an operator sees WHY, and sees it coming:
 * headroom below one maximum order is an alarm, and so is the owner's stop
 * (cap 0). Mirrors `subEns.minting`'s watch on the registrar's
 * `globalMintAllowance`. Each rule is pinned on its own.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import {
  DEFAULT_TICKET_MINT_ALLOWANCE_MIN,
  DEFAULT_TICKET_MINT_ALARM_PCT,
  evaluateTicketMintAllowance,
  evaluateTicketMintRamp,
  evaluateTicketSponsorAuthorised,
  readThresholdsFromEnv,
} from "../src/lib/health/alarms.js";

const EVENTS_KEY = Wallet.createRandom().privateKey;
process.env.WOCO_SPONSOR_PRIVATE_KEY = EVENTS_KEY;
delete process.env.TICKET_MINT_ALLOWANCE_MIN;
delete process.env.TICKET_MINT_ALARM_PCT;

const probes = await import("../src/lib/health/probes.js");
const { EventContractConfigError } = await import("../src/lib/chain/event-contract.js");

const LEDGER = { chainId: 421614, address: "0x" + "1e".repeat(20), version: "ledger" as const };
const RESETS = 1_790_000_000;
const UNLIMITED = 0xffff_ffff;

function readers(policy: () => Promise<unknown>) {
  return { ticketMintPolicy: policy } as unknown as Parameters<typeof probes.refreshTicketMinting>[0];
}
const silent = () => {};

beforeEach(() => {
  probes.__resetHealthProbes();
  delete process.env.TICKET_MINT_ALLOWANCE_MIN;
  delete process.env.TICKET_MINT_ALARM_PCT;
});
after(() => probes.__resetHealthProbes());

// ---------------------------------------------------------------------------
// The pure verdicts
// ---------------------------------------------------------------------------

test("the default floor is one maximum order", () => {
  assert.equal(DEFAULT_TICKET_MINT_ALLOWANCE_MIN, 10);
  assert.equal(readThresholdsFromEnv({}).ticketMinting.minMintable, 10);
});

test("headroom at or above the floor is healthy", () => {
  assert.deepEqual(
    evaluateTicketMintAllowance({ reading: { perHour: 100, mintable: 10, windowResetsAt: RESETS }, min: 10 }),
    { ok: true },
  );
});

test("headroom below the floor is an ALARM that says when it resets and names the leak", () => {
  const v = evaluateTicketMintAllowance({ reading: { perHour: 100, mintable: 9, windowResetsAt: RESETS }, min: 10 });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /9 of 100\/h/);
  assert.match(v.reason ?? "", new RegExp(new Date(RESETS * 1000).toISOString()));
  assert.match(v.reason ?? "", /leaked/);
});

test("cap 0 is an ALARM and promises no reset — the owner has stopped the sponsor", () => {
  const v = evaluateTicketMintAllowance({ reading: { perHour: 0, mintable: 0, windowResetsAt: RESETS }, min: 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /stopped/);
  assert.doesNotMatch(v.reason ?? "", /resets/);
});

test("UNLIMITED_MINTS and a version with no cap are healthy, not unknown", () => {
  assert.deepEqual(
    evaluateTicketMintAllowance({ reading: { perHour: UNLIMITED, mintable: UNLIMITED, windowResetsAt: 0 }, min: 10 }),
    { ok: true },
  );
  assert.deepEqual(evaluateTicketMintAllowance({ reading: "no-cap", min: 10 }), { ok: true });
});

test("an unread allowance is UNKNOWN — never healthy, never an alarm", () => {
  assert.deepEqual(evaluateTicketMintAllowance({ reading: null, min: 10, reason: "timed out" }), {
    ok: null,
    reason: "timed out",
  });
});

test("a de-authorised ticket sponsor is an ALARM", () => {
  assert.equal(evaluateTicketSponsorAuthorised({ authorised: false }).ok, false);
  assert.equal(evaluateTicketSponsorAuthorised({ authorised: true }).ok, true);
  assert.equal(evaluateTicketSponsorAuthorised({ authorised: null }).ok, null);
});

test("a bad threshold is ignored and REPORTED, never fatal", () => {
  const cfg = readThresholdsFromEnv({ TICKET_MINT_ALLOWANCE_MIN: "lots" }).ticketMinting;
  assert.equal(cfg.minMintable, 10);
  assert.match(cfg.configError ?? "", /TICKET_MINT_ALLOWANCE_MIN/);
});

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

test("a spent window turns the section red and shows the numbers", async () => {
  await probes.refreshTicketMinting(
    readers(async () => ({
      contract: LEDGER,
      sponsor: "0xabc",
      sponsorAuthorised: true,
      allowance: { perHour: 50, mintable: 3, windowResetsAt: RESETS },
    })),
    silent,
  );
  const s = probes.ticketMintingHealth();
  assert.equal(s.ok, false);
  assert.equal(s.checks.mintAllowance.ok, false);
  assert.equal(s.checks.sponsorAuthorised.ok, true);
  assert.deepEqual(s.allowance, { perHour: 50, mintable: 3, windowResetsAt: RESETS, unlimited: false });
  assert.equal(s.contract, LEDGER.address);
  assert.equal(s.version, "ledger");
});

test("the env floor is applied to the section", async () => {
  process.env.TICKET_MINT_ALLOWANCE_MIN = "2";
  process.env.TICKET_MINT_ALARM_PCT = "100"; // isolate the floor: 47 of 50 used would trip the busy-hour alarm
  await probes.refreshTicketMinting(
    readers(async () => ({
      contract: LEDGER,
      sponsor: "0xabc",
      sponsorAuthorised: true,
      allowance: { perHour: 50, mintable: 3, windowResetsAt: RESETS },
    })),
    silent,
  );
  assert.equal(probes.ticketMintingHealth().ok, true);
  assert.equal(probes.ticketMintingHealth().minMintable, 2);
});

test("an unlimited sponsor is flagged as such and healthy", async () => {
  await probes.refreshTicketMinting(
    readers(async () => ({
      contract: LEDGER,
      sponsor: "0xabc",
      sponsorAuthorised: true,
      allowance: { perHour: UNLIMITED, mintable: UNLIMITED, windowResetsAt: 0 },
    })),
    silent,
  );
  const s = probes.ticketMintingHealth();
  assert.equal(s.ok, true);
  assert.equal(s.allowance !== null && s.allowance !== "no-cap" && s.allowance.unlimited, true);
});

test("a de-authorised sponsor turns the section red even with headroom", async () => {
  await probes.refreshTicketMinting(
    readers(async () => ({
      contract: LEDGER,
      sponsor: "0xabc",
      sponsorAuthorised: false,
      allowance: { perHour: 50, mintable: 50, windowResetsAt: RESETS },
    })),
    silent,
  );
  const s = probes.ticketMintingHealth();
  assert.equal(s.checks.mintAllowance.ok, true);
  assert.equal(s.ok, false);
});

test("no ticket sponsor key is an ALARM", async () => {
  const { SponsorKeyUnconfigured } = await import("../src/lib/chain/sponsor-wallet.js");
  await probes.refreshTicketMinting(readers(async () => { throw new SponsorKeyUnconfigured(); }), silent);
  const s = probes.ticketMintingHealth();
  assert.equal(s.ok, false);
  assert.match(s.checks.sponsorAuthorised.reason ?? "", /WOCO_SPONSOR_PRIVATE_KEY/);
});

test("a failed read is UNKNOWN and says so, never a stale green", async () => {
  await probes.refreshTicketMinting(readers(async () => { throw new Error("socket hang up"); }), silent);
  const s = probes.ticketMintingHealth();
  assert.equal(s.ok, null);
  assert.equal(s.checks.mintAllowance.ok, null);
});

test("a ledger that does not answer the cap ABI is an ALARM, not an unknown", async () => {
  await probes.refreshTicketMinting(
    readers(async () => { throw new EventContractConfigError("does not answer sponsorMintAllowance"); }),
    silent,
  );
  const s = probes.ticketMintingHealth();
  assert.equal(s.ok, false);
  assert.match(s.checks.mintAllowance.reason ?? "", /misconfigured/);
  // Since the no-code fix the AUTHORISATION read raises this class too, so the
  // public reason must not name only the cap read.
  assert.match(s.checks.sponsorAuthorised.reason ?? "", /authorisedSponsors \/ sponsorMintAllowance/);
});

test("before the first read the section is stale and unknown", () => {
  const s = probes.ticketMintingHealth();
  assert.equal(s.ok, null);
  assert.equal(s.stale, true);
  assert.equal(s.checkedAt, null);
});

test("a verdict change is logged once, not every tick", async () => {
  const lines: string[] = [];
  const spent = readers(async () => ({
    contract: LEDGER,
    sponsor: "0xabc",
    sponsorAuthorised: true,
    allowance: { perHour: 50, mintable: 0, windowResetsAt: RESETS },
  }));
  await probes.refreshTicketMinting(spent, (l) => lines.push(l));
  await probes.refreshTicketMinting(spent, (l) => lines.push(l));
  assert.equal(lines.filter((l) => l.includes("ticketMinting.mintAllowance: ALARM")).length, 1);
});

// ---------------------------------------------------------------------------
// #672: the busy hour, as a share of the cap
// ---------------------------------------------------------------------------

const ledgerPolicy = (allowance: { perHour: number; mintable: number; windowResetsAt: number }, address = LEDGER.address) =>
  readers(async () => ({ contract: { ...LEDGER, address }, sponsor: "0xabc", sponsorAuthorised: true, allowance }));

test("#672: the busy-hour alarm defaults to half the cap", () => {
  assert.equal(DEFAULT_TICKET_MINT_ALARM_PCT, 50);
  assert.equal(readThresholdsFromEnv({}).ticketMinting.alarmPct, 50);
  assert.equal(readThresholdsFromEnv({ TICKET_MINT_ALARM_PCT: "80" }).ticketMinting.alarmPct, 80);
});

test("#672: a percentage outside 1-100 is ignored and REPORTED, never fatal", () => {
  for (const bad of ["0", "101", "-5", "12.5", "half"]) {
    const cfg = readThresholdsFromEnv({ TICKET_MINT_ALARM_PCT: bad }).ticketMinting;
    assert.equal(cfg.alarmPct, 50, bad);
    assert.match(cfg.configError ?? "", /TICKET_MINT_ALARM_PCT/, bad);
  }
  assert.equal(readThresholdsFromEnv({ TICKET_MINT_ALARM_PCT: "100" }).ticketMinting.alarmPct, 100);
});

test("#672: below the share is healthy; AT the share is an ALARM that names the lever and the leak", () => {
  const at = (mintable: number) =>
    evaluateTicketMintRamp({ reading: { perHour: 10_000, mintable, windowResetsAt: RESETS }, alarmPct: 50 });
  assert.deepEqual(at(5_001), { ok: true }); // 4,999 used
  const v = at(5_000); // 5,000 used: exactly half
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /5000 of 10000/);
  assert.match(v.reason ?? "", /50%, alarm at 50%/);
  assert.match(v.reason ?? "", /setSponsorMintCap/);
  assert.match(v.reason ?? "", /leaked/);
  assert.match(v.reason ?? "", new RegExp(new Date(RESETS * 1000).toISOString()));
});

test("#672: nothing to judge without a finite cap - no cap, unlimited, or the stop lever", () => {
  const ramp = (reading: Parameters<typeof evaluateTicketMintRamp>[0]["reading"]) =>
    evaluateTicketMintRamp({ reading, alarmPct: 50 });
  assert.deepEqual(ramp("no-cap"), { ok: true });
  assert.deepEqual(ramp({ perHour: UNLIMITED, mintable: UNLIMITED, windowResetsAt: 0 }), { ok: true });
  // Cap 0 is already an ALARM on mintAllowance; the busy-hour rule does not double it.
  assert.deepEqual(ramp({ perHour: 0, mintable: 0, windowResetsAt: RESETS }), { ok: true });
  assert.equal(ramp(null).ok, null);
});

test("#672: a busy hour turns the section red while the floor is still fine", async () => {
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 10_000, mintable: 4_000, windowResetsAt: RESETS }), silent);
  const s = probes.ticketMintingHealth();
  assert.equal(s.checks.mintAllowance.ok, true);
  assert.equal(s.checks.mintRamp.ok, false);
  assert.equal(s.ok, false);
  assert.equal(s.alarmPct, 50);
});

test("#672: the env share is applied to the section", async () => {
  process.env.TICKET_MINT_ALARM_PCT = "80";
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 10_000, mintable: 4_000, windowResetsAt: RESETS }), silent);
  assert.equal(probes.ticketMintingHealth().ok, true);
  assert.equal(probes.ticketMintingHealth().alarmPct, 80);
});

test("#672: a busy-hour verdict change is logged once, not every tick", async () => {
  const lines: string[] = [];
  const busy = ledgerPolicy({ perHour: 100, mintable: 40, windowResetsAt: RESETS });
  await probes.refreshTicketMinting(busy, (l) => lines.push(l));
  await probes.refreshTicketMinting(busy, (l) => lines.push(l));
  assert.equal(lines.filter((l) => l.includes("ticketMinting.mintRamp: ALARM")).length, 1);
});

test("#672: the 7-day peak keeps the busiest OPEN window, by share of its cap", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const end = (hoursAgo: number) => Math.floor(now / 1000) - hoursAgo * 3600;
  // No window open: the whole cap is mintable and the end moves with the clock. Not recorded.
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 1_000, mintable: 1_000, windowResetsAt: end(-1) }), silent);
  assert.equal(probes.ticketMintingHealth().peak7d, null);
  // One window, read twice as it fills: the later, higher reading is kept.
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 1_000, mintable: 900, windowResetsAt: end(30) }), silent);
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 1_000, mintable: 700, windowResetsAt: end(30) }), silent);
  // A bigger count under a bigger cap is a SMALLER share: 400 of 10,000 is 4%, 300 of 1,000 is 30%.
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 10_000, mintable: 9_600, windowResetsAt: end(2) }), silent);
  assert.deepEqual(probes.ticketMintingHealth().peak7d, {
    used: 300,
    perHour: 1_000,
    pct: 30,
    windowEndedAt: new Date(end(30) * 1000).toISOString(),
  });
});

test("#672: windows older than 7 days drop out of the peak", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const endSec = Math.floor(now / 1000) - 3600;
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 100, mintable: 10, windowResetsAt: endSec }), silent);
  assert.equal(probes.ticketMintingHealth().peak7d?.pct, 90);
  t.mock.timers.tick(7 * 24 * 3600_000); // that window ended 7 days + 1 hour ago
  assert.equal(probes.ticketMintingHealth().peak7d, null);
});

test("#672: a contract change starts the peak afresh - two ledgers' hours never mix", async (t) => {
  // Pinned: against the real clock this fixed window would age out of the 7 days on its own.
  t.mock.timers.enable({ apis: ["Date"], now: RESETS * 1000 + 3600_000 });
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 100, mintable: 10, windowResetsAt: RESETS }), silent);
  assert.equal(probes.ticketMintingHealth().peak7d?.pct, 90);
  const MAINNET = "0x" + "ea".repeat(20);
  await probes.refreshTicketMinting(ledgerPolicy({ perHour: 10_000, mintable: 9_990, windowResetsAt: RESETS + 60 }, MAINNET), silent);
  assert.deepEqual(probes.ticketMintingHealth().peak7d, {
    used: 10,
    perHour: 10_000,
    pct: 0,
    windowEndedAt: new Date((RESETS + 60) * 1000).toISOString(),
  });
});
