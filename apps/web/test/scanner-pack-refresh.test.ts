/**
 * A ticket sold after the scanner was set up scans green with nothing for the
 * organiser to do. The scanner's pack holds the chain's slot owners as of when
 * it was made; before this, a buyer who paid after that was shown INVALID ("No
 * ticket issued") until someone pressed refresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTicketCanonicalMessage, type CheckinPack, type TicketQr } from "@woco/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MISS_OFFLINE_MESSAGE,
  MISS_RECHECK_MS,
  MISS_FAILED_MESSAGE,
  NOT_FOUND_BOUND_MS,
  NOT_FOUND_LAG_MS,
  NOT_FOUND_YET_MESSAGE,
  onPackMiss,
  resolveMiss,
  shouldAutoRefresh,
  ticketNewerThanPack,
  type AutoRefreshInput,
  type MissInput,
  type MissOutcome,
  type RecheckResult,
} from "../src/lib/scanner/pack-refresh.js";
import { IN_FLIGHT_MESSAGE } from "../src/lib/scanner/admission.js";
import { verifyTicket } from "../src/lib/scanner/verify.js";

const EVENT = "evt-1";
const ONCHAIN = ("0x" + "11".repeat(32)) as `0x${string}`;
const SIG = "0x" + "ab".repeat(65);

function qr(t: Pick<TicketQr, "seriesId" | "edition"> & { sig?: string }): string {
  return `woco://t/${EVENT}/${encodeURIComponent(t.seriesId)}/${t.edition}/${t.sig ?? SIG}`;
}

function pack(owners: string[], series = "ser-1", totalSupply = 10): CheckinPack {
  return {
    v: 1,
    eventId: EVENT,
    eventTitle: "Test",
    eventDate: "2026-10-20T19:00:00.000Z",
    series: [{ seriesId: series, name: "General", totalSupply, onChainEventId: ONCHAIN, slotOwners: owners }],
    checkins: [],
    generatedAt: "2026-10-14T18:00:00.000Z",
  };
}

test("a ticket the pack does not know yet is one a newer pack could know", async () => {
  const p = pack(["0x" + "aa".repeat(20)]);
  for (const [raw, why] of [
    [qr({ seriesId: "ser-1", edition: 2 }), "sold after the pack: no owner for its slot"],
    [qr({ seriesId: "ser-2", edition: 1 }), "a ticket type added after the pack"],
    [qr({ seriesId: "ser-1", edition: 11 }), "supply raised after the pack"],
  ] as const) {
    const v = await verifyTicket(raw, p);
    assert.equal(v.status, "invalid", why);
    assert.ok(ticketNewerThanPack(v), why);
  }
});

test("a forgery or a malformed code is not a pack that is behind", async () => {
  const p = pack(["0x" + "aa".repeat(20)]);
  const forged = await verifyTicket(qr({ seriesId: "ser-1", edition: 1 }), p);
  assert.equal(forged.status, "invalid");
  assert.equal(ticketNewerThanPack(forged), null, "signature mismatch: a newer pack cannot fix it");
  const bad = await verifyTicket(qr({ seriesId: "ser-1", edition: 1, sig: "0x12" }), p);
  assert.equal(ticketNewerThanPack(bad), null);
  assert.equal(ticketNewerThanPack(await verifyTicket("not a ticket", p)), null);
});

function miss(over: Partial<MissInput> = {}): MissInput {
  return { online: true, passDead: null, claimInFlight: false, lastRecheckAt: undefined, now: 1_000_000, ...over };
}

test("online, a missing ticket fetches a newer pack before any verdict", () => {
  assert.deepEqual(onPackMiss(miss()), { kind: "refresh" });
});

test("offline, a missing ticket is 'couldn't confirm', never red", () => {
  assert.deepEqual(onPackMiss(miss({ online: false })), { kind: "cant-confirm", message: MISS_OFFLINE_MESSAGE });
});

test("a dead pass or a claim in flight is 'couldn't confirm' with its reason", () => {
  assert.deepEqual(onPackMiss(miss({ passDead: "Door pass revoked" })), { kind: "cant-confirm", message: "Door pass revoked" });
  assert.deepEqual(onPackMiss(miss({ claimInFlight: true })), { kind: "cant-confirm", message: IN_FLIGHT_MESSAGE });
});

test("a pack fetched for this very ticket moments ago is not fetched again; after a few seconds it is", () => {
  const now = 1_000_000;
  assert.deepEqual(onPackMiss(miss({ lastRecheckAt: now - 1_000, now })), { kind: "settled" });
  assert.deepEqual(onPackMiss(miss({ lastRecheckAt: now - 1_000, now, online: false })), { kind: "settled" },
    "the answer from a fresh pack stands even if the signal has since dropped");
  assert.deepEqual(onPackMiss(miss({ lastRecheckAt: now - MISS_RECHECK_MS, now })), { kind: "refresh" },
    "after the window it may have been minted since: look again");
  assert.ok(MISS_RECHECK_MS <= 5_000, "a guest who has just bought scans again within seconds, not half a minute");
});

// ---------------------------------------------------------------------------
// A slot with no owner: grey once, then red (resolveMiss)
// ---------------------------------------------------------------------------

const burner = privateKeyToAccount(generatePrivateKey());
const signed = async (edition: number) =>
  `woco://t/${EVENT}/ser-1/${edition}/${await burner.signMessage({ message: buildTicketCanonicalMessage({ onChainEventId: ONCHAIN, seriesId: "ser-1", edition }) })}`;

/** A scanner's view of one ticket over time: a clock, the packs it gets, and what each scan shows. */
function door(opts: { recheck: (t: number) => RecheckResult; packOwners: (t: number) => string[] }) {
  let t = 1_000_000;
  let packAsOf = 0;
  const firstSeen = new Map<string, number>();
  return {
    at: (ms: number) => (t = ms),
    get t() {
      return t;
    },
    scan: async (raw: string): Promise<MissOutcome> => {
      const before = await verifyTicket(raw, pack(opts.packOwners(packAsOf)));
      return resolveMiss(before, {
        key: "ser-1 2",
        firstSeen,
        now: () => t,
        recheck: async () => {
          const r = opts.recheck(t);
          if (r.kind === "refreshed") packAsOf = t;
          return r;
        },
        reverify: () => verifyTicket(raw, pack(opts.packOwners(packAsOf))),
        packAsOf: () => packAsOf,
      });
    },
  };
}

const red = (o: MissOutcome) => o.kind === "verdict" && o.verdict.status === "invalid" && o.verdict.reason === "No ticket issued for this edition";
const grey = (o: MissOutcome) => o.kind === "cant-confirm" && o.message === NOT_FOUND_YET_MESSAGE;
const OWNER_1 = "0x" + "aa".repeat(20);

test("the first miss for a ticket is grey 'not found yet', even straight after a fresh pack", async () => {
  const d = door({ recheck: () => ({ kind: "refreshed" }), packOwners: () => [OWNER_1] });
  assert.ok(grey(await d.scan(await signed(2))));
});

test("a re-scan answered by a pack requested 5 s after the first miss, still without it, is red", async () => {
  const d = door({ recheck: () => ({ kind: "refreshed" }), packOwners: () => [OWNER_1] });
  const raw = await signed(2);
  assert.ok(grey(await d.scan(raw)));
  d.at(d.t + 3_000);
  assert.ok(grey(await d.scan(raw)), "3 s on, the replica may still be behind");
  d.at(d.t + 2_000); // 5 s after the first miss, well inside the 20 s bound
  assert.ok(red(await d.scan(raw)), "the original wording, 'No ticket issued for this edition'");
  assert.ok(NOT_FOUND_LAG_MS <= 5_000);
});

test("past 20 s it is red whatever the fetches did", async () => {
  for (const failing of [{ kind: "settled" }, { kind: "failed" }] as RecheckResult[]) {
    const d = door({ recheck: (t) => (t === 1_000_000 ? { kind: "refreshed" } : failing), packOwners: () => [OWNER_1] });
    const raw = await signed(2);
    assert.ok(grey(await d.scan(raw)));
    d.at(d.t + NOT_FOUND_BOUND_MS);
    assert.ok(!red(await d.scan(raw)), `${failing.kind}: at exactly 20 s, not yet`);
    d.at(d.t + 1);
    assert.ok(red(await d.scan(raw)), `${failing.kind}: past 20 s, red`);
  }
});

test("a genuine ticket whose slot appears on the re-check reads valid", async () => {
  let minted = false;
  const d = door({ recheck: () => ({ kind: "refreshed" }), packOwners: () => (minted ? [OWNER_1, burner.address.toLowerCase()] : [OWNER_1]) });
  const raw = await signed(2);
  assert.ok(grey(await d.scan(raw)));
  minted = true; // the replica caught up
  d.at(d.t + 3_000);
  const o = await d.scan(raw);
  assert.ok(o.kind === "verdict" && o.verdict.status === "valid");
});

test("a never-sold edition can never stay grey past the bound, however it is re-scanned", async () => {
  for (const pattern of [
    () => ({ kind: "refreshed" }) as RecheckResult,
    () => ({ kind: "settled" }) as RecheckResult,
    () => ({ kind: "failed" }) as RecheckResult,
    (t: number) => ({ kind: (t / 1000) % 2 ? "settled" : "refreshed" }) as RecheckResult,
  ]) {
    const d = door({ recheck: pattern, packOwners: () => [OWNER_1] });
    const raw = await signed(2);
    const start = d.t;
    let last: MissOutcome = await d.scan(raw);
    for (let step = 1; step <= 10; step++) {
      d.at(start + step * 3_000);
      last = await d.scan(raw);
      if (d.t - start > NOT_FOUND_BOUND_MS) assert.ok(red(last), `still not red ${d.t - start} ms after the first miss`);
    }
    assert.ok(red(last));
  }
});

test("offline, a dead pass and a claim in flight stay 'couldn't confirm', even past the bound - never green", async () => {
  const d = door({ recheck: (t) => (t === 1_000_000 ? { kind: "refreshed" } : { kind: "cant-confirm", message: MISS_OFFLINE_MESSAGE }), packOwners: () => [OWNER_1] });
  const raw = await signed(2);
  await d.scan(raw);
  d.at(d.t + 60_000);
  assert.deepEqual(await d.scan(raw), { kind: "cant-confirm", message: MISS_OFFLINE_MESSAGE });
});

test("a ticket type or edition the event does not have, or a forged code, reads red once re-checked", async () => {
  const d = door({ recheck: () => ({ kind: "refreshed" }), packOwners: () => [OWNER_1] });
  for (const raw of [qr({ seriesId: "ser-2", edition: 1 }), qr({ seriesId: "ser-1", edition: 11 }), qr({ seriesId: "ser-1", edition: 1 })]) {
    const o = await d.scan(raw);
    assert.ok(o.kind === "verdict" && o.verdict.status === "invalid", raw);
  }
  const nothing = door({ recheck: () => ({ kind: "failed" }), packOwners: () => [OWNER_1] });
  assert.deepEqual(await nothing.scan(qr({ seriesId: "ser-2", edition: 1 })), { kind: "cant-confirm", message: MISS_FAILED_MESSAGE },
    "a ticket type the pack may simply be behind on, with no newer pack to ask: not a verdict");
});

test("the scan path settles every pack miss through resolveMiss, before any verdict is shown", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/scanner/store.svelte.ts", import.meta.url), "utf8");
  const scan = src.slice(src.indexOf("private async scanTicket("), src.indexOf('if (verdict.status === "invalid") return { kind: "rejected"'));
  assert.match(scan, /const outcome = await resolveMiss\(verdict, \{/);
  assert.match(scan, /if \(outcome\.kind === "cant-confirm"\) return \{ kind: "cant-confirm"[^\n]*\n\s*verdict = outcome\.verdict;/);
  assert.match(scan, /firstSeen: this\.notFoundSince,/);
  assert.match(scan, /packAsOf: \(\) => this\.packAsOf,/);
  // When the pack was REQUESTED, not when it arrived: a slow answer is no fresher than its question.
  assert.equal((src.match(/const requestedAt = Date\.now\(\);\s*const pack = await this\.fetchPack\(/g) ?? []).length, 2);
  assert.equal((src.match(/this\.packAsOf = requestedAt;/g) ?? []).length, 2);
});
