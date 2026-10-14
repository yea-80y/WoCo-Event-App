/**
 * A ticket sold after the scanner was set up scans green with nothing for the
 * organiser to do. The scanner's pack holds the chain's slot owners as of when
 * it was made; before this, a buyer who paid after that was shown INVALID ("No
 * ticket issued") until someone pressed refresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckinPack, TicketQr } from "@woco/shared";
import {
  MISS_OFFLINE_MESSAGE,
  MISS_RECHECK_MS,
  onPackMiss,
  shouldAutoRefresh,
  ticketNewerThanPack,
  type AutoRefreshInput,
  type MissInput,
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

test("red once a pack fetched for this very ticket still lacks it, and not before", () => {
  const now = 1_000_000;
  assert.deepEqual(onPackMiss(miss({ lastRecheckAt: now - 1_000, now })), { kind: "reject" });
  assert.deepEqual(onPackMiss(miss({ lastRecheckAt: now - 1_000, now, online: false })), { kind: "reject" },
    "the answer from a fresh pack stands even if the signal has since dropped");
  assert.deepEqual(onPackMiss(miss({ lastRecheckAt: now - MISS_RECHECK_MS, now })), { kind: "refresh" },
    "after the window it may have been sold since: look again");
});

function auto(over: Partial<AutoRefreshInput> = {}): AutoRefreshInput {
  return {
    ready: true,
    online: true,
    passDead: false,
    claimInFlight: false,
    busy: false,
    visible: true,
    sinceLastMs: 60_000,
    minGapMs: 60_000,
    ...over,
  };
}

test("the background refresh runs once the gap has passed, on a ready, online, visible scanner", () => {
  assert.equal(shouldAutoRefresh(auto()), true);
  assert.equal(shouldAutoRefresh(auto({ sinceLastMs: 59_999 })), false);
});

test("the background refresh never runs during a claim, a scan, or offline", () => {
  for (const [over, why] of [
    [{ claimInFlight: true }, "a claim is in flight"],
    [{ busy: true }, "a scan or another refresh is running"],
    [{ online: false }, "offline"],
    [{ passDead: true }, "the pass is dead"],
    [{ ready: false }, "not set up"],
    [{ visible: false }, "screen off: nobody is scanning"],
  ] as const) {
    assert.equal(shouldAutoRefresh(auto(over)), false, why);
  }
});
