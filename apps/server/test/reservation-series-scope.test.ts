/**
 * Reservation reads are keyed by (event, series), not series alone (#377).
 *
 * The store used to match on `seriesId` by itself. That is sound ONLY if series
 * ids are globally unique — true in practice, because both client mint sites
 * emit `crypto.randomUUID()`, but never enforced: `isValidSeriesId` is a shape
 * check (`/^[0-9a-z-]{8,64}$/`) that accepts another event's id perfectly well,
 * and series ids are public in the event feed.
 *
 * So these tests do the thing a client is not supposed to do — declare two
 * events sharing one series id — and assert the store keeps them apart. They
 * fail against the pre-#377 code, which is the point: the invariant is now in
 * the code rather than in a convention about how ids happen to be minted.
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

/** The id both events declare — the collision under test. */
const SHARED = "shared-series-id";

const VICTIM_IP = "203.0.113.10";
const ATTACKER_IP = "198.51.100.20";

/** Generous cap — these tests are about series scope, not the per-IP cap. */
const CAP = 30;

let seq = 0;
const freshEvent = (): string => `event-${++seq}`;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-series-scope-test-")));
  store = await import("../src/lib/event/reservation-store.js");
});

test("heldFor does not count a colliding series id at another event", async () => {
  const victim = freshEvent();
  const attacker = freshEvent();

  const held = await store.reserve(
    attacker, SHARED, 10, async () => 1000, CAP, undefined, "attacker", ATTACKER_IP,
  );
  assert.ok(held.ok);

  assert.equal(store.heldFor(attacker, SHARED), 10, "the attacker's own event sees its holds");
  assert.equal(store.heldFor(victim, SHARED), 0, "the victim's event must see none of them");
});

test("a colliding event cannot shrink the victim's availability — the #377 attack", async () => {
  const victim = freshEvent();
  const attacker = freshEvent();

  // The attacker registers their own event declaring the victim's public series
  // id, then holds every seat they can on it.
  for (let i = 0; i < 3; i++) {
    const r = await store.reserve(
      attacker, SHARED, 10, async () => 1000, CAP, undefined, `attacker-${i}`, ATTACKER_IP,
    );
    assert.ok(r.ok, "attacker hold should succeed on their own event");
  }
  assert.equal(store.heldFor(attacker, SHARED), 30);

  // The victim's series has 10 real seats. Pre-#377, `heldFor(SHARED)` returned
  // 30, so realAvailable was max(0, 10 - 30) = 0 and this returned
  // InsufficientSeats — sold out, with nothing bought and nothing paid.
  const buyer = await store.reserve(
    victim, SHARED, 10, async () => 10, CAP, undefined, "real-buyer", VICTIM_IP,
  );
  assert.ok(buyer.ok, "a real buyer must not be locked out by another event's holds");
});

test("the victim's OWN holds still count against the victim's availability", async () => {
  // The event filter must not become a way to oversell: same event, same series
  // still subtracts.
  const victim = freshEvent();

  const first = await store.reserve(
    victim, SHARED, 8, async () => 10, CAP, undefined, "buyer-1", VICTIM_IP,
  );
  assert.ok(first.ok);

  const second = await store.reserve(
    victim, SHARED, 5, async () => 10, CAP, undefined, "buyer-2", ATTACKER_IP,
  );
  assert.ok(!second.ok, "only 2 seats remain — 5 must be refused");
  assert.equal(second.ok ? null : second.error, "InsufficientSeats");
  assert.equal(second.ok ? null : second.available, 2);
});

test("the clientKey dedup does not reach across events", async () => {
  // The return-existing path matched (seriesId, clientKey, quantity). With a
  // colliding id it handed back a hold belonging to a DIFFERENT event, so the
  // caller believed it held a seat it did not have.
  const eventA = freshEvent();
  const eventB = freshEvent();

  const a = await store.reserve(
    eventA, SHARED, 4, async () => 100, CAP, undefined, "same-browser", VICTIM_IP,
  );
  assert.ok(a.ok);

  const b = await store.reserve(
    eventB, SHARED, 4, async () => 100, CAP, undefined, "same-browser", VICTIM_IP,
  );
  assert.ok(b.ok);
  assert.notEqual(
    b.ok && b.reservation.id, a.ok && a.reservation.id,
    "a hold at event B must be its own reservation, not event A's handed back",
  );
  assert.equal(b.ok ? b.reservation.eventId : null, eventB);

  // Both survive: neither expired the other.
  assert.equal(store.heldFor(eventA, SHARED), 4);
  assert.equal(store.heldFor(eventB, SHARED), 4);
});

test("a hold at one event is not expired by a same-clientKey hold at another", async () => {
  // The dedup loop expires the buyer's prior holds before allocating. Scoped to
  // seriesId alone, buying at event B would silently release their seat at
  // event A.
  const eventA = freshEvent();
  const eventB = freshEvent();

  const a = await store.reserve(
    eventA, SHARED, 3, async () => 100, CAP, undefined, "browser-x", VICTIM_IP,
  );
  assert.ok(a.ok);
  const aId = a.ok ? a.reservation.id : "";

  // Different quantity, so this takes the dedup path rather than return-existing.
  const b = await store.reserve(
    eventB, SHARED, 7, async () => 100, CAP, undefined, "browser-x", VICTIM_IP,
  );
  assert.ok(b.ok);

  const stillThere = store.getReservation(aId);
  assert.ok(stillThere, "event A's reservation must still exist");
  assert.equal(store.heldFor(eventA, SHARED), 3, "event A's hold must survive untouched");
});

test("replacing a reservation cannot target one belonging to another event", async () => {
  const eventA = freshEvent();
  const eventB = freshEvent();

  const a = await store.reserve(
    eventA, SHARED, 5, async () => 100, CAP, undefined, "browser-a", VICTIM_IP,
  );
  assert.ok(a.ok);
  const aId = a.ok ? a.reservation.id : "";

  // Ask event B to "replace" event A's reservation id.
  const b = await store.reserve(
    eventB, SHARED, 5, async () => 100, CAP, aId, "browser-b", ATTACKER_IP,
  );
  assert.ok(b.ok);

  assert.equal(store.heldFor(eventA, SHARED), 5, "event A's hold must not have been expired");
});
