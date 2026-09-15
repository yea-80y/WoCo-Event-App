/**
 * Likes and follows as Swarm-native statements (P1 of docs/SWARM_SOCIAL_PLAN.md).
 *
 * The user signs with their own derived feed key and writes to their OWN feed.
 * Nothing here writes to shared state, because there is none to write to — a
 * Swarm feed has exactly one owner-signer. Counts are somebody else's problem
 * by design: an indexer reads public feeds and tallies them, and this module
 * deliberately answers only "what did *I* say about this subject", which is the
 * one question answerable from a single feed.
 *
 * Retraction is `value: false`, never a deletion. A SOC cannot be deleted, and
 * an absent statement is indistinguishable from one that never existed — so an
 * unlike has to be a written value or it cannot be observed at all.
 */

import { auth } from "../auth/auth-store.svelte.js";
import { readContentFeedResult, readBandedContentFeed } from "../swarm/content-feed.js";
import { writeContentFeedVerified, type VerifiedWriteResult } from "../swarm/verified-write.js";
import { addToSubjectIndex } from "./subject-index.js";
import { followsFromReads } from "./follows.js";
import { settleInBatches } from "../utils/settle-in-batches.js";
import {
  LIKE_STATEMENT_FORMAT,
  FOLLOW_STATEMENT_FORMAT,
  LIKE_SUBJECT_INDEX_FORMAT,
  FOLLOW_SUBJECT_INDEX_FORMAT,
  likeStatementTopic,
  likeSubjectIndexTopic,
  followStatementTopic,
  followSubjectIndexTopic,
  validateLikeStatementV1,
  validateFollowStatementV1,
  validateLikeSubjectIndexV1,
  validateFollowSubjectIndexV1,
  type LikeStatementV1,
  type FollowStatementV1,
  type LikeSubjectIndexV1,
  type FollowSubjectIndexV1,
  type Hex0x,
} from "@woco/shared";

export type SocialKind = "like" | "follow";

/** Per-kind wiring, so the two statement types share one code path without the
 *  call sites ever passing a topic string around (a mistyped topic writes a
 *  perfectly valid statement nobody will ever look for). */
const KINDS = {
  like: {
    format: LIKE_STATEMENT_FORMAT,
    indexFormat: LIKE_SUBJECT_INDEX_FORMAT,
    statementTopic: likeStatementTopic,
    indexTopic: likeSubjectIndexTopic,
    validate: validateLikeStatementV1,
    validateIndex: validateLikeSubjectIndexV1,
  },
  follow: {
    format: FOLLOW_STATEMENT_FORMAT,
    indexFormat: FOLLOW_SUBJECT_INDEX_FORMAT,
    statementTopic: followStatementTopic,
    indexTopic: followSubjectIndexTopic,
    validate: validateFollowStatementV1,
    validateIndex: validateFollowSubjectIndexV1,
  },
} as const;

export type SocialWriteResult =
  | { ok: true; value: boolean; confirmation: VerifiedWriteResult["status"] }
  | { ok: false; error: string };

async function requireSigner(): Promise<{ privKey: string; address: string }> {
  const signer = await auth.getContentFeedSigner();
  if (!signer) throw new Error("Sign in to like or follow — a statement is signed by your own key.");
  return { privKey: signer.privKey, address: signer.address };
}

/**
 * Read the caller's current statement about `subject`. `null` means they have
 * never written one — distinct from `false`, which is an explicit retraction.
 * A payload that fails strict validation reads as `null` rather than throwing:
 * the schema is CLOSED, so anything else at this address is foreign bytes, and
 * a display path should show "not liked", not an error.
 */
export async function readMyStatement(kind: SocialKind, subject: Hex0x): Promise<boolean | null> {
  const k = KINDS[kind];
  const signer = await auth.getContentFeedSigner();
  if (!signer) return null;

  // `skipLegacy`: statement feeds were born versioned, so a pre-versioning chunk
  // cannot exist — and here ABSENT is the ordinary case, since most subjects are
  // ones the user has never liked. Probing for a legacy chunk anyway spent a
  // guaranteed missing-chunk network search on every such read.
  const res = await readContentFeedResult<unknown>(signer.address, k.statementTopic(subject), {
    skipLegacy: true,
  });
  if (res.status !== "found") return null;
  return k.validate(res.value) ? (res.value as LikeStatementV1 | FollowStatementV1).value : null;
}

/**
 * Write the caller's statement about `subject`, then add the subject to their
 * per-kind index if it is not already there.
 *
 * Statement FIRST, index second, deliberately. If the index write fails the
 * statement still stands and is readable by anyone who knows the subject — only
 * enumeration is behind, and the next write repairs it. The other order would
 * publish an index entry pointing at a statement that does not exist.
 */
export async function writeMyStatement(
  kind: SocialKind,
  subject: Hex0x,
  value: boolean,
): Promise<SocialWriteResult> {
  const k = KINDS[kind];
  try {
    const signer = await requireSigner();
    const statement = { format: k.format, subject, value };

    const written = await writeContentFeedVerified({
      signerPrivKey: signer.privKey,
      ownerAddress: signer.address,
      topic: k.statementTopic(subject),
      data: statement,
    });

    if (written.status === "superseded") {
      return { ok: false, error: "Another device updated this at the same moment. Try again." };
    }

    await addToSubjectIndex(signer, subject, k);
    return { ok: true, value, confirmation: written.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that." };
  }
}

/** Every subject the caller has ever written a statement about, for this kind. */
export async function readMySubjects(kind: SocialKind): Promise<Hex0x[]> {
  const k = KINDS[kind];
  const signer = await auth.getContentFeedSigner();
  if (!signer) return [];
  const res = await readBandedContentFeed<unknown>(signer.address, k.indexTopic);
  if (res.status !== "found" || !k.validateIndex(res.value)) return [];
  return (res.value as LikeSubjectIndexV1 | FollowSubjectIndexV1).subjects;
}

/** The accounts a user follows now — see `readMyFollowsIfReady`. */
export type MyFollowsRead =
  | { status: "found"; accounts: Hex0x[]; unreadable: number }
  | { status: "unavailable" }
  | { status: "not-ready" };

/**
 * The accounts this user currently follows, for a screen that must never raise
 * a prompt: only a seed already on this device is used, and `not-ready` means
 * there is none yet. `readMySubjects` cannot serve here — its signer getter
 * prompts on web3 and passkey. The index never drops an account once followed,
 * so each statement is read (four at a time) to leave out the ones unfollowed.
 */
export async function readMyFollowsIfReady(): Promise<MyFollowsRead> {
  const k = KINDS.follow;
  const signer = await auth.getContentFeedSignerIfPresent();
  if (!signer) return { status: "not-ready" };
  const index = await readBandedContentFeed<unknown>(signer.address, k.indexTopic);
  if (index.status === "unavailable") return { status: "unavailable" };
  if (index.status !== "found" || !k.validateIndex(index.value)) {
    return { status: "found", accounts: [], unreadable: 0 };
  }
  const subjects = (index.value as FollowSubjectIndexV1).subjects;
  const reads = await settleInBatches(subjects, 4, (subject) =>
    readContentFeedResult<unknown>(signer.address, k.statementTopic(subject), { skipLegacy: true }),
  );
  const statements = reads.map((read) =>
    read.status === "fulfilled" ? read.value : ({ status: "unavailable" } as const),
  );
  return { status: "found", ...followsFromReads(subjects, statements) };
}
