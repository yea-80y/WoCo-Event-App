/**
 * The referral campaign's CLIENT half (#476): the referee's own statement, and
 * direct reads of everything the issuer publishes.
 *
 * The rail this replaces routed every one of these facts through the server —
 * `/referrals/pending`, `/referrals/by`, `/badges/:address` — so the platform
 * was both the witness and the record. Here the records ARE the truth: each is
 * a single-owner chunk signed by the party entitled to assert it, and this
 * module addresses them directly. The server keeps exactly the two jobs Swarm
 * cannot do (see `api/campaign.ts`): report Stripe onboarding, and countersign.
 *
 * NOTHING HERE EVER PROMPTS. The statement is written at the referee's first
 * authenticated moment after following an invite — a moment they did not ask to
 * sign anything at — so the signer arrives from `getContentFeedSignerIfPresent`
 * and a device with no seed simply writes later. `referral-flow.ts` holds that
 * rule; this module is the half that touches Swarm.
 *
 * DEPS ARE INJECTED, and the reason is the shape of the bugs: which topic a
 * write lands on, whether the index write follows the statement, and — the one
 * that pays for the whole arrangement — that the confirmation is read at
 * VERSION 0 and not at the head. None of those is observable from a return
 * value, and all three are one-line edits away from being wrong.
 */

import {
  REFERRAL_STATEMENT_FORMAT,
  REFERRAL_SUBJECT_INDEX_FORMAT,
  CAMPAIGN_ISSUER_ADDRESS,
  addressFromProfileSubject,
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
  type BadgeV1,
  type Hex0x,
  type ReferralConfirmationV1,
  type ReferralStatementV1,
  type ReferralSubjectIndexV1,
  type ReferrerIndexV1,
} from "@woco/shared";
import {
  readBandedContentFeed,
  readContentFeedAtVersion,
  readContentFeedResult,
  type BandedContentFeedResult,
  type ContentFeedResult,
} from "../swarm/content-feed.js";
import { writeContentFeedVerified, type VerifiedWriteResult } from "../swarm/verified-write.js";
import { addToSubjectIndex } from "../social/subject-index.js";

/** The signer of the referee's own feed — key and owner address together. */
export interface CampaignSigner {
  privKey: string;
  address: string;
}

/** The referee's live statement, resolved to the address it names. */
export interface MyReferralStatement {
  referrer: Hex0x;
  /** The subject the statement is keyed by — the caller's index entry, kept so
   *  a caller never re-derives it and never derives it differently. */
  subject: Hex0x;
}

/**
 * The Swarm surface this module uses, as five named calls.
 *
 * Typed with `unknown` payloads rather than generics: every validator below
 * takes `unknown` anyway, and a generic member would force each test double to
 * be generic too — friction on the side of the seam that is supposed to be
 * cheap.
 */
export interface CampaignRecordDeps {
  readFeed: (
    owner: string,
    topic: string,
    opts?: { skipLegacy?: boolean; thorough?: boolean },
  ) => Promise<ContentFeedResult<unknown>>;
  readFeedAtVersion: (
    owner: string,
    topic: string,
    version: number,
    opts?: { thorough?: boolean },
  ) => Promise<ContentFeedResult<unknown>>;
  readBandedFeed: (
    owner: string,
    topicForBand: (band: number) => string,
    opts?: { hintBand?: number; thorough?: boolean },
  ) => Promise<BandedContentFeedResult<unknown>>;
  writeVerified: (args: {
    signerPrivKey: string;
    ownerAddress: string;
    topic: string;
    data: unknown;
  }) => Promise<VerifiedWriteResult>;
  addToIndex: (
    signer: CampaignSigner,
    subject: Hex0x,
    kind: {
      indexTopic: (band: number) => string;
      indexFormat: string;
      validateIndex: (value: unknown) => boolean;
    },
  ) => Promise<void>;
}

export const liveDeps: CampaignRecordDeps = {
  readFeed: (owner, topic, opts) => readContentFeedResult<unknown>(owner, topic, opts),
  readFeedAtVersion: (owner, topic, version, opts) =>
    readContentFeedAtVersion<unknown>(owner, topic, version, opts),
  readBandedFeed: (owner, topicForBand, opts) =>
    readBandedContentFeed<unknown>(owner, topicForBand, opts),
  writeVerified: (args) => writeContentFeedVerified(args),
  addToIndex: (signer, subject, kind) => addToSubjectIndex(signer, subject, kind),
};

/** The referee's index wiring, in one place so writer and reader cannot drift. */
const REFERRAL_INDEX = {
  indexTopic: referralSubjectIndexTopic,
  indexFormat: REFERRAL_SUBJECT_INDEX_FORMAT,
  validateIndex: validateReferralSubjectIndexV1,
} as const;

// ---------------------------------------------------------------------------
// The referee's own statement
// ---------------------------------------------------------------------------

/**
 * Write "I was referred by `referrer`" on the caller's OWN feed.
 *
 * Statement FIRST, index second — the same order and the same reason as likes
 * and follows: a failed index write leaves a statement that still stands and is
 * readable by anyone who knows the subject, whereas the other order publishes
 * an index entry pointing at nothing.
 *
 * `superseded` returns WITHOUT writing the index. It means another writer's
 * bytes are at our version, so our statement is lost, not late — indexing a
 * subject whose statement never landed would advertise a claim the feed does
 * not make. The caller keeps the capture and tries again later.
 *
 * IDEMPOTENT, by a head read first. The caller keeps the capture on every
 * outcome short of a confirmed write — including `unconfirmed`, a write the
 * gateway accepted but could not read back in time, which on Swarm is usually
 * propagation, not loss — and re-runs this on the next sign-in. Without this
 * read each such run would append one more version of the same statement.
 * With it, a live statement already on the feed is reported as `verified` at
 * its own version and only the index is (idempotently) ensured. A retracted
 * head is NOT a live statement and is written over.
 */
export async function writeReferralStatement(
  signer: CampaignSigner,
  referrer: Hex0x,
  deps: CampaignRecordDeps = liveDeps,
): Promise<VerifiedWriteResult> {
  const subject = campaignAccountSubject(referrer);
  const statement: ReferralStatementV1 = {
    format: REFERRAL_STATEMENT_FORMAT,
    subject,
    value: true,
  };

  const head = await deps.readFeed(signer.address, referralStatementTopic(subject), { skipLegacy: true });
  if (
    head.status === "found" &&
    validateReferralStatementV1(head.value) &&
    (head.value as ReferralStatementV1).value === true
  ) {
    await deps.addToIndex(signer, subject, REFERRAL_INDEX);
    return { status: "verified", version: head.version };
  }

  const written = await deps.writeVerified({
    signerPrivKey: signer.privKey,
    ownerAddress: signer.address,
    topic: referralStatementTopic(subject),
    data: statement,
  });
  if (written.status === "superseded") return written;

  await deps.addToIndex(signer, subject, REFERRAL_INDEX);
  return written;
}

/**
 * The caller's live referral statement, or null.
 *
 * Enumeration, not a lookup, because the client does not know which referrer to
 * ask about — the capture that started this may be long gone from localStorage
 * by the time the banner renders, and the feed is the only record left. So the
 * banded subject index is walked and each subject's head is opened.
 *
 * A DISPLAY read: `thorough` is deliberately off and nothing here feeds a
 * write. The worst a stale or gate-suppressed answer can do is hide the confirm
 * banner for one page load, and the server re-reads the statement itself before
 * it countersigns anything.
 *
 * `value: false` is a RETRACTION and is skipped rather than returned — the
 * index keeps the subject forever (the head stays live), so a retracted
 * referral is exactly the case where "first entry" and "live entry" differ.
 */
export async function readMyReferralStatement(
  ownerAddress: string,
  deps: CampaignRecordDeps = liveDeps,
): Promise<MyReferralStatement | null> {
  const index = await deps.readBandedFeed(ownerAddress, REFERRAL_INDEX.indexTopic);
  if (index.status !== "found" || !validateReferralSubjectIndexV1(index.value)) return null;

  for (const subject of (index.value as ReferralSubjectIndexV1).subjects) {
    const referrer = addressFromProfileSubject(subject);
    // A subject that is not address-shaped cannot name a referrer, whatever
    // else it is. Skipped, never thrown on: this is somebody's public feed and
    // one foreign entry must not blank the rest of the list.
    if (!referrer) continue;

    // `skipLegacy` — statement feeds were born versioned, so a pre-versioning
    // chunk cannot exist and probing for one spends a guaranteed missing-chunk
    // network search on every read.
    const res = await deps.readFeed(ownerAddress, referralStatementTopic(subject), {
      skipLegacy: true,
    });
    if (res.status !== "found" || !validateReferralStatementV1(res.value)) continue;
    if ((res.value as ReferralStatementV1).value !== true) continue;
    return { referrer, subject };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issuer-published records
// ---------------------------------------------------------------------------

/**
 * The issuer's confirmation for `referee`, or null.
 *
 * READ AT VERSION 0, EXACTLY — never at the head. The campaign's uniqueness
 * rule is "one referrer per referee, first confirmed wins", and it is enforced
 * by the write-once SOC at version 0 of this topic: a second confirmation
 * naming a different referrer is discarded by Bee, which returns 201 to the
 * writer anyway. Resolving the head would therefore read a LATER version — if
 * one ever exists, by bug or by mischief — and present it as the record a
 * revenue share is owed against, which is the single failure this shape exists
 * to prevent. Version 0 is the truth whatever else is on the feed.
 *
 * Null for absent, invalid AND unavailable. The three are worth separating for
 * a write path and this is not one: every caller is display, and an
 * inconclusive read shown as "not confirmed yet" costs a re-read on the next
 * visit, while the server's `/referrals/status` — which does distinguish them,
 * via `readOk` — is what the banner actually gates on.
 */
export async function readConfirmation(
  referee: Hex0x,
  deps: CampaignRecordDeps = liveDeps,
): Promise<ReferralConfirmationV1 | null> {
  const topic = referralConfirmationTopic(campaignAccountSubject(referee));
  const res = await deps.readFeedAtVersion(CAMPAIGN_ISSUER_ADDRESS, topic, 0);
  if (res.status !== "found" || !validateReferralConfirmationV1(res.value)) return null;
  return res.value as ReferralConfirmationV1;
}

/**
 * The issuer's badge for `address`, or null — a HEAD read, because a revocation
 * is a LATER version of the same topic (`value: false`, the abuse escape
 * hatch). Reading version 0 here would pin the badge to its minting and make
 * revocation unobservable, which is the exact inverse of the confirmation rule
 * above and the reason the two reads are written separately.
 *
 * The DISPLAY RULE is the caller's: this returns a revoked badge as faithfully
 * as a live one, and a surface that renders a stamp must check `value === true`
 * itself. Collapsing "revoked" into null here would leave no way to tell a
 * revoked badge from an account that never had one.
 */
export async function readBadge(
  address: Hex0x,
  deps: CampaignRecordDeps = liveDeps,
): Promise<BadgeV1 | null> {
  const topic = badgeTopic(campaignAccountSubject(address), "joined");
  const res = await deps.readFeed(CAMPAIGN_ISSUER_ADDRESS, topic, { skipLegacy: true });
  if (res.status !== "found" || !validateBadgeV1(res.value)) return null;
  return res.value as BadgeV1;
}

/**
 * Every referee the issuer has confirmed to `referrer`, as addresses.
 *
 * BANDED, unlike the three pinned families: this index gains a version per
 * confirmation and entries are never removed, so it has a real growth axis and
 * is discovered by walking band openers.
 *
 * Entries are subjects; the reverse derivation is exact for an address subject,
 * so no lookup table is needed. A subject that is not address-shaped is
 * dropped — this is a public feed and one foreign entry must not take the list
 * with it.
 */
export async function readReferrerIndex(
  referrer: Hex0x,
  deps: CampaignRecordDeps = liveDeps,
): Promise<Hex0x[]> {
  const subject = campaignAccountSubject(referrer);
  const res = await deps.readBandedFeed(CAMPAIGN_ISSUER_ADDRESS, (band) =>
    referrerIndexTopic(subject, band),
  );
  if (res.status !== "found" || !validateReferrerIndexV1(res.value)) return [];
  return (res.value as ReferrerIndexV1).subjects
    .map((s) => addressFromProfileSubject(s))
    .filter((a): a is Hex0x => a !== null);
}
