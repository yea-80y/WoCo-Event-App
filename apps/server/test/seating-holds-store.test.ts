/**
 * Allocated seating S4: seated holds in the reservation store (docs/SEATING.md "Selling a
 * seat"; Fable S4 consult Q1-Q3, Q7). What must hold:
 *  - nobody else's live hold names a seat; the same browser asking for the same seats gets
 *    its hold back unchanged; its other holds end first, an open Stripe page closed at
 *    Stripe before its seats return ("complete" = a sale, kept; Stripe unreachable = 503);
 *  - a hold has at most one payable session, bound in one synchronous step, and runs to that
 *    session's expiry plus the grace;
 *  - fulfilment claims only the hold its session was made from, keeps it in force while it
 *    mints (bounded), and takes an expired one only if nobody else held or bought its seats;
 *  - `checkout.session.expired` ends only the hold waiting on that session;
 *  - a file that exists but cannot be read is never overwritten and pauses seated sales.
 *
 * The store resolves `.data` against the working directory, so the suite moves first.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../src/lib/event/reservation-store.js");
let file: string;

const EV = "e0000000-0000-4000-8000-0000000005e4";
const SE = "s0000000-0000-4000-8000-0000000005e4";
const DIGEST = `0x${"5a".repeat(32)}`;
const min = 60_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "woco-seated-holds-"));
  mkdirSync(join(dir, ".data"));
  file = join(dir, ".data", "reservations.json");
  process.chdir(dir);
  store = await import("../src/lib/event/reservation-store.js");
});

beforeEach(() => {
  rmSync(file, { force: true });
  store.__resetReservationsForTests();
});

const info = (seats: number[]) => seats.map((k) => ({ band: "b1", bandName: "Stalls", label: `Stalls, Row A, seat ${k}`, priceMinor: 2200 }));
const verifyOk = (seats: number[], remaining = 50) => async () => ({ ok: true as const, remaining, seats: info(seats) });
const neverExpire = async () => { throw new Error("no session should be closed here"); };

function hold(seats: number[], over: Partial<Parameters<typeof store.reserveSeats>[0]> = {}) {
  return store.reserveSeats({
    eventId: EV, seriesId: SE, seats, planDigest: DIGEST, perIpSeatCap: 30,
    clientKey: "buyer-a-key", ip: "203.0.113.1", verify: verifyOk(seats), expireSession: neverExpire, ...over,
  });
}

/** Persist records, then reload the store from them (how time-shifted state is set up). */
function seed(records: unknown[]): void {
  writeFileSync(file, JSON.stringify(records));
  store.__resetReservationsForTests();
}

const seatedRecord = (id: string, seats: number[], over: Record<string, unknown> = {}) => ({
  id, eventId: EV, seriesId: SE, quantity: seats.length, createdAt: at(-2 * min), expiresAt: at(8 * min),
  seats, planDigest: DIGEST, seatInfo: info(seats), clientKey: `key-${id}`, ...over,
});

test("a seat in someone else's live hold is a conflict; free ones are held", async () => {
  const a = await hold([3, 4]);
  assert.ok(a.ok);
  const b = await hold([4, 5], { clientKey: "buyer-b-key", ip: "203.0.113.2" });
  assert.ok(!b.ok);
  assert.equal(b.status, 409);
  assert.deepEqual(b.conflicts, [4]);
  const c = await hold([5, 6], { clientKey: "buyer-b-key", ip: "203.0.113.2" });
  assert.ok(c.ok);
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3, 4, 5, 6]);
});

test("the same browser asking for the same seats gets its hold back, clock unchanged", async () => {
  const a = await hold([3, 4]);
  assert.ok(a.ok);
  const again = await hold([3, 4], { verify: async () => { throw new Error("no read for a reused hold"); } });
  assert.ok(again.ok);
  assert.equal(again.reused, true);
  assert.equal(again.reservation.id, a.reservation.id);
  assert.equal(again.reservation.expiresAt, a.reservation.expiresAt);
});

test("other seats from the same browser end its earlier hold first", async () => {
  const a = await hold([3, 4]);
  assert.ok(a.ok);
  const b = await hold([4, 9]);
  assert.ok(b.ok, "its own earlier hold does not conflict");
  assert.deepEqual(store.heldSeatsFor(EV, SE), [4, 9]);
  assert.equal(store.getReservation(a.reservation.id)!.releasedBy, "replaced");
});

test("an earlier hold with a Stripe page open is closed at Stripe before its seats return", async () => {
  seed([seatedRecord("paying", [3, 4], { clientKey: "buyer-a-key", checkout: { sessionId: "cs_test_1", account: "acct_1", expiresAt: at(30 * min), sessions: 1 } })]);
  const closed: string[] = [];
  const ok = await hold([7], { expireSession: async (c) => { closed.push(c.sessionId); return "expired"; } });
  assert.ok(ok.ok);
  assert.deepEqual(closed, ["cs_test_1"]);
  assert.deepEqual(store.heldSeatsFor(EV, SE), [7]);
});

test("Stripe says the earlier page was paid: that order stands, and stays held", async () => {
  seed([seatedRecord("paying", [3, 4], { clientKey: "buyer-a-key", checkout: { sessionId: "cs_test_1", account: "acct_1", expiresAt: at(30 * min), sessions: 1 } })]);
  const ok = await hold([7], { expireSession: async () => "complete" });
  assert.ok(ok.ok);
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3, 4, 7]);
});

test("Stripe unreachable: nothing is released and the new hold is refused with 503", async () => {
  seed([seatedRecord("paying", [3, 4], { clientKey: "buyer-a-key", checkout: { sessionId: "cs_test_1", account: "acct_1", expiresAt: at(30 * min), sessions: 1 } })]);
  const r = await hold([7], { expireSession: async () => "error" });
  assert.ok(!r.ok);
  assert.equal(r.status, 503);
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3, 4]);
});

test("a newer session bound while Stripe closed the old one keeps the hold: it can still be paid", async () => {
  seed([seatedRecord("paying", [3, 4], { clientKey: "buyer-a-key", checkout: { sessionId: "cs_old", account: "acct_1", expiresAt: at(30 * min), sessions: 1 } })]);
  const rebind = async () => {
    // A checkout for the same hold binds its new session while this call is out at Stripe.
    assert.ok(store.bindCheckout("paying", "cs_old", { sessionId: "cs_new", account: "acct_1", expiresAtMs: Date.now() + 32 * min }));
    return "expired" as const;
  };
  const r = await hold([7], { expireSession: rebind });
  assert.ok(!r.ok);
  assert.equal(r.status, 503);
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3, 4]);
  seed([seatedRecord("paying2", [5], { checkout: { sessionId: "cs_old2", account: "acct_1", expiresAt: at(30 * min), sessions: 1 } })]);
  const out = await store.releaseSeatedHold("paying2", async () => {
    store.bindCheckout("paying2", "cs_old2", { sessionId: "cs_new2", account: "acct_1", expiresAtMs: Date.now() + 32 * min });
    return "expired";
  });
  assert.equal(out, "error");
  assert.deepEqual(store.heldSeatsFor(EV, SE), [5]);
});

test("the count must fit what the chain has left less what others hold; the IP cap counts seats", async () => {
  assert.ok((await hold([1, 2], { clientKey: "other-key", ip: "198.51.100.9" })).ok);
  const tooMany = await hold([5, 6, 7], { verify: verifyOk([5, 6, 7], 4) });
  assert.ok(!tooMany.ok);
  assert.equal(tooMany.available, 2);
  const capped = await hold([5, 6, 7], { perIpSeatCap: 2 });
  assert.ok(!capped.ok);
  assert.equal(capped.status, 429);
});

test("a refusal from the plan/chain checks is passed through, and holds nothing", async () => {
  const r = await hold([5], { verify: async () => ({ ok: false, status: 409, error: "taken", conflicts: [5] }) });
  assert.ok(!r.ok);
  assert.deepEqual(r.conflicts, [5]);
  assert.deepEqual(store.heldSeatsFor(EV, SE), []);
});

test("one payable session per hold: bound in one step, clock to session expiry + grace, at most 3", async () => {
  const a = await hold([3]);
  assert.ok(a.ok);
  const id = a.reservation.id;
  const exp1 = Date.now() + 32 * min;
  assert.ok(store.bindCheckout(id, null, { sessionId: "cs_test_a", account: "acct_1", expiresAtMs: exp1 }));
  assert.equal(Date.parse(store.getReservation(id)!.expiresAt), exp1 + store.SEATED_HOLD_GRACE_MS);
  // A caller that did not close the bound session cannot bind over it.
  assert.ok(!store.bindCheckout(id, null, { sessionId: "cs_test_x", account: "acct_1", expiresAtMs: exp1 }));
  assert.ok(store.bindCheckout(id, "cs_test_a", { sessionId: "cs_test_b", account: "acct_1", expiresAtMs: exp1 }));
  assert.ok(store.bindCheckout(id, "cs_test_b", { sessionId: "cs_test_c", account: "acct_1", expiresAtMs: exp1 }));
  assert.ok(!store.bindCheckout(id, "cs_test_c", { sessionId: "cs_test_d", account: "acct_1", expiresAtMs: exp1 }), "a fourth is refused");
  assert.equal(store.getReservation(id)!.checkout!.sessionId, "cs_test_c");
});

test("a lapsed or paid hold takes no session", () => {
  seed([seatedRecord("gone", [3], { expiresAt: at(-1 * min) }), seatedRecord("paid", [4], { consumedAt: at(-1 * min) })]);
  for (const id of ["gone", "paid"]) {
    assert.ok(!store.bindCheckout(id, null, { sessionId: "cs_test_z", account: "acct_1", expiresAtMs: Date.now() + 32 * min }), id);
  }
});

const bound = (id: string, seats: number[], over: Record<string, unknown> = {}) =>
  seatedRecord(id, seats, { checkout: { sessionId: `cs_${id}`, account: "acct_1", expiresAt: at(25 * min), sessions: 1 }, ...over });

test("fulfilment claims only the hold its own session was made from", () => {
  seed([bound("h1", [3, 4]), bound("h2", [8], { consumedAt: at(-1 * min) })]);
  assert.ok(!store.claimSeatedHold("h1", "cs_someone_else", EV, SE, new Set()).ok, "another session");
  assert.ok(!store.claimSeatedHold("h1", "cs_h1", EV, "other-series", new Set()).ok, "another series");
  assert.ok(!store.claimSeatedHold("h2", "cs_h2", EV, SE, new Set()).ok, "already used");
  assert.ok(!store.claimSeatedHold("nope", "cs_h1", EV, SE, new Set()).ok, "gone");
  const c = store.claimSeatedHold("h1", "cs_h1", EV, SE, new Set());
  assert.ok(c.ok);
  assert.deepEqual(c.seats, [3, 4]);
  assert.equal(c.planDigest, DIGEST);
  assert.ok(!store.claimSeatedHold("h1", "cs_other", EV, SE, new Set()).ok);
});

test("an expired hold is still the buyer's while nobody else held or bought its seats", () => {
  const lapsed = (id: string, seats: number[]) => bound(id, seats, { expiresAt: at(-3 * min) });
  seed([lapsed("late", [3, 4]), lapsed("late2", [6]), seatedRecord("rival", [6], { clientKey: "rival" }), lapsed("late3", [9])]);
  assert.ok(store.claimSeatedHold("late", "cs_late", EV, SE, new Set()).ok);
  assert.ok(!store.claimSeatedHold("late2", "cs_late2", EV, SE, new Set()).ok, "a live hold took a seat");
  assert.ok(!store.claimSeatedHold("late3", "cs_late3", EV, SE, new Set([9])).ok, "our sales minted a seat");
});

test("a claimed hold stays in force while it mints, for a bounded time", async () => {
  seed([bound("mid", [3], { expiresAt: at(-3 * min) })]);
  assert.ok(store.claimSeatedHold("mid", "cs_mid", EV, SE, new Set()).ok);
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3]);
  const rival = await hold([3], { clientKey: "rival", ip: "198.51.100.3" });
  assert.ok(!rival.ok, "nobody can hold a seat being minted");
  // A process that died mid-sale: the pin runs out.
  const stale = JSON.parse(readFileSync(file, "utf-8"));
  stale[0].fulfilling.at = at(-store.FULFIL_PIN_MS - min);
  seed(stale);
  assert.deepEqual(store.heldSeatsFor(EV, SE), []);
});

test("settling: minted or unresolved consumes; definitely not minted returns the seats at once", () => {
  seed([bound("m", [3]), bound("u", [4]), bound("x", [5])]);
  for (const id of ["m", "u", "x"]) assert.ok(store.claimSeatedHold(id, `cs_${id}`, EV, SE, new Set()).ok);
  store.settleSeatedHold("m", "cs_m", "minted");
  store.settleSeatedHold("u", "cs_u", "unresolved");
  store.settleSeatedHold("x", "cs_x", "not-minted");
  assert.ok(store.getReservation("m")!.consumedAt);
  assert.ok(store.getReservation("u")!.consumedAt);
  assert.equal(store.getReservation("x")!.releasedBy, "not-minted");
  // Recently paid seats stay listed for a lagging map; the unminted one is free.
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3, 4]);
});

test("checkout.session.expired ends only the hold waiting on that session", () => {
  seed([bound("w", [3]), bound("p", [4], { consumedAt: at(-1 * min) }), bound("f", [5], { fulfilling: { sessionId: "cs_f", at: at(0) } })]);
  assert.equal(store.releaseForExpiredSession("cs_unknown"), false);
  assert.equal(store.releaseForExpiredSession("cs_p"), false);
  assert.equal(store.releaseForExpiredSession("cs_f"), false);
  assert.equal(store.releaseForExpiredSession("cs_w"), true);
  assert.equal(store.getReservation("w")!.releasedBy, "session-expired");
  assert.deepEqual(store.heldSeatsFor(EV, SE), [4, 5]);
});

test("the buyer's release closes an open Stripe page first; a paid one is not released", async () => {
  seed([bound("open", [3]), bound("done", [4])]);
  assert.equal(await store.releaseSeatedHold("open", async () => "expired"), "released");
  assert.equal(await store.releaseSeatedHold("done", async () => "complete"), "paid");
  assert.equal(await store.releaseSeatedHold("done", async () => "error"), "error");
  assert.deepEqual(store.heldSeatsFor(EV, SE), [4]);
  assert.equal(await store.releaseSeatedHold("open", neverExpire), "released", "idempotent");
});

test("an unreadable file is never overwritten, pauses seated holds, and alarms", async () => {
  writeFileSync(file, "{not json");
  store.__resetReservationsForTests();
  assert.equal(store.reservationsPersisting(), false);
  const r = await hold([3]);
  assert.ok(!r.ok);
  assert.equal(r.status, 503);
  // General admission keeps working in memory, without touching the file.
  const ga = await store.reserve(EV, "ga-series", 1, async () => 10, 30, undefined, "k-ga", "203.0.113.9");
  assert.ok(ga.ok);
  assert.equal(readFileSync(file, "utf-8"), "{not json");
  const h = store.reservationsHealth();
  assert.equal(h.ok, false);
  assert.ok(h.unreadable);
});

test("health: holds that carried a session and ran out by time, with no expiry event, alarm", () => {
  const lapsed = bound("l", [3], { expiresAt: at(-2 * min), ttlLapsed: true });
  seed([lapsed]);
  assert.equal(store.reservationsHealth().ok, false);
  seed([lapsed, bound("e", [4], { releasedBy: "session-expired", expiresAt: at(-1 * min) })]);
  assert.equal(store.reservationsHealth().ok, true, "expiry events are arriving: a late one is not an alarm");
});

test("a malformed seated field is dropped alone; the hold keeps its seats held", () => {
  seed([bound("bad", [3, 4], { checkout: { sessionId: "nope", account: "acct_1", expiresAt: at(25 * min), sessions: 1 }, seatInfo: [{}] })]);
  const r = store.getReservation("bad")!;
  assert.deepEqual(r.seats, [3, 4]);
  assert.equal(r.checkout, undefined);
  assert.equal(r.seatInfo, undefined);
  assert.equal(r.planDigest, DIGEST);
  assert.ok(!store.claimSeatedHold("bad", "nope", EV, SE, new Set()).ok, "no session bound: no sale from it");
  assert.deepEqual(store.heldSeatsFor(EV, SE), [3, 4]);
});
