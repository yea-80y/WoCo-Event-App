/**
 * The client half of the Swarm-native referral records (#476).
 *
 * Every property here is about WHERE bytes go and WHICH version is read, and
 * none of it is observable from a return value — which is why the module takes
 * its Swarm calls as injected deps. The three that would cost real money if
 * they drifted:
 *
 *   · the statement lands on the topic derived from the REFERRER's subject, so
 *     the server (which derives it independently) looks in the same place;
 *   · the index write FOLLOWS the statement, and is skipped when the statement
 *     was superseded — an index entry pointing at a statement that never landed
 *     advertises a claim the feed does not make;
 *   · a confirmation is read at VERSION 0 and never at the head. "One referrer
 *     per referee, first confirmed wins" is enforced by the write-once SOC at
 *     version 0; resolving the head would present a later chunk as the record a
 *     revenue share is owed against.
 *
 * MUTATION: change the `0` in `readConfirmation` to a head read and the version
 * test goes red; move `addToIndex` above the `superseded` check and the skip
 * test goes red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAMPAIGN_ISSUER_ADDRESS,
  REFERRAL_STATEMENT_FORMAT,
  REFERRAL_SUBJECT_INDEX_FORMAT,
  REFERRER_INDEX_FORMAT,
  BADGE_FORMAT,
  REFERRAL_CONFIRMATION_FORMAT,
  badgeTopic,
  campaignAccountSubject,
  referralConfirmationTopic,
  referralStatementTopic,
  referralSubjectIndexTopic,
  referrerIndexTopic,
  validateReferralStatementV1,
  type Hex0x,
} from "@woco/shared";
import {
  readBadge,
  readConfirmation,
  readMyReferralStatement,
  readReferrerIndex,
  writeReferralStatement,
  type CampaignRecordDeps,
} from "../src/lib/campaign/records.js";
import { FEED_ROUTES, type FeedRoute } from "../src/lib/swarm/gateways.js";

const REFERRER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex0x;
const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd" as Hex0x;
const REFEREE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex0x;
const MY_FEED = "0xcccccccccccccccccccccccccccccccccccccccc";
const SIGNER = { privKey: `0x${"11".repeat(32)}`, address: MY_FEED };
/** A valid bytes32 subject that is NOT address-shaped — the foreign entry. */
const FOREIGN_SUBJECT = `0x${"ff".repeat(32)}` as Hex0x;

type Recorder = {
  order: string[];
  writes: Array<{ signerPrivKey: string; ownerAddress: string; topic: string; data: unknown }>;
  indexed: Array<{ subject: Hex0x; indexFormat: string; indexTopic: (b: number) => string }>;
  feedReads: Array<{ owner: string; topic: string; opts?: unknown }>;
  versionReads: Array<{ owner: string; topic: string; version: number }>;
  bandedReads: Array<{ owner: string; topic0: string }>;
  /** The route every call carried, in call order - which family each read and write used. */
  routes: Array<{ call: string; route: FeedRoute }>;
};

function harness(
  answers: {
    feeds?: Record<string, unknown>;
    banded?: Record<string, unknown>;
    atVersion?: unknown;
    writeStatus?: "verified" | "superseded" | "unconfirmed";
    /** Every banded read answers `unavailable`, as a gateway that never replied would. */
    bandedUnavailable?: boolean;
  } = {},
): { deps: CampaignRecordDeps; rec: Recorder } {
  const rec: Recorder = {
    order: [], writes: [], indexed: [], feedReads: [], versionReads: [], bandedReads: [], routes: [],
  };
  const found = (value: unknown) =>
    value === undefined
      ? ({ status: "absent" } as const)
      : ({ status: "found", value, version: 0, scanClean: true } as const);

  const deps: CampaignRecordDeps = {
    readFeed: async (owner, topic, opts) => {
      rec.feedReads.push({ owner, topic, opts });
      rec.routes.push({ call: "readFeed", route: opts.route });
      return found(answers.feeds?.[topic]);
    },
    readFeedAtVersion: async (owner, topic, version, opts) => {
      rec.versionReads.push({ owner, topic, version });
      rec.routes.push({ call: "readFeedAtVersion", route: opts.route });
      return found(answers.atVersion);
    },
    readBandedFeed: async (owner, topicForBand, opts) => {
      rec.routes.push({ call: "readBandedFeed", route: opts.route });
      const topic0 = topicForBand(0);
      rec.bandedReads.push({ owner, topic0 });
      if (answers.bandedUnavailable) {
        return { status: "unavailable", reason: "no answer", band: 0, bandClean: false };
      }
      const value = answers.banded?.[topic0];
      return value === undefined
        ? { status: "absent", band: 0, bandClean: true }
        : { status: "found", value, version: 0, scanClean: true, band: 0, bandClean: true };
    },
    writeVerified: async (args) => {
      rec.order.push("statement");
      rec.writes.push(args);
      rec.routes.push({ call: "writeVerified", route: args.route });
      return { status: answers.writeStatus ?? "verified", version: 0 } as never;
    },
    addToIndex: async (_signer, subject, kind) => {
      rec.order.push("index");
      rec.indexed.push({ subject, indexFormat: kind.indexFormat, indexTopic: kind.indexTopic });
      rec.routes.push({ call: "addToIndex", route: kind.route });
    },
  };
  return { deps, rec };
}

// ---------------------------------------------------------------------------
// The statement write
// ---------------------------------------------------------------------------

test("the statement lands on the REFERRER's topic, closed payload, index after", async () => {
  const { deps, rec } = harness();
  const res = await writeReferralStatement(SIGNER, REFERRER, deps);
  assert.equal(res.status, "verified");

  const subject = campaignAccountSubject(REFERRER);
  assert.equal(rec.writes.length, 1);
  assert.equal(rec.writes[0].topic, referralStatementTopic(subject));
  assert.equal(rec.writes[0].ownerAddress, MY_FEED, "the referee's OWN feed, never the issuer's");
  assert.equal(rec.writes[0].signerPrivKey, SIGNER.privKey);
  assert.deepEqual(rec.writes[0].data, {
    format: REFERRAL_STATEMENT_FORMAT,
    subject,
    value: true,
  });
  // The schema is CLOSED, so an extra field is not a harmless addition — it
  // makes the chunk unreadable to every verifier including our own.
  assert.ok(validateReferralStatementV1(rec.writes[0].data));

  assert.deepEqual(rec.order, ["statement", "index"], "statement FIRST, always");
  assert.equal(rec.indexed[0].subject, subject);
  assert.equal(rec.indexed[0].indexFormat, REFERRAL_SUBJECT_INDEX_FORMAT);
  assert.equal(rec.indexed[0].indexTopic(0), referralSubjectIndexTopic(0));
});

test("a live statement already on the feed is not rewritten — only its index is ensured", async () => {
  // The capture is kept on `unconfirmed`, so this runs again on the next
  // sign-in; without the head read every such run would append another version
  // of the same statement.
  const subject = campaignAccountSubject(REFERRER);
  const { deps, rec } = harness({
    feeds: { [referralStatementTopic(subject)]: { format: REFERRAL_STATEMENT_FORMAT, subject, value: true } },
  });
  const res = await writeReferralStatement(SIGNER, REFERRER, deps);
  assert.equal(res.status, "verified");
  assert.equal(rec.writes.length, 0, "no second version of a live statement");
  assert.deepEqual(rec.order, ["index"]);
  assert.equal(rec.feedReads[0]?.owner, MY_FEED, "the head read is of the referee's OWN feed");
});

test("a RETRACTED head is written over — a retraction is not a live statement", async () => {
  const subject = campaignAccountSubject(REFERRER);
  const { deps, rec } = harness({
    feeds: { [referralStatementTopic(subject)]: { format: REFERRAL_STATEMENT_FORMAT, subject, value: false } },
  });
  const res = await writeReferralStatement(SIGNER, REFERRER, deps);
  assert.equal(res.status, "verified");
  assert.equal(rec.writes.length, 1);
  assert.deepEqual(rec.order, ["statement", "index"]);
});

test("a superseded statement writes NO index entry", async () => {
  const { deps, rec } = harness({ writeStatus: "superseded" });
  const res = await writeReferralStatement(SIGNER, REFERRER, deps);
  assert.equal(res.status, "superseded");
  assert.deepEqual(rec.order, ["statement"]);
  assert.equal(rec.indexed.length, 0, "our bytes are not on the feed — nothing to point at");
});

// ---------------------------------------------------------------------------
// Reading my own statement
// ---------------------------------------------------------------------------

test("readMyReferralStatement returns the live subject and skips a retracted one", async () => {
  const retracted = campaignAccountSubject(OTHER);
  const live = campaignAccountSubject(REFERRER);
  const { deps } = harness({
    banded: {
      [referralSubjectIndexTopic(0)]: {
        format: REFERRAL_SUBJECT_INDEX_FORMAT,
        // Retracted FIRST: the index never removes a subject, so "first entry"
        // and "live entry" are different questions and this is the case where
        // they differ.
        subjects: [retracted, live],
      },
    },
    feeds: {
      [referralStatementTopic(retracted)]: {
        format: REFERRAL_STATEMENT_FORMAT, subject: retracted, value: false,
      },
      [referralStatementTopic(live)]: {
        format: REFERRAL_STATEMENT_FORMAT, subject: live, value: true,
      },
    },
  });

  assert.deepEqual(await readMyReferralStatement(MY_FEED, deps), {
    referrer: REFERRER,
    subject: live,
  });
});

test("readMyReferralStatement is null when every statement is retracted", async () => {
  const retracted = campaignAccountSubject(OTHER);
  const { deps } = harness({
    banded: {
      [referralSubjectIndexTopic(0)]: {
        format: REFERRAL_SUBJECT_INDEX_FORMAT, subjects: [retracted],
      },
    },
    feeds: {
      [referralStatementTopic(retracted)]: {
        format: REFERRAL_STATEMENT_FORMAT, subject: retracted, value: false,
      },
    },
  });
  assert.equal(await readMyReferralStatement(MY_FEED, deps), null);
});

// ---------------------------------------------------------------------------
// The issuer's records
// ---------------------------------------------------------------------------

const CONFIRMATION = {
  format: REFERRAL_CONFIRMATION_FORMAT,
  referee: REFEREE,
  refereeFeed: MY_FEED,
  referrer: REFERRER,
  confirmedAt: "2026-09-13T10:00:00.000Z",
};

test("readConfirmation reads VERSION 0 of the issuer's feed, never the head", async () => {
  const { deps, rec } = harness({ atVersion: CONFIRMATION });
  assert.deepEqual(await readConfirmation(REFEREE, deps), CONFIRMATION);

  assert.equal(rec.versionReads.length, 1);
  assert.equal(rec.versionReads[0].version, 0, "first-confirmed-wins lives at version 0");
  assert.equal(rec.versionReads[0].owner, CAMPAIGN_ISSUER_ADDRESS);
  assert.equal(
    rec.versionReads[0].topic,
    referralConfirmationTopic(campaignAccountSubject(REFEREE)),
    "keyed by the REFEREE — that is what makes the write-once SOC a uniqueness rule",
  );
});

test("readConfirmation is null for a payload that fails validation", async () => {
  // A self-referral is refused at the schema, so these bytes are foreign
  // whatever signed them — and foreign bytes must read as no record, not as a
  // record with a nonsense referrer.
  const { deps } = harness({ atVersion: { ...CONFIRMATION, referrer: REFEREE } });
  assert.equal(await readConfirmation(REFEREE, deps), null);
});

test("readBadge returns a REVOKED badge too — the display rule is the caller's", async () => {
  const subject = campaignAccountSubject(REFEREE);
  const revoked = { format: BADGE_FORMAT, subject, badge: "joined", epoch: 0, value: false };
  const { deps, rec } = harness({ feeds: { [badgeTopic(subject, "joined")]: revoked } });

  // Null here would make a revocation indistinguishable from an account that
  // never had a badge, which is exactly the difference the escape hatch exists
  // to express.
  assert.deepEqual(await readBadge(REFEREE, deps), revoked);
  assert.equal(rec.feedReads[0].owner, CAMPAIGN_ISSUER_ADDRESS);
});

test("readReferrerIndex maps subjects to addresses and drops a foreign entry", async () => {
  const subject = campaignAccountSubject(REFERRER);
  const { deps } = harness({
    banded: {
      [referrerIndexTopic(subject, 0)]: {
        format: REFERRER_INDEX_FORMAT,
        subjects: [campaignAccountSubject(REFEREE), FOREIGN_SUBJECT, campaignAccountSubject(OTHER)],
      },
    },
  });

  // FOREIGN_SUBJECT is a valid bytes32 and passes the index schema — it just is
  // not address-shaped. One such entry must cost its own row and nothing else.
  assert.deepEqual(await readReferrerIndex(REFERRER, deps), { status: "found", referees: [REFEREE, OTHER] });
});

test("readReferrerIndex reports absent when the issuer has published nothing", async () => {
  const { deps } = harness();
  assert.deepEqual(await readReferrerIndex(REFERRER, deps), { status: "absent" });
});

test("readReferrerIndex reports a read nobody answered as unavailable, never as empty", async () => {
  const { deps } = harness({ bandedUnavailable: true });
  assert.deepEqual(await readReferrerIndex(REFERRER, deps), { status: "unavailable" });
});

// ---------------------------------------------------------------------------
// Which family each call reads and writes through (#651)
// ---------------------------------------------------------------------------

const onlyRoute = (routes: Array<{ call: string; route: FeedRoute }>, expected: FeedRoute, label: string) => {
  assert.ok(routes.length > 0, `${label}: no calls recorded`);
  for (const r of routes) assert.equal(r.route, expected, `${label}: ${r.call}`);
};

test("the referee's statement, its head read and its index all go through the referral family", async () => {
  const { deps, rec } = harness();
  await writeReferralStatement(SIGNER, REFERRER, deps);
  onlyRoute(rec.routes, FEED_ROUTES.referral, "writeReferralStatement");
  assert.deepEqual(rec.routes.map((r) => r.call), ["readFeed", "writeVerified", "addToIndex"]);
});

test("reading the caller's own referral goes through the referral family", async () => {
  const subject = campaignAccountSubject(REFERRER);
  const { deps, rec } = harness({
    banded: { [referralSubjectIndexTopic(0)]: { format: REFERRAL_SUBJECT_INDEX_FORMAT, subjects: [subject] } },
  });
  await readMyReferralStatement(MY_FEED, deps);
  onlyRoute(rec.routes, FEED_ROUTES.referral, "readMyReferralStatement");
});

test("the issuer's confirmations, badges and referrer index are read through the issuer's family", async () => {
  for (const [label, run] of [
    ["readConfirmation", (d: CampaignRecordDeps) => readConfirmation(REFEREE, d)],
    ["readBadge", (d: CampaignRecordDeps) => readBadge(REFEREE, d)],
    ["readReferrerIndex", (d: CampaignRecordDeps) => readReferrerIndex(REFERRER, d)],
  ] as const) {
    const { deps, rec } = harness();
    await run(deps);
    onlyRoute(rec.routes, FEED_ROUTES.campaignIssuer, label);
  }
});
