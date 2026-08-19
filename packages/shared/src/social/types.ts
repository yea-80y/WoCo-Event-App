/**
 * `woco.like.v1` / `woco.follow.v1` — FROZEN at P0 (2026-08-14). Chain-free
 * Swarm-native social statements (docs/SWARM_SOCIAL_PLAN.md; design record in
 * docs/COASTER_CREDITS_PLAN.md "FROZEN AT P0"). This module deliberately does
 * NOT extend `../likes/` — that is the SUPERSEDED on-chain EAS projection,
 * kept for its abuse model; social carries no chain dependency. The
 * identity-level profile-subject derivation in `likes/subject.ts`
 * (`profileSubject`, the real L2Registry namehash) survives the EAS
 * retirement and remains the intended bytes32 for profile subjects.
 *
 * Why these payloads have NO holder, NO holderSig and NO seq, where a credit
 * has all three: here the author IS the feed owner, so the SOC signature
 * already binds authorship and the SOC version sequence (contiguous,
 * immutable) already orders. Stakes-driven tiering: a like is low-stakes and
 * rides the storage key alone; an identity signature would be schema surface
 * without a guarantee. If likes ever feed a gate, that is a NEW format with a
 * holder signature — not a field added here (the schema is CLOSED).
 */

import type { Hex0x } from "../types.js";
import {
  publicTopicSalt,
  statementTopic,
  subjectIndexTopic,
  subjectToBytes,
  validateSubjectIndexV1,
  type SubjectIndexV1,
} from "../statement/discipline.js";

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export const LIKE_STATEMENT_FORMAT = "woco.like.v1" as const;
export const FOLLOW_STATEMENT_FORMAT = "woco.follow.v1" as const;
export const LIKE_SUBJECT_INDEX_FORMAT = "woco.like-index.v1" as const;
export const FOLLOW_SUBJECT_INDEX_FORMAT = "woco.follow-index.v1" as const;

const LIKE_TYPE = "like";
const FOLLOW_TYPE = "follow";
const SOCIAL_VERSION = 1;

// ---------------------------------------------------------------------------
// Payloads — one CURRENT statement per (author, subject), latest SOC version
// wins (SWARM_SOCIAL_PLAN commitment 3: current state, not history)
// ---------------------------------------------------------------------------

/**
 * `value: false` is the overwrite that "unlike = overwrite" requires — an
 * absent statement cannot be distinguished from one that never existed, so
 * retraction must be a written value, not a deletion (SOCs cannot be deleted
 * anyway). Indexers count only the latest version, and only `value: true`.
 */
export interface LikeStatementV1 {
  format: typeof LIKE_STATEMENT_FORMAT;
  /** bytes32, 0x-prefixed lowercase. Per-subject-kind derivation is #172's
   *  build (profiles: `profileSubject` in likes/subject.ts). */
  subject: Hex0x;
  value: boolean;
}

export interface FollowStatementV1 {
  format: typeof FOLLOW_STATEMENT_FORMAT;
  subject: Hex0x;
  value: boolean;
}

// ---------------------------------------------------------------------------
// Topics — PUBLIC types: the salt is pinned to the public constant. A like
// that nobody can count is not a feature; there is no private tier here.
// ---------------------------------------------------------------------------

/**
 * Social STATEMENT feeds are PINNED to band 0 — they share the banded topic
 * derivation at a constant, but they are not banded feeds.
 *
 * Why that is sound: a like is latest-wins (commitment 3), so its feed gains a
 * version per TOGGLE, not per action, and has no growth axis to bound.
 *
 * What it does NOT mean, stated because the obvious reading is wrong: band 0
 * here is not capped at {@link STATEMENT_BAND_SIZE} versions. A writer never
 * opens band 1, so a user who toggles one subject 64+ times simply keeps
 * appending inside band 0. Shipped readers are unaffected — no scan has a
 * ceiling — but a third party building to the full-band invariant would be
 * misled, so: THE FULL-BAND INVARIANT GOVERNS ONLY FEEDS THAT BAND. For a
 * pinned type, "band count derives from write count" does not hold.
 *
 * A pinned family must never be handed to `resolveOpenBand`: every opener probe
 * would address the same chunk and the walk could not terminate.
 */
const SOCIAL_STATEMENT_BAND = 0;

export function likeStatementTopic(subject: Hex0x): string {
  return statementTopic(
    LIKE_TYPE, SOCIAL_VERSION, publicTopicSalt(LIKE_TYPE, SOCIAL_VERSION),
    subjectToBytes(subject), SOCIAL_STATEMENT_BAND,
  );
}

/**
 * The social index DOES grow — one version per new subject, and subjects are
 * never removed — so unlike the statement feeds it is genuinely banded. With no
 * partition rule there is nothing read first to carry the band, so callers
 * discover it by walking openers under the full-band invariant.
 */
export function likeSubjectIndexTopic(band: number): string {
  return subjectIndexTopic(LIKE_TYPE, SOCIAL_VERSION, publicTopicSalt(LIKE_TYPE, SOCIAL_VERSION), band);
}

export function followStatementTopic(subject: Hex0x): string {
  return statementTopic(
    FOLLOW_TYPE, SOCIAL_VERSION, publicTopicSalt(FOLLOW_TYPE, SOCIAL_VERSION),
    subjectToBytes(subject), SOCIAL_STATEMENT_BAND,
  );
}

export function followSubjectIndexTopic(band: number): string {
  return subjectIndexTopic(FOLLOW_TYPE, SOCIAL_VERSION, publicTopicSalt(FOLLOW_TYPE, SOCIAL_VERSION), band);
}

export type LikeSubjectIndexV1 = SubjectIndexV1<typeof LIKE_SUBJECT_INDEX_FORMAT>;
export type FollowSubjectIndexV1 = SubjectIndexV1<typeof FOLLOW_SUBJECT_INDEX_FORMAT>;

export function validateLikeSubjectIndexV1(value: unknown): value is LikeSubjectIndexV1 {
  return validateSubjectIndexV1(value, LIKE_SUBJECT_INDEX_FORMAT);
}

export function validateFollowSubjectIndexV1(value: unknown): value is FollowSubjectIndexV1 {
  return validateSubjectIndexV1(value, FOLLOW_SUBJECT_INDEX_FORMAT);
}

// ---------------------------------------------------------------------------
// Strict validation — closed schema, dispatch-before-validation
// ---------------------------------------------------------------------------

const SUBJECT_RE = /^0x[0-9a-f]{64}$/;

function validateSocialStatement(value: unknown, format: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 3 || keys[0] !== "format" || keys[1] !== "subject" || keys[2] !== "value") return false;
  if (o.format !== format) return false;
  if (typeof o.subject !== "string" || !SUBJECT_RE.test(o.subject)) return false;
  return typeof o.value === "boolean";
}

export function validateLikeStatementV1(value: unknown): value is LikeStatementV1 {
  return validateSocialStatement(value, LIKE_STATEMENT_FORMAT);
}

export function validateFollowStatementV1(value: unknown): value is FollowStatementV1 {
  return validateSocialStatement(value, FOLLOW_STATEMENT_FORMAT);
}
