/**
 * Payouts screen arithmetic and labelling.
 *
 * This is the screen that tells an organiser where their money is, so the bar is
 * the money bar, not the UI bar: a total that is off by a rounding error, a sale
 * filed under the wrong event, or a release date that reads a day early is a
 * support ticket about missing money.
 *
 * The guarantees under test:
 *   1. Totals are summed in integer minor units and only ever divided at the
 *      formatting edge — including for currencies that are not 2-decimal.
 *   2. A converted charge is counted in the currency it SETTLED in, matching
 *      what the server puts in `heldByCurrency`, so tiles equal the rows.
 *   3. Sales group under their event/shop, ordered by which money lands next.
 *   4. Release labels say the right thing on the boundaries (today, tomorrow,
 *      already due) and never show a negative countdown.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { PayoutEntryView, PayoutsResponse } from "@woco/shared";
import {
  classifyFailure,
  currencyDigits,
  formatMinor,
  sumByCurrency,
  entryCurrency,
  entryAmount,
  isConverted,
  groupPayouts,
  summarisePayouts,
  daysUntil,
  releaseCountdown,
  entryStatusLabel,
} from "../src/lib/creator/payouts/payouts-model.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function entry(over: Partial<PayoutEntryView> = {}): PayoutEntryView {
  return {
    sessionId: "cs_test_1",
    kind: "event",
    eventId: "evt_a",
    currency: "gbp",
    settlementCurrency: null,
    grossAmount: 2500,
    netAmount: 2300,
    netIsFinal: false,
    recordedAt: "2026-07-20T10:00:00.000Z",
    releaseAfter: "2026-08-10T10:00:00.000Z",
    status: "held",
    releasedAt: null,
    payoutId: null,
    forcedByCeiling: false,
    voidReason: null,
    ...over,
  };
}

// ── 0. Failures ────────────────────────────────────────────────────────────

test("a failed load names something the organiser can act on", () => {
  // Every branch must produce a sentence, never a stack or a status code.
  for (const input of [
    new Error("Not authenticated"),
    new TypeError("Failed to fetch"),
    "HTTP 500: <html>Bad Gateway</html>",
    { weird: true },
    undefined,
  ]) {
    const f = classifyFailure(input);
    assert.ok(f.message.length > 0);
    assert.doesNotMatch(f.message, /HTTP \d|<html|undefined/i, `leaked internals: ${f.message}`);
  }
});

test("an expired session asks for sign-in; a dead connection asks for the network", () => {
  assert.equal(classifyFailure(new Error("Not authenticated")).kind, "auth");
  assert.equal(classifyFailure("HTTP 401: Unauthorized").kind, "auth");
  assert.equal(classifyFailure(new TypeError("Failed to fetch")).kind, "network");
  assert.equal(classifyFailure("NetworkError when attempting to fetch resource").kind, "network");
});

test("anything else is a server problem, with the raw text kept for the console only", () => {
  const f = classifyFailure("HTTP 500: Internal Server Error");
  assert.equal(f.kind, "server");
  assert.equal(f.detail, "HTTP 500: Internal Server Error");
  assert.notEqual(f.message, f.detail);
});

test("the envelope's machine code decides auth, whatever the text says (#256)", () => {
  // These are real verify-delegation reason strings. None contains an
  // AUTH_HINTS substring, so before the code was consulted they classified as
  // `server` — "try again in a moment", advice that can never work.
  for (const text of ["Invalid delegation", "Invalid host: evil.example", "Verification failed"]) {
    assert.equal(classifyFailure(text).kind, "server", `hint fallback moved: ${text}`);
    assert.equal(classifyFailure(text, "SESSION_INVALID").kind, "auth", `code ignored: ${text}`);
  }
  // A non-auth code changes nothing — the text hints still decide.
  assert.equal(classifyFailure("HTTP 500: boom", "SOMETHING_ELSE").kind, "server");
  assert.equal(classifyFailure("HTTP 401: Unauthorized", "SOMETHING_ELSE").kind, "auth");
});

// ── 1. Money ───────────────────────────────────────────────────────────────

test("currency exponents come from Intl, not an assumption of 2 decimals", () => {
  assert.equal(currencyDigits("gbp"), 2);
  assert.equal(currencyDigits("usd"), 2);
  assert.equal(currencyDigits("jpy"), 0);
  // An unknown code must still render rather than throw.
  assert.equal(currencyDigits("zzz"), 2);
});

test("minor units format as money for 2-decimal and zero-decimal currencies", () => {
  assert.equal(formatMinor(123456, "gbp", "en-GB"), "£1,234.56");
  // 1234 JPY is 1,234 yen — dividing by 100 here would show 12 and understate
  // the organiser's balance by two orders of magnitude. (en-GB writes the
  // symbol "JP¥" to disambiguate it from other yen/yuan currencies.)
  assert.equal(formatMinor(1234, "jpy", "en-GB"), "JP¥1,234");
  assert.equal(formatMinor(0, "gbp", "en-GB"), "£0.00");
});

test("a sum of many small amounts stays exact — integers in, one division out", () => {
  // 0.01 × 3 in floats is 0.030000000000000006; in minor units it is 3.
  const pennies = Array.from({ length: 3 }, () => entry({ netAmount: 1, grossAmount: 1 }));
  assert.deepEqual(sumByCurrency(pennies), { gbp: 3 });
  assert.equal(formatMinor(3, "gbp", "en-GB"), "£0.03");
});

test("net is preferred over gross, and gross stands in until the sweep resolves net", () => {
  assert.equal(entryAmount(entry({ netAmount: 2300, grossAmount: 2500 })), 2300);
  assert.equal(entryAmount(entry({ netAmount: null, grossAmount: 2500 })), 2500);
});

test("a converted charge counts in its settlement currency, not the presentment one", () => {
  const converted = entry({ currency: "usd", settlementCurrency: "gbp", netAmount: 1800 });
  assert.equal(entryCurrency(converted), "gbp");
  assert.equal(isConverted(converted), true);
  assert.equal(isConverted(entry({ currency: "gbp", settlementCurrency: "gbp" })), false);

  assert.deepEqual(
    sumByCurrency([converted, entry({ currency: "gbp", netAmount: 2300 })]),
    { gbp: 4100 },
  );
});

test("currencies are totalled separately — never added across", () => {
  const totals = sumByCurrency([
    entry({ currency: "gbp", netAmount: 1000 }),
    entry({ currency: "eur", netAmount: 2000 }),
    entry({ currency: "gbp", netAmount: 500 }),
  ]);
  assert.deepEqual(totals, { gbp: 1500, eur: 2000 });
});

// ── 2. Grouping ────────────────────────────────────────────────────────────

test("sales group by event, shop orders group under their shop", () => {
  const groups = groupPayouts(
    [
      entry({ sessionId: "a", eventId: "evt_a" }),
      entry({ sessionId: "b", eventId: "evt_b", releaseAfter: "2026-08-05T00:00:00.000Z" }),
      entry({ sessionId: "c", kind: "shop", eventId: undefined, shopId: "shop_1" }),
      entry({ sessionId: "d", kind: "shop", eventId: undefined, shopId: "shop_1" }),
    ],
    (kind, id) => (id === "evt_a" ? "Summer Sessions" : undefined),
  );

  assert.equal(groups.length, 3);
  const byKey = new Map(groups.map((g) => [g.key, g]));
  assert.equal(byKey.get("event:evt_a")!.title, "Summer Sessions");
  assert.equal(byKey.get("shop:shop_1")!.entries.length, 2);
  // No title known — fall back to something identifiable, never blank.
  assert.match(byKey.get("event:evt_b")!.title, /evt_b/);
});

test("groups order by which money lands soonest; settled history sinks below", () => {
  const groups = groupPayouts([
    entry({ sessionId: "late", eventId: "evt_late", releaseAfter: "2026-09-01T00:00:00.000Z" }),
    entry({
      sessionId: "done",
      eventId: "evt_done",
      status: "released",
      releasedAt: "2026-07-25T00:00:00.000Z",
      recordedAt: "2026-07-01T00:00:00.000Z",
    }),
    entry({ sessionId: "soon", eventId: "evt_soon", releaseAfter: "2026-08-03T00:00:00.000Z" }),
  ]);

  assert.deepEqual(groups.map((g) => g.key), ["event:evt_soon", "event:evt_late", "event:evt_done"]);
  assert.equal(groups[2].nextReleaseAt, null);
});

test("a group totals held and released separately and flags an early release", () => {
  const [group] = groupPayouts([
    entry({ sessionId: "1", netAmount: 1000, status: "held" }),
    entry({ sessionId: "2", netAmount: 2000, status: "released", netIsFinal: true, forcedByCeiling: true }),
    // Void money belongs to neither total — it went back to the buyer.
    entry({ sessionId: "3", netAmount: 4000, status: "void", voidReason: "full refund" }),
  ]);

  assert.deepEqual(group.heldByCurrency, { gbp: 1000 });
  assert.deepEqual(group.releasedByCurrency, { gbp: 2000 });
  assert.equal(group.hasForcedRelease, true);
  assert.equal(group.entries.length, 3);
});

test("a sale with no event or shop id still appears — money is never dropped", () => {
  const groups = groupPayouts([entry({ eventId: undefined, shopId: undefined })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "other");
  assert.deepEqual(groups[0].heldByCurrency, { gbp: 2300 });
});

// ── 3. Summary ─────────────────────────────────────────────────────────────

test("held totals are the server's; released totals are summed per currency", () => {
  const res: PayoutsResponse = {
    schedule: "manual",
    heldByCurrency: { gbp: 2300 },
    nextReleaseAt: "2026-08-10T10:00:00.000Z",
    entries: [
      entry({ sessionId: "h", status: "held" }),
      entry({ sessionId: "r", status: "released", netIsFinal: true, netAmount: 5000 }),
      entry({ sessionId: "r2", status: "released", netIsFinal: true, netAmount: 100, currency: "eur" }),
    ],
  };
  const s = summarisePayouts(res);
  assert.deepEqual(s.heldByCurrency, { gbp: 2300 });
  assert.deepEqual(s.releasedByCurrency, { gbp: 5000, eur: 100 });
  assert.equal(s.heldCount, 1);
  assert.equal(s.releasedCount, 2);
});

test("held money reads as an estimate while any net is unresolved", () => {
  const base: PayoutsResponse = {
    schedule: "manual",
    heldByCurrency: { gbp: 2300 },
    nextReleaseAt: null,
    entries: [entry({ status: "held", netIsFinal: false })],
  };
  assert.equal(summarisePayouts(base).heldIsEstimate, true);

  // Nothing held at all — there is no estimate to caveat.
  assert.equal(
    summarisePayouts({ ...base, entries: [entry({ status: "released", netIsFinal: true })] }).heldIsEstimate,
    false,
  );
});

// ── 4. Dates ───────────────────────────────────────────────────────────────

/**
 * Date maths counts the VIEWER'S calendar days, so these tests pin the
 * timezone explicitly. Node re-reads process.env.TZ on Linux (dev + CI here);
 * restore it so the ambient-TZ tests below stay honest.
 */
function withTZ(tz: string, fn: () => void): void {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

test("day counts are calendar days, so a few hours never reads as a whole day", () => {
  withTZ("UTC", () => {
    assert.equal(daysUntil("2026-08-01T23:59:00.000Z", NOW), 0);
    assert.equal(daysUntil("2026-08-02T00:01:00.000Z", NOW), 1);
    assert.equal(daysUntil("2026-08-10T10:00:00.000Z", NOW), 9);
    assert.equal(daysUntil("not-a-date", NOW), null);
  });
});

test("day counts follow the organiser's wall clock, not UTC", () => {
  // NOW is 2026-08-01T12:00Z. In Auckland (UTC+12) that is already 2 Aug, so a
  // release at 14:00Z the "same" UTC day lands tomorrow-for-UTC but TODAY for
  // the person reading the screen.
  withTZ("Pacific/Auckland", () => {
    assert.equal(daysUntil("2026-08-01T14:00:00.000Z", NOW), 0);
    assert.equal(releaseCountdown("2026-08-01T14:00:00.000Z", NOW), "today");
  });
  // In Los Angeles (UTC-7) NOW is 05:00 on 1 Aug, and a release at 02:00Z on
  // 2 Aug is 19:00 the same evening — "today", where UTC maths said "tomorrow".
  withTZ("America/Los_Angeles", () => {
    assert.equal(daysUntil("2026-08-02T02:00:00.000Z", NOW), 0);
    assert.equal(releaseCountdown("2026-08-02T02:00:00.000Z", NOW), "today");
  });
});

test("release countdowns speak plainly at every boundary", () => {
  withTZ("UTC", () => {
    assert.equal(releaseCountdown("2026-08-01T18:00:00.000Z", NOW), "today");
    assert.equal(releaseCountdown("2026-08-02T09:00:00.000Z", NOW), "tomorrow");
    assert.equal(releaseCountdown("2026-08-10T10:00:00.000Z", NOW), "in 9 days");
    assert.equal(releaseCountdown("2026-09-30T10:00:00.000Z", NOW, "en-GB"), "on 30 Sept");
  });
});

test("a release date that has passed reads as in-flight, never as negative days", () => {
  const label = releaseCountdown("2026-07-28T10:00:00.000Z", NOW);
  assert.equal(label, "releasing now");
  assert.doesNotMatch(label, /-/);
});

test("row labels distinguish held, paid out, early release and refunded", () => {
  assert.equal(entryStatusLabel(entry({ status: "held" }), NOW).tone, "held");
  withTZ("UTC", () => {
    assert.equal(
      entryStatusLabel(entry({ status: "held", releaseAfter: "2026-08-02T00:00:00.000Z" }), NOW).detail,
      "Releases tomorrow",
    );
  });

  const paid = entryStatusLabel(
    entry({ status: "released", releasedAt: "2026-07-30T09:00:00.000Z" }),
    NOW,
    "en-GB",
  );
  assert.equal(paid.tone, "released");
  assert.equal(paid.detail, "Released on 30 Jul");

  // The exposed tail (PAYOUTS §3.1) must never look like an ordinary payout.
  const early = entryStatusLabel(
    entry({ status: "released", releasedAt: "2026-07-30T09:00:00.000Z", forcedByCeiling: true }),
    NOW,
    "en-GB",
  );
  assert.equal(early.detail, "Released early on 30 Jul");

  const refunded = entryStatusLabel(entry({ status: "void", voidReason: "full refund" }), NOW);
  assert.equal(refunded.tone, "void");
  assert.equal(refunded.detail, "full refund");
});
