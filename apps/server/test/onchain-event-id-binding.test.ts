/**
 * #424 — a creator-supplied `onChainEventId` must not be trusted.
 *
 * For Phase B events the event detail feed is the CREATOR's client-signed SOC:
 * the server holds no key for it and the client merges `onChainEventId` in
 * itself (lib/event/service.ts). That field is therefore untrusted input, and
 * it used to be passed through untouched whenever it was present.
 *
 * The attack it enabled: a creator points their series at ANOTHER organiser's
 * on-chain event. An authorised sponsor may append slots to any event, so every
 * sale minted out of the victim's supply while the payment landed with the
 * attacker — and the buyer received a genuine ticket to the victim's event.
 *
 * `byEventSeries` is the server's own registration record, written by
 * `recordOnChainEventId` and backed by `.data`. Where it disagrees with the
 * feed, the feed is wrong.
 *
 * It is NOT beyond a creator's reach, though: the tier-3 fill resolves an id
 * from the creator-supplied `manifestRef` and persists it as a record, so a
 * creator naming another series' manifestRef could otherwise have the server
 * write the forged binding itself. `findKeyBoundTo` is the guard against that,
 * and is tested here directly.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventFeed } from "@woco/shared";

const OURS   = `0x${"a1".repeat(32)}`;
const THEIRS = `0x${"b2".repeat(32)}`;
const MANIFEST = `0x${"c3".repeat(32)}`;

let dir: string;
let originalCwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-424-"));
  // The store captures `join(process.cwd(), ".data")` at module load, so the
  // chdir must happen before the first import.
  process.chdir(dir);
  registry = await import("../src/lib/event/onchain-registry.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal feed shaped like the money path reads it. */
function feedWith(eventId: string, seriesId: string, onChainEventId?: string): EventFeed {
  return {
    eventId,
    series: [
      {
        seriesId,
        manifestRef: MANIFEST,
        ...(onChainEventId ? { onChainEventId } : {}),
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as EventFeed;
}

test("a feed id contradicting the server's registration record is DROPPED", async () => {
  const eventId = "evt-attacker";
  const seriesId = "ser-attacker";

  // The server registered this series and knows the real id.
  registry.recordOnChainEventId(eventId, seriesId, OURS);

  // The creator re-signs their feed pointing at someone else's event.
  const feed = feedWith(eventId, seriesId, THEIRS);
  const out = await registry.applyOnChainEventIds(feed);

  assert.notEqual(
    out.series[0].onChainEventId,
    THEIRS,
    "the forged id survived — this is #424",
  );
  // Dropped, then re-filled from the server's own record: either outcome is
  // safe, but it must never be the attacker's value.
  assert.ok(
    out.series[0].onChainEventId === OURS || !out.series[0].onChainEventId,
    "series must resolve to the server's id or to nothing",
  );
});

test("a forged id is HEALED to the server's own, not merely dropped", async () => {
  // Naming what the code actually does. "Drop" suggests the series ends up
  // unset; in practice the fill immediately re-resolves it from the same
  // record, so the outcome is a correction. Pinned deterministically because
  // the first version of these tests allowed either outcome and so did not
  // distinguish a working heal from a silent no-op.
  const eventId = "evt-heal";
  const seriesId = "ser-heal";

  registry.recordOnChainEventId(eventId, seriesId, OURS);
  const out = await registry.applyOnChainEventIds(feedWith(eventId, seriesId, THEIRS));

  assert.equal(out.series[0].onChainEventId, OURS, "forged id was not healed to the recorded one");
});

test("an on-chain event already bound to one series is reported as taken", async () => {
  // The decision behind the tier-3 re-bind guard. The record this tier trusts
  // is writable by a creator through that fill: name another series'
  // manifestRef, omit onChainEventId, and the server would resolve the victim's
  // id and persist it as its own record — after which the comparison above
  // agrees with the forgery forever. One on-chain event belongs to one series.
  //
  // Tested against the predicate rather than through applyOnChainEventIds,
  // because reaching the fill needs `byManifestRef`, which only a chain walk
  // populates. An earlier version of this test drove the full function and
  // asserted the id was NOT re-bound — it passed for the wrong reason (nothing
  // resolved at all), which is no test.
  const bound = `0x${"e5".repeat(32)}`;
  registry.recordOnChainEventId("evt-victim", "ser-victim", bound);

  assert.equal(
    registry.findKeyBoundTo(bound),
    "evt-victim|ser-victim",
    "an already-bound event was not reported as taken",
  );
  assert.equal(
    registry.findKeyBoundTo(`0x${"f6".repeat(32)}`),
    null,
    "an unbound event must not report a false binding",
  );
});

test("a feed id that AGREES with the record is left alone", async () => {
  const eventId = "evt-honest";
  const seriesId = "ser-honest";

  registry.recordOnChainEventId(eventId, seriesId, OURS);
  const out = await registry.applyOnChainEventIds(feedWith(eventId, seriesId, OURS));

  assert.equal(out.series[0].onChainEventId, OURS, "an honest feed was disturbed");
});

test("comparison is case-insensitive — mixed-case hex is not a false positive", async () => {
  const eventId = "evt-case";
  const seriesId = "ser-case";

  registry.recordOnChainEventId(eventId, seriesId, OURS);
  const upper = "0x" + OURS.slice(2).toUpperCase();
  const out = await registry.applyOnChainEventIds(feedWith(eventId, seriesId, upper));

  assert.ok(out.series[0].onChainEventId, "a case difference was treated as a forgery");
});

test("an absent id is still filled from the record — the fill path is intact", async () => {
  const eventId = "evt-absent";
  const seriesId = "ser-absent";

  registry.recordOnChainEventId(eventId, seriesId, OURS);
  const out = await registry.applyOnChainEventIds(feedWith(eventId, seriesId));

  assert.equal(out.series[0].onChainEventId, OURS);
});

test("DOCUMENTED LIMIT: with no server record, the feed's id is not checked here", async () => {
  // This is why the money path carries a second, chain-backed check
  // (routes/stripe.ts compares the on-chain manifestRef against the series').
  // Pinned so the limitation is deliberate and visible rather than assumed
  // away — if this ever starts passing, the comment above it is stale.
  const out = await registry.applyOnChainEventIds(feedWith("evt-unknown", "ser-unknown", THEIRS));
  assert.equal(
    out.series[0].onChainEventId,
    THEIRS,
    "behaviour changed — update the money-path check and this comment",
  );
});
