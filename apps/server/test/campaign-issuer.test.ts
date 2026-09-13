/**
 * The campaign issuer (`lib/campaign/issuer.ts`, #476).
 *
 * What a record SAYS is pinned in `packages/shared/test/campaign/records.test.ts`.
 * What is pinned here is WHEN one gets written, which is where the money is:
 *
 *   - WRITE-ONCE WINS. A confirmation already at version 0 ends the attempt,
 *     whoever the caller says referred them. The slot is the uniqueness
 *     primitive, so a second referrer must lose it without a byte being spent.
 *   - A read that FAILED is never absence. An unreadable confirmation slot, an
 *     unreadable statement and an inconclusive version scan all refuse; only a
 *     definitive "nothing there" licenses a write.
 *   - A WRITE THAT LANDS ANYWHERE BUT VERSION 0 is not a confirmation. Bee
 *     discards a duplicate SOC with a 201, so "the upload worked" is evidence
 *     of nothing — the read-back is what makes a dead batch visible.
 *   - THE INDEX IS NOT THE RECORD. Its failure is counted and the confirmation
 *     still stands: every entry is re-derivable from the confirmations.
 *   - A REVOKED BADGE IS NEVER RE-ISSUED. Revocation is a later version on a
 *     latest-wins feed, and re-minting over it would undo the one abuse lever
 *     the format has.
 *
 * Everything touching Swarm is injected, for the reason the evidence publisher
 * injects its own: these are all FAILURE properties and a live bee cannot be
 * asked to produce them.
 *
 * The key here deliberately does NOT derive `CAMPAIGN_ISSUER_ADDRESS` — the
 * deps-injected functions never look, and it buys the boot-mismatch test.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BADGE_FORMAT,
  CAMPAIGN_ISSUER_ADDRESS,
  LAST_VERSION_IN_BAND,
  REFERRAL_CONFIRMATION_FORMAT,
  REFERRAL_STATEMENT_FORMAT,
  REFERRER_INDEX_FORMAT,
  badgeTopic,
  campaignAccountSubject,
  referralConfirmationTopic,
  referralStatementTopic,
  referrerIndexTopic,
  validateReferralConfirmationV1,
  type Hex0x,
  type VersionedFeedRead,
} from "@woco/shared";
import type { IssuerDeps } from "../src/lib/campaign/issuer.js";

// Set before anything reads them at import time.
process.env.CAMPAIGN_ISSUER_PRIVATE_KEY = `0x${"33".repeat(32)}`;
process.env.POSTAGE_BATCH_ID = "ab".repeat(32);
delete process.env.CAMPAIGN_EPOCH;

// Modules pulled in transitively capture `join(process.cwd(), ".data")` at load.
process.chdir(mkdtempSync(join(tmpdir(), "woco-campaign-")));

type Issuer = typeof import("../src/lib/campaign/issuer.js");
let issuer: Issuer;

const REFEREE = `0x${"a1".repeat(20)}` as Hex0x;
const REFERRER = `0x${"b2".repeat(20)}` as Hex0x;
const OTHER = `0x${"d4".repeat(20)}` as Hex0x;
const FEED = `0x${"c3".repeat(20)}` as Hex0x;
const NOW = 1_760_000_000_000;

const S_E = campaignAccountSubject(REFEREE);
const S_R = campaignAccountSubject(REFERRER);
const CONFIRM_TOPIC = referralConfirmationTopic(S_E);
const STATEMENT_TOPIC = referralStatementTopic(S_R);
const BADGE_TOPIC = badgeTopic(S_E, "joined");

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b));

function found(bytes: Uint8Array, version = 0, scanClean = true): VersionedFeedRead {
  return { status: "found", bytes, version, scanClean };
}

function statement(subject: Hex0x, value: boolean): Uint8Array {
  return enc({ format: REFERRAL_STATEMENT_FORMAT, subject, value });
}

function confirmation(referrer: Hex0x): Uint8Array {
  return enc({
    format: REFERRAL_CONFIRMATION_FORMAT,
    referee: REFEREE,
    refereeFeed: FEED,
    referrer,
    confirmedAt: new Date(NOW - 86_400_000).toISOString(),
  });
}

/** Records every write, and answers whatever the test told it to. */
function recorder(over: Partial<IssuerDeps> = {}) {
  const writes: { topic: string; bytes: Uint8Array }[] = [];
  const confirmed: { topic: string; version: number }[] = [];
  const deps: IssuerDeps = {
    // A live statement by default — the tests that care override it.
    readHead: async (_owner, topic) =>
      topic === STATEMENT_TOPIC ? found(statement(S_R, true)) : { status: "absent" },
    readVersion0: async () => ({ status: "absent" }),
    readBanded: async () => ({ status: "absent", band: 0 }),
    writeFeed: async (topic, bytes) => {
      writes.push({ topic, bytes });
      return { ok: true, version: 0, unchanged: false };
    },
    confirmWrite: async (topic, _bytes, version) => {
      confirmed.push({ topic, version });
      return { ok: true };
    },
    batchState: async () => ({ usable: true, ttl: 86_400 }),
    now: () => NOW,
    ...over,
  };
  return { deps, writes, confirmed };
}

const ARGS = { referee: REFEREE, refereeFeed: FEED, referrer: REFERRER };
const confirmWrites = (writes: { topic: string }[]): unknown[] =>
  writes.filter((w) => w.topic === CONFIRM_TOPIC);

before(async () => {
  issuer = await import("../src/lib/campaign/issuer.js");
});

beforeEach(() => {
  issuer.__resetIssuer();
});

// ---------------------------------------------------------------------------
// The confirmation slot
// ---------------------------------------------------------------------------

test("a confirmation already at version 0 ends the attempt, even for another referrer", async () => {
  const { deps, writes } = recorder({
    readVersion0: async () => ({ status: "found", bytes: confirmation(OTHER) }),
  });

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "already");
  assert.equal(res.status === "already" && res.record.referrer, OTHER);
  assert.equal(writes.length, 0, "the slot is spent — nothing may be written");
  assert.equal(issuer.campaignIssuerHealth().alreadyConfirmed, 1);
});

test("foreign bytes at version 0 refuse, permanently and loudly", async () => {
  const { deps, writes } = recorder({
    readVersion0: async () => ({ status: "found", bytes: enc({ hello: "world" }) }),
  });

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "unavailable");
  assert.equal(writes.length, 0);
  assert.ok(issuer.campaignIssuerHealth().lastError, "the condition must be visible in health");
});

test("an unreadable confirmation slot is not an empty one", async () => {
  const { deps, writes } = recorder({
    readVersion0: async () => ({ status: "unavailable", reason: "slot read failed" }),
  });

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "unavailable");
  assert.equal(writes.length, 0);
});

// ---------------------------------------------------------------------------
// The referee's statement
// ---------------------------------------------------------------------------

test("the referee's statement decides, and nothing is written without one", async () => {
  const cases: Array<{ why: string; head: VersionedFeedRead; expect: string }> = [
    { why: "absent", head: { status: "absent" }, expect: "no-statement" },
    { why: "retracted", head: found(statement(S_R, false)), expect: "retracted" },
    { why: "another subject", head: found(statement(campaignAccountSubject(OTHER), true)), expect: "no-statement" },
    { why: "unreadable", head: { status: "unavailable", reason: "probe" }, expect: "unavailable" },
    // A dirty scan's head is a LOWER BOUND, and a retraction is a later
    // version — so "value: true" from one cannot tell live from retracted.
    { why: "inconclusive scan", head: found(statement(S_R, true), 0, false), expect: "unavailable" },
  ];

  for (const c of cases) {
    issuer.__resetIssuer();
    const { deps, writes } = recorder({ readHead: async () => c.head });
    const res = await issuer.confirmReferral(ARGS, deps);
    assert.equal(res.status, c.expect, c.why);
    assert.equal(writes.length, 0, `${c.why}: nothing may be written`);
  }
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

test("a confirmed referral lands at version 0 of the referee's topic, and is read back", async () => {
  const { deps, writes, confirmed } = recorder();

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "confirmed");
  const mine = writes.filter((w) => w.topic === CONFIRM_TOPIC);
  assert.equal(mine.length, 1, "one write, at the referee-keyed topic");
  const record = dec(mine[0]!.bytes);
  assert.ok(validateReferralConfirmationV1(record), "the written bytes must validate");
  assert.deepEqual(record, {
    format: REFERRAL_CONFIRMATION_FORMAT,
    referee: REFEREE,
    refereeFeed: FEED,
    referrer: REFERRER,
    confirmedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(
    confirmed.filter((x) => x.topic === CONFIRM_TOPIC),
    [{ topic: CONFIRM_TOPIC, version: 0 }],
    "the read-back must check version 0, not whatever the writer returned",
  );
  assert.equal(issuer.campaignIssuerHealth().confirmations, 1);
});

test("a write that lands above version 0 is never counted as a confirmation", async () => {
  const { deps } = recorder({
    writeFeed: async () => ({ ok: true, version: 1, unchanged: false }),
  });

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "unavailable");
  assert.equal(issuer.campaignIssuerHealth().confirmations, 0);
});

test("a write that cannot be read back is a failure, not a confirmation", async () => {
  const { deps } = recorder({
    confirmWrite: async () => ({ ok: false, reason: "read-back absent" }),
  });

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "unavailable");
  assert.equal(issuer.campaignIssuerHealth().confirmations, 0);
  assert.equal(issuer.campaignIssuerHealth().failed, 1);
});

test("an unusable postage batch stops the rail before it spends anything", async () => {
  const { deps, writes } = recorder({ batchState: async () => ({ usable: false, ttl: null }) });

  const res = await issuer.confirmReferral(ARGS, deps);

  assert.equal(res.status, "unavailable");
  assert.equal(writes.length, 0);
  assert.ok(issuer.campaignIssuerHealth().lastSkipReason);
});

// ---------------------------------------------------------------------------
// The referrer's index
// ---------------------------------------------------------------------------

test("the referrer index appends, rolls over a full band, and never unmakes a confirmation", async () => {
  // Absent → band 0 holding just this referee.
  {
    issuer.__resetIssuer();
    const { deps, writes } = recorder();
    await issuer.appendReferrerIndex(REFERRER, REFEREE, deps);
    assert.deepEqual(writes.map((w) => w.topic), [referrerIndexTopic(S_R, 0)]);
    assert.deepEqual(dec(writes[0]!.bytes), { format: REFERRER_INDEX_FORMAT, subjects: [S_E] });
    assert.equal(issuer.campaignIssuerHealth().indexAppends, 1);
  }

  // A full band rolls over rather than writing a version that cannot exist.
  {
    issuer.__resetIssuer();
    const { deps, writes } = recorder({
      readBanded: async () => ({
        ...found(enc({ format: REFERRER_INDEX_FORMAT, subjects: [campaignAccountSubject(OTHER)] }), LAST_VERSION_IN_BAND),
        band: 2,
      }),
    });
    await issuer.appendReferrerIndex(REFERRER, REFEREE, deps);
    assert.deepEqual(writes.map((w) => w.topic), [referrerIndexTopic(S_R, 3)]);
  }

  // Already listed — an append that says nothing new costs nothing.
  {
    issuer.__resetIssuer();
    const { deps, writes } = recorder({
      readBanded: async () => ({ ...found(enc({ format: REFERRER_INDEX_FORMAT, subjects: [S_E] })), band: 0 }),
    });
    await issuer.appendReferrerIndex(REFERRER, REFEREE, deps);
    assert.equal(writes.length, 0);
  }

  // The index is a convenience; the confirmation is the record.
  {
    issuer.__resetIssuer();
    const indexTopic = referrerIndexTopic(S_R, 0);
    const { deps } = recorder({
      writeFeed: async (topic) =>
        topic === indexTopic
          ? { ok: false, reason: "upload refused" }
          : { ok: true, version: 0, unchanged: false },
    });
    const res = await issuer.confirmReferral(ARGS, deps);
    assert.equal(res.status, "confirmed", "a lost index entry does not unmake the confirmation");
    assert.equal(issuer.campaignIssuerHealth().indexFailed, 1);
    assert.ok(issuer.campaignIssuerHealth().lastIndexError);
  }
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

test("a badge is minted once and never over an existing one — revoked included", async () => {
  const revoked = enc({ format: BADGE_FORMAT, subject: S_E, badge: "joined", epoch: 0, value: false });
  const granted = enc({ format: BADGE_FORMAT, subject: S_E, badge: "joined", epoch: 0, value: true });

  {
    issuer.__resetIssuer();
    const { deps, writes, confirmed } = recorder({ readHead: async () => ({ status: "absent" }) });
    await issuer.issueBadge(REFEREE, deps);
    assert.deepEqual(writes.map((w) => w.topic), [BADGE_TOPIC]);
    assert.deepEqual(dec(writes[0]!.bytes), {
      format: BADGE_FORMAT, subject: S_E, badge: "joined", epoch: issuer.currentEpoch(), value: true,
    });
    assert.deepEqual(confirmed, [{ topic: BADGE_TOPIC, version: 0 }]);
    assert.equal(issuer.campaignIssuerHealth().badges, 1);
  }

  for (const [why, head] of [
    ["revoked", found(revoked)],
    ["granted", found(granted)],
    ["unreadable", { status: "unavailable", reason: "probe" } as VersionedFeedRead],
  ] as const) {
    issuer.__resetIssuer();
    const { deps, writes } = recorder({ readHead: async () => head });
    await issuer.issueBadge(REFEREE, deps);
    assert.equal(writes.length, 0, `${why}: nothing may be written`);
  }
});

// ---------------------------------------------------------------------------
// Boot and concurrency
// ---------------------------------------------------------------------------

test("a key that derives the wrong address turns the feature off and names both", () => {
  issuer.startCampaignIssuer();

  const health = issuer.campaignIssuerHealth();
  assert.equal(health.configured, false);
  const reason = String(health.lastSkipReason);
  assert.ok(reason.includes(CAMPAIGN_ISSUER_ADDRESS), "the address clients read must be named");
  assert.ok(/0x[0-9a-f]{40}/.test(reason.replace(CAMPAIGN_ISSUER_ADDRESS, "")), "the derived address must be named");
  assert.equal(issuer.campaignIssuerReady(), false);
});

test("a second confirm for the same referee while one is in flight refuses instead of racing", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { deps, writes } = recorder({
    readHead: async (_owner, topic) => {
      await gate;
      return topic === STATEMENT_TOPIC ? found(statement(S_R, true)) : { status: "absent" };
    },
  });

  const first = issuer.confirmReferral(ARGS, deps);
  const second = await issuer.confirmReferral(ARGS, recorder().deps);
  assert.equal(second.status, "unavailable");

  release();
  assert.equal((await first).status, "confirmed");
  assert.equal(confirmWrites(writes).length, 1, "exactly one write raced for the slot");
});
