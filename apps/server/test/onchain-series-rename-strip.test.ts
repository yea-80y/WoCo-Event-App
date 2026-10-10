/**
 * #435 — the on-chain-id strip must not be dodgeable by renaming a series.
 *
 * The #424 strip compares the feed's `onChainEventId` against the record at
 * `${feed.eventId}|${s.seriesId}`. #426 pinned `feed.eventId` to the id the feed
 * was read under, but `s.seriesId` is a field the creator chooses inside their
 * own signed SOC. Rename it and the lookup MISSES — and a miss is
 * indistinguishable from "no record", which passes the id straight through.
 *
 * The fix asks the question from the other end: who is this id bound to? That
 * does not care what the creator called the series. It needs `findKeyBoundTo` on
 * the read path, which is why it is now an O(1) reverse-index read rather than
 * the linear scan documented as cold-path-only.
 *
 * These tests pin BOTH halves: the index agrees with `byEventSeries` at every
 * point a writer can leave it (load, first write, idempotent replay), and the
 * strip fires on a renamed series while leaving an honest one alone.
 *
 * On `manifestRef`: deliberately absent from most feeds here. A series with one
 * and no id enters the tier-3 fill, which awaits a chain reconcile — off-limits
 * in a unit test. The strip itself runs before that and does not look at it.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventFeed } from "@woco/shared";

/** Pre-existing bindings, written to disk BEFORE the module loads. */
const LOADED = {
  "evt-loaded-a|ser-loaded-a": `0x${"1a".repeat(32)}`,
  "evt-loaded-b|ser-loaded-b": `0x${"2b".repeat(32)}`,
};

let dir: string;
let originalCwd: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registry: any;

before(async () => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "woco-435-"));
  mkdirSync(join(dir, ".data"), { recursive: true });
  writeFileSync(join(dir, ".data", "onchain-events.json"), JSON.stringify(LOADED));
  // The store captures `join(process.cwd(), ".data")` at module load, so the
  // chdir must happen before the first import.
  process.chdir(dir);
  registry = await import("../src/lib/event/onchain-registry.js");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The reverse index is module-private, so it is asserted through its only
 * observable: every binding the forward map reports must be findable by its id,
 * and nothing else must be.
 */
function assertIndexAgrees(): void {
  const entries = registry.getAllResolutionEntries() as Array<{
    onChainEventId: string;
    wocoEventId: string;
    seriesId: string;
  }>;
  assert.ok(entries.length > 0, "nothing to compare — the forward map is empty");
  for (const e of entries) {
    assert.equal(
      registry.findKeyBoundTo(e.onChainEventId),
      `${e.wocoEventId}|${e.seriesId}`,
      `reverse index disagrees for ${e.onChainEventId}`,
    );
    // Case must not decide the answer: the feed's hex casing is the creator's.
    assert.equal(
      registry.findKeyBoundTo("0x" + e.onChainEventId.slice(2).toUpperCase()),
      `${e.wocoEventId}|${e.seriesId}`,
    );
  }
  assert.equal(
    registry.findKeyBoundTo(`0x${"ff".repeat(32)}`),
    null,
    "an unbound id must not report a binding",
  );
}

/** Minimal feed shaped like the money path reads it. */
function feedWith(
  eventId: string,
  seriesId: string,
  onChainEventId?: string,
  manifestRef?: string,
): EventFeed {
  return {
    eventId,
    series: [
      {
        seriesId,
        ...(manifestRef ? { manifestRef } : {}),
        ...(onChainEventId ? { onChainEventId } : {}),
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as EventFeed;
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

test("the reverse index agrees with the persisted map straight after LOAD", () => {
  // If the index were built only by the writer, every binding from before a
  // restart would answer `findKeyBoundTo` with null — which is exactly the
  // answer that lets a stranger's id through the strip.
  assertIndexAgrees();
  for (const [k, id] of Object.entries(LOADED)) {
    assert.equal(registry.findKeyBoundTo(id), k);
  }
});

test("the reverse index agrees after a first write, and after an idempotent replay", () => {
  const eventId = "evt-write";
  const seriesId = "ser-write";
  const id = `0x${"3c".repeat(32)}`;

  registry.recordOnChainEventId(eventId, seriesId, id);
  assert.equal(registry.findKeyBoundTo(id), `${eventId}|${seriesId}`);
  assertIndexAgrees();

  // register-once replays a landed registration to heal a failed feed write; the
  // writer returns early there, so the index must already be right — a replay
  // that quietly rebuilt it would hide an index the first write never filled.
  registry.recordOnChainEventId(eventId, seriesId, id);
  registry.recordOnChainEventId(eventId, seriesId, "0x" + id.slice(2).toUpperCase());
  assert.equal(registry.findKeyBoundTo(id), `${eventId}|${seriesId}`);
  assertIndexAgrees();
});

test("a REFUSED write leaves the index untouched", () => {
  // A rebind throws before either map is written. If the index had been updated
  // first, the victim's id would point at the attacker's key and the strip below
  // would then drop the VICTIM's own feed.
  const id = LOADED["evt-loaded-a|ser-loaded-a"];
  assert.throws(
    () => registry.recordOnChainEventId("evt-thief", "ser-thief", id),
    (err: Error) => err.name === "RegistrationRebindError",
  );
  assert.equal(registry.findKeyBoundTo(id), "evt-loaded-a|ser-loaded-a");
  assertIndexAgrees();
});

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

test("#435: a RENAMED series carrying an id bound elsewhere has it STRIPPED", async () => {
  // The defect in one feed. The server registered (evt, ser-real) as OURS. The
  // creator re-signs the same event with the series renamed and still pointing at
  // OURS: the record lookup at `evt|ser-renamed` misses, so the old strip passed
  // the id through and every non-checkout consumer read it.
  const eventId = "evt-rename";
  const OURS = `0x${"4d".repeat(32)}`;
  registry.recordOnChainEventId(eventId, "ser-real", OURS);

  const out = await registry.applyOnChainEventIds(feedWith(eventId, "ser-renamed", OURS));

  assert.equal(
    out.series[0].onChainEventId,
    undefined,
    "a renamed series kept an id bound to another key — this is #435",
  );
});

test("#435: the rename works ACROSS events too — an id bound to another organiser", async () => {
  // The same shape with nothing in common but the id: the attacker's own event,
  // their own series name, the victim's on-chain event. Nothing about the key
  // matches, which is precisely why a key-based lookup cannot see it.
  const VICTIM = `0x${"5e".repeat(32)}`;
  registry.recordOnChainEventId("evt-victim-435", "ser-victim-435", VICTIM);

  const out = await registry.applyOnChainEventIds(
    feedWith("evt-attacker-435", "ser-attacker-435", VICTIM),
  );

  assert.equal(out.series[0].onChainEventId, undefined, "a foreign binding survived the strip");
});

test("#435: a series carrying its OWN correctly-bound id is untouched", async () => {
  const eventId = "evt-honest-435";
  const seriesId = "ser-honest-435";
  const OURS = `0x${"6f".repeat(32)}`;
  registry.recordOnChainEventId(eventId, seriesId, OURS);

  const out = await registry.applyOnChainEventIds(feedWith(eventId, seriesId, OURS));

  assert.equal(out.series[0].onChainEventId, OURS, "an honest feed was stripped");
});

test("#435: the honest case is case-insensitive — hex casing is not a forgery", async () => {
  const eventId = "evt-case-435";
  const seriesId = "ser-case-435";
  const OURS = `0x${"7a".repeat(32)}`;
  registry.recordOnChainEventId(eventId, seriesId, OURS);

  const upper = "0x" + OURS.slice(2).toUpperCase();
  const out = await registry.applyOnChainEventIds(feedWith(eventId, seriesId, upper));

  assert.ok(out.series[0].onChainEventId, "a case difference was read as a rename");
});

test("DOCUMENTED LIMIT: an id bound to NOBODY is still not stripped here", async () => {
  // Out of scope by decision, not by omission: the server has no record to
  // contradict, so the answer lives with the consumers that read the record
  // rather than the field — delete-safety takes its count at
  // `lookupOnChainEventId`, and the checkout carries its own chain-backed check.
  // If this ever starts passing, both of those comments are stale.
  const out = await registry.applyOnChainEventIds(
    feedWith("evt-unknown-435", "ser-unknown-435", `0x${"8b".repeat(32)}`),
  );
  assert.equal(
    out.series[0].onChainEventId,
    `0x${"8b".repeat(32)}`,
    "behaviour changed — update delete-safety.ts and the LIMITS note in onchain-registry.ts",
  );
});
