/**
 * A strict read of the caller's likes or follows, for the one caller that WRITES from
 * the answer: the passkey upgrade moves them to a new feed (#746). Its own file so the
 * likes button's first load does not carry it.
 */

import { readContentFeedResult, readBandedContentFeed } from "../swarm/content-feed.js";
import { settleInBatches } from "../utils/settle-in-batches.js";
import type { FollowStatementV1, FollowSubjectIndexV1, Hex0x, LikeStatementV1, LikeSubjectIndexV1 } from "@woco/shared";
import { KINDS, type SocialKind, type SocialSigner } from "./social-core.js";

/**
 * The subjects `signer` holds `true` for now, for a caller that WRITES from the
 * answer (the passkey upgrade moves them to a new feed, #746): "unavailable" when
 * any read could not answer, so a partial list is never acted on. Thorough, and a
 * head is trusted only from a conclusive scan - a retraction is a later version.
 */
/** One statement of `signer`'s, read thorough: `null` = none; a head from an
 *  inconclusive scan is "unavailable", since a later version may say otherwise. */
export async function readStatementStrict(
  signer: Pick<SocialSigner, "address">,
  kind: SocialKind,
  subject: Hex0x,
): Promise<boolean | null | "unavailable"> {
  const k = KINDS[kind];
  const res = await readContentFeedResult<unknown>(signer.address, k.statementTopic(subject), {
    route: k.route,
    skipLegacy: true,
    thorough: true,
  });
  if (res.status === "absent") return null;
  if (res.status !== "found" || !res.scanClean) return "unavailable";
  return k.validate(res.value) ? (res.value as LikeStatementV1 | FollowStatementV1).value : null;
}

export async function readLiveSubjects(
  signer: Pick<SocialSigner, "address">,
  kind: SocialKind,
): Promise<Hex0x[] | "unavailable"> {
  const k = KINDS[kind];
  const index = await readBandedContentFeed<unknown>(signer.address, k.indexTopic, { route: k.route, thorough: true });
  if (index.status === "absent") return [];
  if (index.status !== "found" || !index.bandClean || !k.validateIndex(index.value)) return "unavailable";
  const subjects = (index.value as LikeSubjectIndexV1 | FollowSubjectIndexV1).subjects;
  const reads = await settleInBatches(subjects, 4, (subject) =>
    readContentFeedResult<unknown>(signer.address, k.statementTopic(subject), {
      route: k.route,
      skipLegacy: true,
      thorough: true,
    }),
  );
  const live: Hex0x[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const read = reads[i];
    if (read.status !== "fulfilled" || read.value.status === "unavailable") return "unavailable";
    if (read.value.status !== "found") continue;
    if (!read.value.scanClean) return "unavailable";
    const value = read.value.value;
    if (k.validate(value) && (value as LikeStatementV1 | FollowStatementV1).value === true) live.push(subjects[i]);
  }
  return live;
}
