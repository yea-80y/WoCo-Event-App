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
  LAST_VERSION_IN_BAND,
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

    await addToSubjectIndex(kind, subject, signer);
    return { ok: true, value, confirmation: written.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that." };
  }
}

/** Re-reads of the index after losing a write race, before giving up. */
const INDEX_WRITE_ATTEMPTS = 3;

/**
 * Add `subject` to the caller's index for this kind, if absent.
 *
 * Subjects are never REMOVED. The index records which subjects have a live head
 * under this salt partition, not which are currently liked — a retraction is a
 * statement at that head, so the head stays live and the entry stays correct.
 * Removing it would hide a `false` the indexer needs in order to stop counting.
 *
 * This is a read-modify-write with no compare-and-swap underneath, so losing
 * the race has to be handled rather than assumed away. `writeContentFeedVerified`
 * serialises same-device writes per topic and reports `superseded` when another
 * writer took our version; the only sound response is to re-read and union,
 * because retrying with the list we already computed would rewrite stale data
 * over the winner.
 *
 * Failures are swallowed after that: the statement is already written and
 * valid, and "your like worked but its index entry did not" is noise the user
 * cannot act on. It costs enumeration of THIS subject until the user next
 * toggles it — a write for a different subject does not repair it.
 */
async function addToSubjectIndex(
  kind: SocialKind,
  subject: Hex0x,
  signer: { privKey: string; address: string },
): Promise<void> {
  const k = KINDS[kind];
  try {
    for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
      // BANDED. This index grows one version per new subject and subjects are
      // never removed, so unbanded it was the one structure here whose read cost
      // tracked how much a user had ever liked. Social has no partition rule and
      // so nothing read beforehand to carry a band hint — it is discovered by
      // walking band openers, which the full-band invariant makes sound.
      const res = await readBandedContentFeed<unknown>(signer.address, k.indexTopic);

      // Only `absent` may be treated as "no index yet". Writing a fresh one over
      // an index we merely FAILED to read would drop every subject it holds —
      // the lenient-read-on-a-write-path trap.
      let subjects: Hex0x[];
      if (res.status === "found") {
        if (!k.validateIndex(res.value)) return;
        subjects = (res.value as LikeSubjectIndexV1 | FollowSubjectIndexV1).subjects;
        if (subjects.includes(subject)) return;
        subjects = [...subjects, subject];
      } else if (res.status === "absent") {
        subjects = [subject];
      } else {
        return;
      }

      // The index's own rollover, on the same rule the statement feeds use: a
      // band opens only once its predecessor is full.
      // `>=`: an overshoot must not disable rollover permanently.
      const rollover = res.status === "found" && res.version >= LAST_VERSION_IN_BAND;
      const targetBand = rollover ? res.band + 1 : res.band;

      const written = await writeContentFeedVerified({
        signerPrivKey: signer.privKey,
        ownerAddress: signer.address,
        topic: k.indexTopic(targetBand),
        data: { format: k.indexFormat, subjects },
      });
      if (written.status !== "superseded") return;
    }
  } catch {
    // See doc comment — the statement stands regardless.
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
