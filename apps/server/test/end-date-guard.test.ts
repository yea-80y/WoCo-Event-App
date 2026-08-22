/**
 * Chain-end guard (#294).
 *
 * Properties pinned: the immutable chain end is read ONCE and memoized (the
 * sale-time backstop must cost zero RPCs after warm-up); an EXTENSION past any
 * registered series' chain end refuses with the organiser-facing message; an
 * unverifiable chain refuses the extension rather than allowing it; and the
 * checkout-expiry clamp treats the chain end as a CAP on the editable feed end.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  chainEventEndMs,
  checkEndDateExtension,
  _resetChainEndMemoForTests,
} from "../src/lib/event/end-date-guard.js";
import { checkoutExpiresAt, CHECKOUT_EXPIRES_MIN_S, CHECKOUT_EXPIRES_SKEW_S } from "../src/lib/event/checkout-expiry.js";

const CHAIN = 421614;
const END_SEC = 1_900_000_000;

beforeEach(() => _resetChainEndMemoForTests());

function reader(ends: Record<string, number | null>, calls: string[] = []) {
  return async (id: string) => {
    calls.push(id);
    if (!(id in ends)) throw new Error("rpc down");
    return ends[id];
  };
}

test("the chain end is memoized — the second read costs no RPC", async () => {
  const calls: string[] = [];
  const read = reader({ "0xa": END_SEC }, calls);
  assert.equal(await chainEventEndMs("0xa", CHAIN, read), END_SEC * 1000);
  assert.equal(await chainEventEndMs("0xa", CHAIN, read), END_SEC * 1000);
  assert.equal(calls.length, 1);
});

test("EventNotFound is NOT pinned — a later read may answer", async () => {
  const calls: string[] = [];
  const read = reader({ "0xb": null }, calls);
  assert.equal(await chainEventEndMs("0xb", CHAIN, read), null);
  assert.equal(await chainEventEndMs("0xb", CHAIN, read), null);
  assert.equal(calls.length, 2);
});

test("no registered series — nothing to diverge from, extension allowed", async () => {
  const v = await checkEndDateExtension({
    series: [{}, {}],
    newEndMs: Number.MAX_SAFE_INTEGER,
    chainId: CHAIN,
    read: reader({}),
  });
  assert.deepEqual(v, { ok: true });
});

test("an extension past the earliest registered chain end refuses, with the stable message prefix", async () => {
  const v = await checkEndDateExtension({
    series: [{ onChainEventId: "0xa" }, { onChainEventId: "0xlater" }],
    newEndMs: END_SEC * 1000 + 1,
    chainId: CHAIN,
    read: reader({ "0xa": END_SEC, "0xlater": END_SEC + 9999 }),
  });
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.error.startsWith("endDate cannot extend past the on-chain sales end"));
});

test("an extension at or under every chain end is allowed", async () => {
  const v = await checkEndDateExtension({
    series: [{ onChainEventId: "0xa" }],
    newEndMs: END_SEC * 1000,
    chainId: CHAIN,
    read: reader({ "0xa": END_SEC }),
  });
  assert.deepEqual(v, { ok: true });
});

test("an unreadable chain refuses the extension — never allows unverifiable", async () => {
  const v = await checkEndDateExtension({
    series: [{ onChainEventId: "0xdead" }],
    newEndMs: 1,
    chainId: CHAIN,
    read: reader({}),
  });
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.error.startsWith("Could not verify the on-chain sales end"));
});

// ── checkout-expiry chain cap ────────────────────────────────────────────────

const NOW_MS = new Date("2026-08-22T12:00:00Z").getTime();
const NOW_S = Math.floor(NOW_MS / 1000);
const HOUR_S = 3600;
const iso = (sFromNow: number) => new Date(NOW_MS + sFromNow * 1000).toISOString();

test("a chain end below the feed end caps the session — an extended endDate cannot stretch it", async () => {
  const got = checkoutExpiresAt(
    { startDate: iso(-HOUR_S), endDate: iso(20 * HOUR_S) }, // feed says 20h (extended)
    NOW_MS,
    NOW_MS + 2 * HOUR_S * 1000, // chain says 2h
  );
  assert.equal(got, NOW_S + 2 * HOUR_S);
});

test("a chain end above the feed end changes nothing — the tighter bound wins", async () => {
  const got = checkoutExpiresAt(
    { startDate: iso(-HOUR_S), endDate: iso(2 * HOUR_S) },
    NOW_MS,
    NOW_MS + 20 * HOUR_S * 1000,
  );
  assert.equal(got, NOW_S + 2 * HOUR_S);
});

test("an unparseable feed with a known chain end still clamps to the chain", async () => {
  const got = checkoutExpiresAt({ startDate: "garbage" }, NOW_MS, NOW_MS + 3 * HOUR_S * 1000);
  assert.equal(got, NOW_S + 3 * HOUR_S);
});

test("a chain end inside Stripe's floor clamps up to the floor + skew, never refuses", async () => {
  const got = checkoutExpiresAt(
    { startDate: iso(-HOUR_S), endDate: iso(20 * HOUR_S) },
    NOW_MS,
    NOW_MS + 5 * 60 * 1000, // chain end 5 min away
  );
  assert.equal(got, NOW_S + CHECKOUT_EXPIRES_MIN_S + CHECKOUT_EXPIRES_SKEW_S);
});

test("no chain end (null) preserves the feed-only behaviour", async () => {
  const got = checkoutExpiresAt({ startDate: iso(-HOUR_S), endDate: iso(2 * HOUR_S) }, NOW_MS, null);
  assert.equal(got, NOW_S + 2 * HOUR_S);
});
