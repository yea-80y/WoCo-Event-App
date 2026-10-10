/**
 * The Swarm-native referral campaign (#476): formats, topics and closed
 * schemas. It replaced an EAS attestation rail, deleted with the rest of the
 * platform's EAS code on 2026-09-13.
 *
 * THREE RECORDS, THREE SIGNERS — who can honestly assert a fact decides whose
 * feed it lives in:
 *   · `woco.referral.v1` — the REFEREE's own feed. "I was referred by R" is a
 *     claim only the referee is entitled to make, and one the platform can
 *     afford to be wrong about.
 *   · `woco.referral-confirmation.v1` — the CAMPAIGN ISSUER's feed. That the
 *     referee reached the state the campaign pays for is something only the
 *     server sees, so the referee must not be able to write it.
 *   · `woco.badge.v1` — the issuer's feed as well: a self-attested "I am early"
 *     proves nothing, and the badge's entire value is that the platform vouches.
 *
 * NO INNER SIGNATURE on any of them — the same call `discipline.ts` makes for
 * likes and for evidence reports. Each record is stored as a single-owner
 * chunk, so the SOC signature already binds these exact bytes to that writer's
 * key at that exact topic and version; an identity signature would be schema
 * surface with no added guarantee. The consequence to carry around: the
 * signature lives in the CHUNK, so anything mirroring a record must move raw
 * chunk bytes, never re-serialised JSON.
 *
 * UNIQUENESS IS THE WRITE-ONCE SOC, not a lock. A confirmation is written at
 * VERSION 0 of a topic keyed by the REFEREE: the first write at a version wins
 * and a later one is silently discarded (201, old payload kept). "One referrer
 * per referee, first confirmed wins" is therefore enforced by Swarm rather than
 * by server state a restart can lose. It obliges the WRITER to read back — a
 * write that returned success may not be what landed, and paying a revenue
 * share against the echo of a discarded write is the exact failure this shape
 * exists to prevent.
 *
 * ONE FEED PINNED, TWO BANDED. The referee's statement feed is latest-wins (a
 * referral is set or retracted, never accumulated), so it has no growth axis
 * and pins to band 0 exactly as likes and follows do — it must never be
 * band-walked. Both indexes genuinely grow, one version per new subject and
 * nothing ever removed, so they band under the full-band invariant and are
 * discovered by walking openers.
 *
 * A SEPARATE CAMPAIGN KEY, not the indexer's. The indexer publishes counts,
 * which anyone can recompute and nobody gains by forging. These records decide
 * who receives a revenue share. Different blast radius, different key.
 *
 * `stripeCompletedAt` from the design comment is deliberately ABSENT. The
 * server holds `createdAt` and `updatedAt` for a connected account and nothing
 * else, and `updatedAt` also moves on a currency change — so the field could
 * only ever be filled with a timestamp that means something other than its
 * name. `confirmedAt` is when the issuer saw both preconditions, which is the
 * claim it can actually make.
 *
 * `refereeFeed` IS present, and it is a discovery binding, not a claim about
 * possession. The referee's statement lives on their content-feed signer's
 * feed, and nothing maps an account to that signer — client-owned profiles are
 * read only through a signer carried on some platform record (`api/profiles.ts`
 * resolves them "WITHOUT a registry"). The confirmation is that carrier for
 * referrals, in the role `creatorFeedSigner` plays on the site events index:
 * with it, a verifier holding only this chunk can open the referee's own
 * statement under that owner. It is accepted from the authenticated referee on
 * the rule `routes/sites.ts` already states for `siteFeedSigner` — a user's own
 * claim about their own feed can only resolve that signer's namespace at THIS
 * record's key, so it cannot be aimed at anyone else's confirmation — and the
 * server reads the statement it names before writing, so the carrier never
 * points at nothing.
 *
 * Payloads stay JSON-canonical with ISO-millisecond timestamps so a later
 * Merkle anchor over confirmation chunks is a tree over bytes that already
 * round-trip, with no canonicalisation step left to get wrong.
 */

import { utf8ToBytes } from "@noble/hashes/utils.js";
import {
  publicTopicSalt,
  statementTopic,
  subjectIndexTopic,
  subjectToBytes,
  validateSubjectIndexV1,
  type SubjectIndexV1,
} from "../statement/discipline.js";
import { socialProfileSubject } from "../social/subject.js";
import type { Hex0x } from "../types.js";

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export const REFERRAL_STATEMENT_FORMAT = "woco.referral.v1" as const;
export const REFERRAL_SUBJECT_INDEX_FORMAT = "woco.referral-index.v1" as const;
export const REFERRAL_CONFIRMATION_FORMAT = "woco.referral-confirmation.v1" as const;
export const BADGE_FORMAT = "woco.badge.v1" as const;
export const REFERRER_INDEX_FORMAT = "woco.referrer-index.v1" as const;

/** Topic-scheme type names (`[a-z0-9-]+`) — distinct from the dotted format ids. */
const REFERRAL_TYPE = "referral";
const CONFIRMATION_TYPE = "referral-confirmation";
const BADGE_TYPE = "badge";
const REFERRER_INDEX_TYPE = "referrer-index";
const CAMPAIGN_VERSION = 1;

/**
 * The closed list of badge kinds. A kind outside it has no address and no
 * schema: a typo must fail loudly rather than mint a badge at an address
 * nothing reads.
 */
export const BADGE_KINDS = ["joined"] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

/**
 * The key that signs confirmations and badges — derived from
 * `CAMPAIGN_ISSUER_PRIVATE_KEY` on the server, pinned here so a server whose
 * key derives anything else refuses to publish instead of writing records into
 * an address space no reader looks at.
 *
 * Deliberately NOT the social indexer's address: that key publishes
 * recomputable counts, this one decides who is paid.
 */
export const CAMPAIGN_ISSUER_ADDRESS = "0xe34fa431d1639468f8420ae3471cb8374aa99249" as Hex0x;

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/**
 * The subject for an account in campaign records — the SAME derivation the
 * social rail uses, delegated rather than restated.
 *
 * A second definition is the one failure nothing detects: a referral and a
 * follow of the same account would key different bytes, both sides would verify
 * perfectly, and a third party reading the social scheme would land on nothing.
 */
export function campaignAccountSubject(address: string): Hex0x {
  return socialProfileSubject(address);
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/**
 * Three of the five families are PINNED to band 0. The referee's statement is
 * latest-wins, the follow scheme exactly; the confirmation is write-once; a
 * badge gains a version only on revocation. None has a growth axis, so none
 * bands — and a pinned family must never be handed to a band walk, because
 * every opener probe would address the same chunk.
 */
const PINNED_BAND = 0;

export function referralStatementTopic(subject: Hex0x): string {
  return statementTopic(
    REFERRAL_TYPE, CAMPAIGN_VERSION, publicTopicSalt(REFERRAL_TYPE, CAMPAIGN_VERSION),
    subjectToBytes(subject), PINNED_BAND,
  );
}

/** The referee's per-holder subject index — banded, because it grows per subject. */
export function referralSubjectIndexTopic(band: number): string {
  return subjectIndexTopic(REFERRAL_TYPE, CAMPAIGN_VERSION, publicTopicSalt(REFERRAL_TYPE, CAMPAIGN_VERSION), band);
}

/**
 * Keyed by the REFEREE, which is what makes the write-once SOC a uniqueness
 * primitive: one referee has one address in the issuer's space, so a second
 * referrer claiming the same referee races for a version that is already taken.
 */
export function referralConfirmationTopic(refereeSubject: Hex0x): string {
  return statementTopic(
    CONFIRMATION_TYPE, CAMPAIGN_VERSION, publicTopicSalt(CONFIRMATION_TYPE, CAMPAIGN_VERSION),
    subjectToBytes(refereeSubject), PINNED_BAND,
  );
}

/**
 * The badge KIND folds into the salt, the way `evidenceReportTopic` folds the
 * format it tallies: one topic for every kind would put unrelated badges at one
 * address, where each write overwrites the last.
 */
export function badgeTopic(subject: Hex0x, kind: BadgeKind): string {
  // Checked BEFORE deriving: an unknown kind must have no address at all.
  if (!(BADGE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown badge kind ${JSON.stringify(kind)}`);
  }
  const salt = utf8ToBytes(`woco-${BADGE_TYPE}-public-v${CAMPAIGN_VERSION}-${kind}`);
  return statementTopic(BADGE_TYPE, CAMPAIGN_VERSION, salt, subjectToBytes(subject), PINNED_BAND);
}

/**
 * The issuer's list of confirmed referees for one REFERRER. BANDED rather than
 * pinned: it gains a version per confirmation and entries are never removed, so
 * it has a real growth axis and must respect the full-band invariant.
 */
export function referrerIndexTopic(referrerSubject: Hex0x, band: number): string {
  return statementTopic(
    REFERRER_INDEX_TYPE, CAMPAIGN_VERSION, publicTopicSalt(REFERRER_INDEX_TYPE, CAMPAIGN_VERSION),
    subjectToBytes(referrerSubject), band,
  );
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * `value: false` is the retraction, never a deletion — a SOC cannot be deleted
 * and an absent statement is indistinguishable from one that never existed.
 */
export interface ReferralStatementV1 {
  format: typeof REFERRAL_STATEMENT_FORMAT;
  /** The REFERRER's account subject — see {@link campaignAccountSubject}. */
  subject: Hex0x;
  value: boolean;
}

export type ReferralSubjectIndexV1 = SubjectIndexV1<typeof REFERRAL_SUBJECT_INDEX_FORMAT>;

/**
 * Addresses rather than subjects, because this is the record a payout is
 * reconciled against and an address is the form every other money-path store
 * already speaks. The topic keys the referee; carrying both here means a reader
 * holding only the chunk knows who is owed without a reverse derivation.
 */
export interface ReferralConfirmationV1 {
  format: typeof REFERRAL_CONFIRMATION_FORMAT;
  referee: Hex0x;
  /** The content-feed signer whose feed holds the referee's statement — see the header. */
  refereeFeed: Hex0x;
  referrer: Hex0x;
  /** `Date#toISOString` exactly — see the Merkle-anchor note in the header. */
  confirmedAt: string;
}

export interface BadgeV1 {
  format: typeof BADGE_FORMAT;
  subject: Hex0x;
  badge: BadgeKind;
  /** A platform-defined campaign window, not clock math. */
  epoch: number;
  /** `false` revokes — the abuse escape hatch for badges minted by bots. */
  value: boolean;
}

/** Entries are REFEREE subjects; each resolves to a confirmation the reader verifies itself. */
export type ReferrerIndexV1 = SubjectIndexV1<typeof REFERRER_INDEX_FORMAT>;

// ---------------------------------------------------------------------------
// Strict validation — closed schema, dispatch-before-validation
// ---------------------------------------------------------------------------

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;
/** Lowercase only: a checksummed twin of the same account would read as a second party. */
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Shape AND round-trip. The shape alone accepts `2026-13-45T…`, which parses to
 * nothing; the round-trip is what makes the stored bytes the only spelling of
 * that instant, so a Merkle anchor over them is deterministic.
 */
function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function validateReferralStatementV1(value: unknown): value is ReferralStatementV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 3 || keys[0] !== "format" || keys[1] !== "subject" || keys[2] !== "value") return false;
  if (o.format !== REFERRAL_STATEMENT_FORMAT) return false;
  if (typeof o.subject !== "string" || !SUBJECT_RE.test(o.subject)) return false;
  return typeof o.value === "boolean";
}

export function validateReferralSubjectIndexV1(value: unknown): value is ReferralSubjectIndexV1 {
  return validateSubjectIndexV1(value, REFERRAL_SUBJECT_INDEX_FORMAT);
}

export function validateReferralConfirmationV1(value: unknown): value is ReferralConfirmationV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 5) return false;
  if (keys[0] !== "confirmedAt" || keys[1] !== "format" || keys[2] !== "referee") return false;
  if (keys[3] !== "refereeFeed" || keys[4] !== "referrer") return false;
  if (o.format !== REFERRAL_CONFIRMATION_FORMAT) return false;
  if (typeof o.referee !== "string" || !ADDRESS_RE.test(o.referee)) return false;
  if (typeof o.refereeFeed !== "string" || !ADDRESS_RE.test(o.refereeFeed)) return false;
  if (typeof o.referrer !== "string" || !ADDRESS_RE.test(o.referrer)) return false;
  // A self-referral is not a record this issuer would ever write, so bytes
  // claiming one are foreign — refused at the schema, not left to policy.
  if (o.referee === o.referrer) return false;
  return isIsoInstant(o.confirmedAt);
}

export function validateBadgeV1(value: unknown): value is BadgeV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 5) return false;
  if (keys[0] !== "badge" || keys[1] !== "epoch" || keys[2] !== "format") return false;
  if (keys[3] !== "subject" || keys[4] !== "value") return false;
  if (o.format !== BADGE_FORMAT) return false;
  if (typeof o.badge !== "string" || !(BADGE_KINDS as readonly string[]).includes(o.badge)) return false;
  if (typeof o.epoch !== "number" || !Number.isSafeInteger(o.epoch) || o.epoch < 0) return false;
  if (typeof o.subject !== "string" || !SUBJECT_RE.test(o.subject)) return false;
  return typeof o.value === "boolean";
}

export function validateReferrerIndexV1(value: unknown): value is ReferrerIndexV1 {
  return validateSubjectIndexV1(value, REFERRER_INDEX_FORMAT);
}
