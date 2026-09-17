/**
 * The referral branch of the attendee gate (`lib/gate/referral-unlock.ts`, #575).
 *
 * The index it reads is APPEND-ONLY, which is the whole basis of the memo:
 *   - "confirmed" is remembered for the process — the index is read once;
 *   - "none" is re-read after the recheck window, not before, so a fresh
 *     confirmation is seen within one window without a read per Home open;
 *   - "unavailable" is never remembered as "none": after the window the read is
 *     made again, and until it answers the branch stays refused;
 *   - the issuer's note primes "confirmed" with no read at all.
 * And the live reader:
 *   - reads at CAMPAIGN_ISSUER_ADDRESS — the address every client reads — under
 *     the referrer's own index topics, band by band;
 *   - a throw is unavailable, never absent; foreign bytes are absent (only the
 *     issuer writes there); an empty index is not a confirmation.
 *
 * MUTATION CHECK: expire "confirmed", cache "unavailable" as "none", read at the
 * configured key's address, or treat a throw as absent, and a test goes red.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAMPAIGN_ISSUER_ADDRESS,
  REFERRER_INDEX_FORMAT,
  campaignAccountSubject,
  referrerIndexTopic,
  type VersionedFeedRead,
} from "@woco/shared";
import type { ReferrerIndexRead } from "../src/lib/gate/referral-unlock.js";

type Mod = typeof import("../src/lib/gate/referral-unlock.js");
let mod: Mod;

before(async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "woco-referral-unlock-")));
  mod = await import("../src/lib/gate/referral-unlock.js");
});

beforeEach(() => mod.resetReferralUnlockMemo());

const REFERRER = "0xB2b2b2b2B2b2b2b2b2b2b2b2b2b2b2b2b2b2b2B2";
const LOWER = REFERRER.toLowerCase();
const OTHER = "0x" + "d4".repeat(20);
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

/** A read that answers from a script and counts how often it was asked. */
function scripted(...answers: ReferrerIndexRead[]) {
  const asked: string[] = [];
  const read = async (referrer: string): Promise<ReferrerIndexRead> => {
    asked.push(referrer);
    return answers[Math.min(asked.length, answers.length) - 1];
  };
  return { read, asked };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

test("one confirmed referee is confirmed; an empty index, no index and an unanswered read are not", async () => {
  const c = clock();
  assert.equal(await mod.referralUnlock(REFERRER, scripted({ status: "found", confirmed: 1 }).read, c.now), "confirmed");
  mod.resetReferralUnlockMemo();
  assert.equal(await mod.referralUnlock(REFERRER, scripted({ status: "found", confirmed: 0 }).read, c.now), "none");
  mod.resetReferralUnlockMemo();
  assert.equal(await mod.referralUnlock(REFERRER, scripted({ status: "absent" }).read, c.now), "none");
  mod.resetReferralUnlockMemo();
  assert.equal(await mod.referralUnlock(REFERRER, scripted({ status: "unavailable" }).read, c.now), "unavailable");
});

test("confirmed is remembered for good — the index is read once, however long ago", async () => {
  const c = clock();
  const { read, asked } = scripted({ status: "found", confirmed: 2 }, { status: "absent" });
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "confirmed");
  c.advance(mod.REFERRAL_UNLOCK_RECHECK_MS * 1000);
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "confirmed");
  assert.equal(asked.length, 1);
});

test("none is re-read after the recheck window, not before", async () => {
  const c = clock();
  const { read, asked } = scripted({ status: "absent" }, { status: "found", confirmed: 1 });
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "none");
  c.advance(mod.REFERRAL_UNLOCK_RECHECK_MS - 1);
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "none");
  assert.equal(asked.length, 1, "inside the window the memo answers");
  c.advance(1);
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "confirmed");
  assert.equal(asked.length, 2);
});

test("unavailable is never remembered as none, and is retried after the window", async () => {
  const c = clock();
  const { read, asked } = scripted({ status: "unavailable" }, { status: "found", confirmed: 1 });
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "unavailable");
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "unavailable", "inside the window it stays what it was");
  c.advance(mod.REFERRAL_UNLOCK_RECHECK_MS);
  assert.equal(await mod.referralUnlock(REFERRER, read, c.now), "confirmed");
  assert.equal(asked.length, 2);
});

test("the issuer's note primes confirmed with no read", async () => {
  const { read, asked } = scripted({ status: "absent" });
  mod.noteConfirmedReferral(REFERRER);
  assert.equal(await mod.referralUnlock(LOWER, read), "confirmed");
  assert.equal(asked.length, 0);
});

test("the memo is per address, keyed case-insensitively", async () => {
  const c = clock();
  const mine = scripted({ status: "found", confirmed: 1 });
  const theirs = scripted({ status: "absent" });
  assert.equal(await mod.referralUnlock(REFERRER, mine.read, c.now), "confirmed");
  assert.equal(await mod.referralUnlock(OTHER, theirs.read, c.now), "none");
  assert.equal(await mod.referralUnlock(LOWER, theirs.read, c.now), "confirmed", "same address, other case");
  assert.deepEqual(mine.asked, [LOWER]);
  assert.deepEqual(theirs.asked, [OTHER]);
});

// ---------------------------------------------------------------------------
// The live reader
// ---------------------------------------------------------------------------

type Banded = Parameters<Mod["liveReadReferrerIndex"]>[1];

function banded(answer: VersionedFeedRead | Error) {
  const seen: Array<{ owner: string; topic0: string; topic3: string }> = [];
  const read: Banded = async (owner, topicForBand) => {
    seen.push({ owner, topic0: topicForBand(0), topic3: topicForBand(3) });
    if (answer instanceof Error) throw answer;
    return { ...answer, band: 0 };
  };
  return { read, seen };
}

test("reads at the issuer address every client reads, under the referrer's index topics", async () => {
  const b = banded({ status: "absent" });
  await mod.liveReadReferrerIndex(REFERRER, b.read);
  const subject = campaignAccountSubject(LOWER);
  assert.deepEqual(b.seen, [{
    owner: CAMPAIGN_ISSUER_ADDRESS.slice(2).toLowerCase(),
    topic0: referrerIndexTopic(subject, 0),
    topic3: referrerIndexTopic(subject, 3),
  }]);
});

test("a valid index answers its size; a dirty scan still counts", async () => {
  const index = enc({ format: REFERRER_INDEX_FORMAT, subjects: [campaignAccountSubject(OTHER)] });
  const clean = banded({ status: "found", bytes: index, version: 4, scanClean: true });
  assert.deepEqual(await mod.liveReadReferrerIndex(REFERRER, clean.read), { status: "found", confirmed: 1 });
  const dirty = banded({ status: "found", bytes: index, version: 4, scanClean: false });
  assert.deepEqual(await mod.liveReadReferrerIndex(REFERRER, dirty.read), { status: "found", confirmed: 1 });
});

test("a throw is unavailable, an unavailable read is unavailable — neither is absent", async () => {
  assert.deepEqual(await mod.liveReadReferrerIndex(REFERRER, banded(new Error("bee 500")).read), { status: "unavailable" });
  assert.deepEqual(
    await mod.liveReadReferrerIndex(REFERRER, banded({ status: "unavailable", reason: "probe" }).read),
    { status: "unavailable" },
  );
});

test("no index, or foreign bytes where only the issuer writes, is absent", async () => {
  assert.deepEqual(await mod.liveReadReferrerIndex(REFERRER, banded({ status: "absent" }).read), { status: "absent" });
  const foreign = banded({ status: "found", bytes: enc({ format: "woco.like.v1", subjects: ["x"] }), version: 0, scanClean: true });
  assert.deepEqual(await mod.liveReadReferrerIndex(REFERRER, foreign.read), { status: "absent" });
  const garbage = banded({ status: "found", bytes: new TextEncoder().encode("{not json"), version: 0, scanClean: true });
  assert.deepEqual(await mod.liveReadReferrerIndex(REFERRER, garbage.read), { status: "absent" });
});
