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
// The write now returns at upload-accept and the read-back settles afterwards,
// so `superseded` — the one settlement meaning the entry did not land — arrives
// after the count is already on screen. This decides whether the card silently
// redoes the ride or tells the rider. It is the difference between "that lap
// was lost, record it properly" and "write a second time on top of a ride that
// already landed".

test("a superseded write is redone once", () => {
  assert.equal(shouldRetryCold("superseded", true), true);
});

test("a superseded write is NOT redone twice — that is a live race, not a stale head", () => {
  // The retry read everything fresh, so repeating it changes nothing. The rider
  // is told another device got there first, rather than watching a silent loop.
  assert.equal(shouldRetryCold("superseded", false), false);
});

test("no other settlement is ever redone", () => {
  // The one that matters. `verified` landed; `unconfirmed` was uploaded and is
  // merely unread — the plan calls it explicitly "not a failure". Redoing
  // either would add the laps twice.
  for (const allowed of [true, false]) {
    assert.equal(shouldRetryCold("verified", allowed), false);
    assert.equal(shouldRetryCold("unconfirmed", allowed), false);
  }
});
