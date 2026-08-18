/**
 * The premise that makes the skipped index write sound (#323).
 *
 * `recordRide` no longer calls `addToSubjectIndex` when `liveVisibility`
 * returned a partition, because a non-null visibility already MEANS "that
 * partition's index contains this subject". That removes a whole feed read —
 * including a probe past the feed's latest version, which is a bee network
 * search for a chunk that does not exist, the most expensive read on Swarm.
 *
 * The skip is only correct while the premise holds, and the failure mode if it
 * ever stops holding is silent: a subject that never gets indexed, costing
 * enumeration on the rider's next device, with nothing on screen to notice.
 * The lifetime count would survive (the head read still finds `prev`), which is
 * precisely why nobody would catch it.
 *
 * These pin the premise directly, from the pure half of the decision.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVisibility, shouldRetryCold, type IndexRead } from "../src/lib/credits/partition.js";
import type { Hex0x } from "@woco/shared";

const SUBJECT = `0x${"11".repeat(32)}` as Hex0x;
const OTHER = `0x${"22".repeat(32)}` as Hex0x;

const ok = (subjects: Hex0x[]): IndexRead => ({ status: "ok", subjects });
const absent: IndexRead = { status: "absent" };
const down = (reason = "gateway said no"): IndexRead => ({ status: "unavailable", reason });

test("a partition is returned only when that index actually lists the subject", () => {
  assert.deepEqual(decideVisibility(ok([SUBJECT]), ok([]), SUBJECT), { status: "ok", visibility: "public" });
  assert.deepEqual(decideVisibility(ok([]), ok([SUBJECT]), SUBJECT), { status: "ok", visibility: "private" });
});

test("a subject in neither index yields null — the case that still needs the index write", () => {
  assert.deepEqual(decideVisibility(ok([OTHER]), ok([OTHER]), SUBJECT), { status: "ok", visibility: null });
  assert.deepEqual(decideVisibility(absent, absent, SUBJECT), { status: "ok", visibility: null });
});

test("an UNAVAILABLE read never yields a partition, on either side", () => {
  // This is the one that matters most. `recordRide` refuses on a non-ok status,
  // so an unavailable read must never be dressed up as a clean answer — a
  // guessed partition here would skip the index write for a subject nothing
  // indexes, and the rail would look fine until the rider changed device.
  assert.equal(decideVisibility(down(), ok([SUBJECT]), SUBJECT).status, "unavailable");
  assert.equal(decideVisibility(ok([SUBJECT]), down(), SUBJECT).status, "unavailable");
  assert.equal(decideVisibility(down(), down(), SUBJECT).status, "unavailable");
});

test("an unreadable PUBLIC index is not smoothed over by a readable private one", () => {
  // Tri-state discipline: "could not read" is not "not there". If the public
  // index is unreachable the rider may already have published, and treating
  // that as private would write to a partition they retired.
  const r = decideVisibility(down("timeout"), ok([SUBJECT]), SUBJECT);
  assert.equal(r.status, "unavailable");
});

test("public wins when both list the subject, so a published rider is never demoted", () => {
  // Publication is one-way (publishSubject). If both indexes somehow list it,
  // resolving to private would write the next lap to the retired topic.
  assert.deepEqual(decideVisibility(ok([SUBJECT]), ok([SUBJECT]), SUBJECT), { status: "ok", visibility: "public" });
});

// ---------------------------------------------------------------------------
// The retry guard (#323)
// ---------------------------------------------------------------------------
//
// `recordRide` now reuses the head the page read on mount, which removes three
// feed reads from every tap. The guard below is what keeps that safe: it is the
// difference between "the head we were handed went stale, re-read and try
// again" and "write a second time on top of a ride that already landed".

test("a superseded WARM attempt is retried cold — the head went stale", () => {
  assert.equal(shouldRetryCold({ ok: false, superseded: true }, true), true);
});

test("a superseded COLD attempt is NOT retried — that is a real race", () => {
  // Everything was read fresh, so re-reading changes nothing. The rider is told
  // another device got there first, rather than watching a silent loop.
  assert.equal(shouldRetryCold({ ok: false, superseded: true }, false), false);
});

test("no other failure is ever retried, warm or not", () => {
  // This is the one that matters. `superseded` is the ONLY outcome meaning the
  // statement was not written. Retrying an unreadable-index failure, or any
  // future failure that forgets to set the flag, could add the laps twice.
  for (const warm of [true, false]) {
    assert.equal(shouldRetryCold({ ok: false }, warm), false);
    assert.equal(shouldRetryCold({ ok: false, superseded: false }, warm), false);
  }
});

test("a successful attempt is never retried", () => {
  assert.equal(shouldRetryCold({ ok: true }, true), false);
  assert.equal(shouldRetryCold({ ok: true, superseded: false }, true), false);
});

// ---------------------------------------------------------------------------
// The remembered-count cache must not outlive a sign-out
// ---------------------------------------------------------------------------

test("the credit cache prefix is user-scoped, so a shared device forgets it", async () => {
  // The card paints a remembered lap count before the live read returns, which
  // makes opening it instant. On a children's service that number must not
  // survive to the next person using a shared park or family device — and the
  // only thing making that true is this prefix being on the clear-on-sign-out
  // list. Nothing else would fail if it were dropped.
  const { USER_SCOPED_PREFIXES } = await import("../src/lib/cache/cache.js");
  assert.ok(
    USER_SCOPED_PREFIXES.includes("credit:"),
    "credit: must be cleared on sign-out — see CoasterCredit's cache comment",
  );
});
