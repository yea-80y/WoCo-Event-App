/**
 * Per-event held-seat cap (#223).
 *
 * Two things are under test. The FORMULA — that no event is sized worse than
 * the flat 30 it replaces, and that the floor can never refuse an order the
 * platform advertises as legal. And the SCOPE — that a hold at one event stops
 * consuming another event's allowance, which is the defect itself: the check's
 * comment claimed event scope, the code counted platform-wide.
 *
 * The store writes .data/ relative to process.cwd(), so this suite chdirs into a
 * temp dir BEFORE importing it.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../src/lib/event/reservation-store.js");
let cap: typeof import("../src/lib/event/seat-cap.js");

/**
 * Each test gets its own event id. The store keeps reservations in a
 * module-level Map with no reset hook, and the cap counts per (address, event),
 * so a fresh event id isolates a test completely — without exporting a clear()
 * that exists only for tests.
 */
let seq = 0;
const freshEvent = (): string => `event-${++seq}`;

/**
 * Series ids must be unique per test too, not just event ids. The store's
 * clientKey dedup and `heldFor()` both key on seriesId alone, which is sound
 * in production because both client mint sites emit `crypto.randomUUID()` —
 * but a test that reused one id across events would hit the dedup path and
 * silently reuse a hold instead of taking a new one.
 */
const freshSeries = (): [string, string] => [`ga-${++seq}`, `vip-${seq}`];
const IP = "203.0.113.7";

/** Plenty of seats — these tests are about the IP cap, not supply. */
const supply = async () => 100_000;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-seat-cap-test-")));
  store = await import("../src/lib/event/reservation-store.js");
  cap = await import("../src/lib/event/seat-cap.js");
});

/** Hold `qty` seats and assert it succeeded, returning the reservation id. */
async function hold(
  eventId: string,
  seriesId: string,
  qty: number,
  perIpCap: number,
  clientKey?: string,
): Promise<string> {
  const r = await store.reserve(eventId, seriesId, qty, supply, perIpCap, undefined, clientKey, IP);
  assert.ok(r.ok, `expected hold of ${qty} to succeed`);
  return r.ok ? r.reservation.id : "";
}

// ---------------------------------------------------------------------------
// The formula
// ---------------------------------------------------------------------------

test("the floor is the advertised order size, never less", () => {
  // #223 proposed `max(5, …)`. With RESERVATION_MAX_QTY = 10 that refuses the
  // first legal order on any small event — the platform would advertise a
  // maximum it will not honour.
  assert.equal(cap.perIpSeatCapForEvent(20), store.RESERVATION_MAX_QTY);
  assert.equal(cap.perIpSeatCapForEvent(50), store.RESERVATION_MAX_QTY);
  assert.ok(cap.perIpSeatCapForEvent(1) >= store.RESERVATION_MAX_QTY);
  assert.ok(cap.perIpSeatCapForEvent(0) >= store.RESERVATION_MAX_QTY);
});

test("no event is looser than the flat 30 it replaces", () => {
  for (const supplySize of [10, 50, 100, 200, 300, 2_000, 100_000]) {
    assert.ok(
      cap.perIpSeatCapForEvent(supplySize) <= 30,
      `cap for ${supplySize} seats must not exceed the old flat 30`,
    );
  }
  // The headline case: 30 was 60% of a 50-seat room, now it is 20%.
  assert.equal(cap.perIpSeatCapForEvent(50), 10);
});

test("no event of any size is loosened — the ceiling stays at the old flat 30", () => {
  // An earlier draft raised this to 100 to admit a 40-seat "block booking".
  // That was unnecessary: a consumed hold frees the allowance at once, so a
  // 40-seat purchase completes by paying per order (see the PAID-hold test
  // below). Nobody legitimate needs 100 seats held unpaid at the same time.
  assert.equal(cap.perIpSeatCapForEvent(1_000), 30);
  assert.equal(cap.perIpSeatCapForEvent(50_000), 30);
  assert.equal(cap.perIpSeatCapForEvent(Number.MAX_SAFE_INTEGER), 30);
});

test("the cap never decreases as an event gets bigger", () => {
  let prev = 0;
  for (let n = 0; n <= 3000; n += 7) {
    const c = cap.perIpSeatCapForEvent(n);
    assert.ok(c >= prev, `cap fell from ${prev} to ${c} at supply ${n}`);
    prev = c;
  }
});

test("declared supply sums the series and shrugs off a malformed one", () => {
  assert.equal(cap.declaredSupplyOf([{ totalSupply: 50 }, { totalSupply: 150 }]), 200);
  assert.equal(cap.declaredSupplyOf([]), 0);
  // A bad supply field must not throw or subtract — a seat hold is never
  // refused because of a malformed series.
  assert.equal(
    cap.declaredSupplyOf([
      { totalSupply: 100 },
      { totalSupply: -5 },
      { totalSupply: Number.NaN },
      {},
    ]),
    100,
  );
});

// ---------------------------------------------------------------------------
// The scope — the actual defect
// ---------------------------------------------------------------------------

test("a hold at one event does not consume another event's allowance", async () => {
  const EVENT_A = freshEvent();
  const [SERIES_A] = freshSeries();
  const EVENT_B = freshEvent();
  const [SERIES_B] = freshSeries();
  await hold(EVENT_A, SERIES_A, 10, 10, "buyer-1");

  // Same address, same cap, different event. Before #223 this was refused:
  // heldSeatsByIp() counted every active hold platform-wide.
  const other = await store.reserve(EVENT_B, SERIES_B, 10, supply, 10, undefined, "buyer-2", IP);
  assert.ok(other.ok, "an unrelated event must not be blocked by event A's holds");
});

test("the cap still binds across every series of the SAME event", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  await hold(EVENT_A, GA, 10, 10, "buyer-1");

  // A flood must not be spreadable across tiers of one event.
  const vip = await store.reserve(EVENT_A, VIP, 1, supply, 10, undefined, "buyer-2", IP);
  assert.ok(!vip.ok);
  assert.equal(vip.ok ? null : vip.error, "IpCapExceeded");
});

test("a full advertised order succeeds at the smallest event", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  const tiny = cap.perIpSeatCapForEvent(30);
  const r = await store.reserve(
    EVENT_A, GA, store.RESERVATION_MAX_QTY, supply, tiny, undefined, "buyer-1", IP,
  );
  assert.ok(r.ok, "the first legal max-size order must never be refused");
});

// ---------------------------------------------------------------------------
// Allowance accounting
// ---------------------------------------------------------------------------

test("releasing a hold frees the allowance immediately", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  const id = await hold(EVENT_A, GA, 10, 10, "buyer-1");

  const blocked = await store.reserve(EVENT_A, VIP, 5, supply, 10, undefined, "buyer-2", IP);
  assert.ok(!blocked.ok);

  store.release(id);

  const after = await store.reserve(EVENT_A, VIP, 5, supply, 10, undefined, "buyer-3", IP);
  assert.ok(after.ok, "a released hold must stop counting at once, not at the next GC sweep");
});

test("a PAID hold stops counting, so a shared network is limited in flight, not in total", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  // The load-bearing fact for the family-LAN / pub-wifi case: consuming a
  // reservation frees the allowance, so throughput behind one address is capped
  // only by concurrent unpaid holds — never by how much it buys in total.
  const id = await hold(EVENT_A, GA, 10, 10, "buyer-1");
  assert.ok(store.consume(id), "reservation should consume");

  const next = await store.reserve(EVENT_A, GA, 10, supply, 10, undefined, "buyer-2", IP);
  assert.ok(next.ok, "a paid hold must not keep consuming the network's allowance");
});

test("a request that would cross the cap is refused whole, not trimmed", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  await hold(EVENT_A, GA, 8, 10, "buyer-1");

  const over = await store.reserve(EVENT_A, GA, 5, supply, 10, undefined, "buyer-2", IP);
  assert.ok(!over.ok);
  assert.equal(over.ok ? null : over.error, "IpCapExceeded");

  // ...but the remaining headroom is still usable.
  const fits = await store.reserve(EVENT_A, GA, 2, supply, 10, undefined, "buyer-3", IP);
  assert.ok(fits.ok);
});

test("a caller with no recorded address is not capped by another network's holds", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  // `clientIp()` never returns empty — header-less callers share one bucket. A
  // reservation stored without an ip must not be counted against a real one.
  const anon = await store.reserve(EVENT_A, GA, 10, supply, 10, undefined, "anon", undefined);
  assert.ok(anon.ok);

  const real = await store.reserve(EVENT_A, GA, 10, supply, 10, undefined, "buyer-1", IP);
  assert.ok(real.ok, "an address-less hold must not consume a real address's allowance");
});

test("concurrent reserves on DIFFERENT series of one event cannot exceed the cap", async () => {
  const EVENT_A = freshEvent();
  const [GA, VIP] = freshSeries();
  // The per-series mutex does NOT serialise these — they take different locks.
  // What holds the line is that the cap check and the insert are one
  // synchronous stretch. This fails if anyone puts an `await` between them.
  const results = await Promise.all([
    store.reserve(EVENT_A, GA, 6, supply, 10, undefined, "buyer-1", IP),
    store.reserve(EVENT_A, VIP, 6, supply, 10, undefined, "buyer-2", IP),
  ]);

  const granted = results.filter((r) => r.ok).length;
  assert.equal(granted, 1, "exactly one of two racing 6-seat holds may win under a cap of 10");
  assert.ok(store.heldSeatsByIp(IP, EVENT_A) <= 10, "the cap must never be breached by a race");
});
