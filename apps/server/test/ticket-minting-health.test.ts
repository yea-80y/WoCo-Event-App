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
  evaluateTicketMintAllowance,
  evaluateTicketSponsorAuthorised,
  readThresholdsFromEnv,
} from "../src/lib/health/alarms.js";

const EVENTS_KEY = Wallet.createRandom().privateKey;
process.env.WOCO_SPONSOR_PRIVATE_KEY = EVENTS_KEY;
delete process.env.TICKET_MINT_ALLOWANCE_MIN;

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
