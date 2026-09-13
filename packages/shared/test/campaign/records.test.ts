/**
 * Frozen vectors for the Swarm-native referral campaign (#476) — written by the
 * designer BEFORE the module, so the module is built to the spec and not the
 * other way round. Vectors were derived independently from the recipe in
 * `statement/discipline.ts` (HMAC-SHA256 over `subjectBytes || uint64BE(band)`
 * under the public salt `utf8("woco-{type}-public-v1")`), and cross-checked
 * against the frozen like vector in `test/social/social.test.ts`.
 *
 * Three records, three signers (issue #476, design comment 2026-09-12):
 *   · `woco.referral.v1`               — the REFEREE's own feed, band 0 pinned
 *   · `woco.referral-confirmation.v1`  — the campaign issuer's feed, version 0,
 *                                        write-once: first confirmed wins
 *   · `woco.badge.v1`                  — the campaign issuer's feed, latest wins
 * plus two indexes:
 *   · `woco.referral-index.v1`  — the referee's per-holder subject index (banded,
 *                                 exactly the follow scheme)
 *   · `woco.referrer-index.v1`  — the issuer's per-referrer list of confirmed
 *                                 referees (banded: one version per confirmation,
 *                                 never removed)
 *
 * `stripeCompletedAt` from the design comment is NOT in the confirmation. The
 * server has no such fact: `lib/stripe/accounts.ts` records `createdAt` and
 * `updatedAt`, and `updatedAt` also moves on a currency change. A field the
 * writer cannot source honestly is worse than an absent one; `confirmedAt` is
 * the moment the issuer saw both preconditions, which is the claim it can make.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BADGE_FORMAT,
  BADGE_KINDS,
  CAMPAIGN_ISSUER_ADDRESS,
  REFERRAL_CONFIRMATION_FORMAT,
  REFERRAL_STATEMENT_FORMAT,
  REFERRAL_SUBJECT_INDEX_FORMAT,
  REFERRER_INDEX_FORMAT,
  badgeTopic,
  campaignAccountSubject,
  referralConfirmationTopic,
  referralStatementTopic,
  referralSubjectIndexTopic,
  referrerIndexTopic,
  validateBadgeV1,
  validateReferralConfirmationV1,
  validateReferralStatementV1,
  validateReferralSubjectIndexV1,
  validateReferrerIndexV1,
} from "../../src/campaign/records.js";
import { followStatementTopic, socialProfileSubject } from "../../src/social/index.js";

const REFERRER = "0x1234567890abcdef1234567890abcdef12345678";
const REFEREE = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const S_REFERRER = "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678" as const;
const S_REFEREE = "0x000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("format ids are the frozen strings", () => {
  assert.equal(REFERRAL_STATEMENT_FORMAT, "woco.referral.v1");
  assert.equal(REFERRAL_SUBJECT_INDEX_FORMAT, "woco.referral-index.v1");
  assert.equal(REFERRAL_CONFIRMATION_FORMAT, "woco.referral-confirmation.v1");
  assert.equal(BADGE_FORMAT, "woco.badge.v1");
  assert.equal(REFERRER_INDEX_FORMAT, "woco.referrer-index.v1");
  assert.deepEqual([...BADGE_KINDS], ["joined"]);
});

test("the campaign issuer address is pinned, lowercase, and not the indexer's", () => {
  // Derived from CAMPAIGN_ISSUER_PRIVATE_KEY on the server (generated
  // 2026-09-13). A key that derives anything else must refuse to publish.
  assert.equal(CAMPAIGN_ISSUER_ADDRESS, "0xe34fa431d1639468f8420ae3471cb8374aa99249");
  assert.match(CAMPAIGN_ISSUER_ADDRESS, /^0x[0-9a-f]{40}$/);
  assert.notEqual(CAMPAIGN_ISSUER_ADDRESS, "0x4a505197954dd70ed833d98a4e225460d84caebf");
});

test("an account subject is the ONE profile derivation, not a second one", () => {
  // A referral about an address and a follow of that address must key the same
  // bytes, or a third party reading the social scheme lands on nothing.
  assert.equal(campaignAccountSubject(REFERRER), S_REFERRER);
  assert.equal(campaignAccountSubject(REFERRER.toUpperCase()), socialProfileSubject(REFERRER));
  assert.equal(campaignAccountSubject(`  ${REFEREE}  `), S_REFEREE);
  for (const bad of ["", "0x", "punkpub", "0x1234", `0x${"a".repeat(64)}`]) {
    assert.throws(() => campaignAccountSubject(bad));
  }
});

// ---------------------------------------------------------------------------
// Frozen topic vectors
// ---------------------------------------------------------------------------

test("frozen: referee statement topic — band 0 pinned, the follow scheme", () => {
  assert.equal(
    referralStatementTopic(S_REFERRER),
    "woco/referral/v1/8909d32a788d22505afdeb9aede7e68ce72de4d2522c54a9e0bdfb06404b93e2",
  );
  // Same subject bytes, different type → different address. The type segment
  // and the salt both partition; a referral can never land on a follow topic.
  assert.notEqual(referralStatementTopic(S_REFERRER), followStatementTopic(S_REFERRER));
});

test("frozen: referee subject index — banded, like the social index", () => {
  assert.equal(
    referralSubjectIndexTopic(0),
    "woco/referral/v1/index/534c59d59308b990cabbccdba5665432f869bd8b0efa6c40df60336176d7b286",
  );
  assert.equal(
    referralSubjectIndexTopic(1),
    "woco/referral/v1/index/14790160df61e462d84e5a840fef146b1a063d15071e9e3daabf0e54838bc3a2",
  );
  assert.notEqual(referralSubjectIndexTopic(0), referralSubjectIndexTopic(1));
});

test("frozen: confirmation topic — keyed by the REFEREE, version 0 write-once", () => {
  assert.equal(
    referralConfirmationTopic(S_REFEREE),
    "woco/referral-confirmation/v1/f660bc014cbec5942fbd5dfaaf2a1e17f4d2558fa51a8f17918151480d25c63b",
  );
});

test("frozen: badge topic — the kind is in the salt, the subject in the message", () => {
  assert.equal(
    badgeTopic(S_REFEREE, "joined"),
    "woco/badge/v1/6db5856e69548a4326e41289ae47a13bd86186703f281ad200558222615528e5",
  );
  // A kind outside the closed list has no address. Silently deriving one would
  // let a typo mint a badge nobody reads.
  assert.throws(() => badgeTopic(S_REFEREE, "early" as never));
});

test("frozen: referrer index — keyed by the REFERRER, banded", () => {
  assert.equal(
    referrerIndexTopic(S_REFERRER, 0),
    "woco/referrer-index/v1/9fd252566de484d26ea384b9c0c316a00553f57a2db9c53266cc441a58849f3c",
  );
  assert.equal(
    referrerIndexTopic(S_REFERRER, 1),
    "woco/referrer-index/v1/5e73d2b9b4fa916d7864883de6ed68708a2d9eab356cc34055b74909d5b921cc",
  );
  assert.notEqual(referrerIndexTopic(S_REFERRER, 0), referrerIndexTopic(S_REFERRER, 1));
});

test("the four record families never share an address for one subject", () => {
  const all = [
    referralStatementTopic(S_REFEREE),
    referralConfirmationTopic(S_REFEREE),
    badgeTopic(S_REFEREE, "joined"),
    referrerIndexTopic(S_REFEREE, 0),
  ];
  assert.equal(new Set(all).size, all.length);
  // And every topic refuses anything that is not a bytes32 subject — an address
  // handed in raw must throw, never derive a plausible sibling.
  assert.throws(() => referralStatementTopic(REFERRER as never));
  assert.throws(() => referralConfirmationTopic(REFEREE as never));
  assert.throws(() => badgeTopic(REFEREE as never, "joined"));
  assert.throws(() => referrerIndexTopic(REFERRER as never, 0));
  assert.throws(() => referrerIndexTopic(S_REFERRER, -1));
});

// ---------------------------------------------------------------------------
// Closed schemas — exact key sets, dispatch-before-validation
// ---------------------------------------------------------------------------

test("referral statement: exactly {format, subject, value}", () => {
  const ok = { format: "woco.referral.v1", subject: S_REFERRER, value: true };
  assert.equal(validateReferralStatementV1(ok), true);
  assert.equal(validateReferralStatementV1({ ...ok, value: false }), true);
  assert.equal(validateReferralStatementV1({ ...ok, format: "woco.follow.v1" }), false);
  assert.equal(validateReferralStatementV1({ ...ok, value: 1 }), false);
  assert.equal(validateReferralStatementV1({ ...ok, seq: 1 }), false);
  assert.equal(validateReferralStatementV1({ ...ok, subject: REFERRER }), false);
  assert.equal(validateReferralStatementV1({ ...ok, subject: S_REFERRER.toUpperCase() }), false);
  assert.equal(validateReferralStatementV1(null), false);
  assert.equal(validateReferralStatementV1([ok]), false);
});

test("referral subject index: the shared SubjectIndexV1 shape under its own format", () => {
  assert.equal(validateReferralSubjectIndexV1({ format: "woco.referral-index.v1", subjects: [S_REFERRER] }), true);
  assert.equal(validateReferralSubjectIndexV1({ format: "woco.referral-index.v1", subjects: [] }), true);
  assert.equal(validateReferralSubjectIndexV1({ format: "woco.follow-index.v1", subjects: [S_REFERRER] }), false);
  assert.equal(validateReferralSubjectIndexV1({ format: "woco.referral-index.v1", subjects: [REFERRER] }), false);
  assert.equal(validateReferralSubjectIndexV1({ format: "woco.referral-index.v1", subjects: [S_REFERRER], band: 0 }), false);
});

test("confirmation: exactly {confirmedAt, format, referee, referrer}, addresses lowercase, never self", () => {
  const ok = {
    format: "woco.referral-confirmation.v1",
    referee: REFEREE,
    referrer: REFERRER,
    confirmedAt: "2026-09-13T12:34:56.789Z",
  };
  assert.equal(validateReferralConfirmationV1(ok), true);

  // Key set is closed: the design's stripeCompletedAt is deliberately absent and
  // must not be accepted if someone adds it back.
  assert.equal(validateReferralConfirmationV1({ ...ok, stripeCompletedAt: ok.confirmedAt }), false);
  const { confirmedAt: _dropped, ...missing } = ok;
  assert.equal(validateReferralConfirmationV1(missing), false);

  assert.equal(validateReferralConfirmationV1({ ...ok, format: "woco.referral.v1" }), false);
  assert.equal(validateReferralConfirmationV1({ ...ok, referee: REFEREE.toUpperCase() }), false);
  assert.equal(validateReferralConfirmationV1({ ...ok, referrer: S_REFERRER }), false);
  // A self-referral is not a record the issuer would ever write, so a payload
  // claiming one is foreign bytes — refused at the schema, not left to policy.
  assert.equal(validateReferralConfirmationV1({ ...ok, referrer: REFEREE }), false);

  // confirmedAt is the exact Date#toISOString shape and must round-trip, so
  // that a later Merkle anchor over these payloads is trivially deterministic.
  for (const bad of [
    "2026-09-13T12:34:56Z", // no milliseconds
    "2026-09-13T12:34:56.789+00:00", // offset form
    "2026-13-45T12:34:56.789Z", // shape-valid, calendar-invalid
    1_757_766_896_789, // a number
    "", // empty
  ]) {
    assert.equal(validateReferralConfirmationV1({ ...ok, confirmedAt: bad }), false, String(bad));
  }
});

test("badge: exactly {badge, epoch, format, subject, value}", () => {
  const ok = { format: "woco.badge.v1", subject: S_REFEREE, badge: "joined", epoch: 0, value: true };
  assert.equal(validateBadgeV1(ok), true);
  assert.equal(validateBadgeV1({ ...ok, value: false }), true); // revocation
  assert.equal(validateBadgeV1({ ...ok, epoch: 7 }), true);
  assert.equal(validateBadgeV1({ ...ok, badge: "early" }), false);
  assert.equal(validateBadgeV1({ ...ok, epoch: -1 }), false);
  assert.equal(validateBadgeV1({ ...ok, epoch: 1.5 }), false);
  assert.equal(validateBadgeV1({ ...ok, epoch: "0" }), false);
  assert.equal(validateBadgeV1({ ...ok, value: "true" }), false);
  assert.equal(validateBadgeV1({ ...ok, subject: REFEREE }), false);
  assert.equal(validateBadgeV1({ ...ok, format: "woco.referral.v1" }), false);
  assert.equal(validateBadgeV1({ ...ok, uid: "0x00" }), false);
  const { epoch: _dropped, ...missing } = ok;
  assert.equal(validateBadgeV1(missing), false);
});

test("referrer index: the shared SubjectIndexV1 shape under its own format", () => {
  // `subjects` are REFEREE account subjects; each points at a confirmation the
  // reader can verify at referralConfirmationTopic(subject) in the issuer's space.
  assert.equal(validateReferrerIndexV1({ format: "woco.referrer-index.v1", subjects: [S_REFEREE] }), true);
  assert.equal(validateReferrerIndexV1({ format: "woco.referral-index.v1", subjects: [S_REFEREE] }), false);
  assert.equal(validateReferrerIndexV1({ format: "woco.referrer-index.v1", subjects: [REFEREE] }), false);
  assert.equal(validateReferrerIndexV1({ format: "woco.referrer-index.v1", subjects: [S_REFEREE], count: 1 }), false);
});
