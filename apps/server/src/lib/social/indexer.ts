/**
 * The indexer — public feeds in, a recountable number out.
 *
 * It holds no truth. Every statement it reads is signed by its author and lives
 * at an address anyone can compute, so this process is a compiler over public
 * data, not a database. `.data` here is a cache; deleting it costs time, not
 * facts (`SWARM_SOCIAL_PLAN` commitment 6).
 *
 * What it CAN do is lie or omit, so it publishes its working. The evidence
 * manifest names the input set and the per-statement values used, which makes
 * a false count self-refuting on inspection and an omission detectable by the
 * person omitted. That is the whole trust model: not "believe the indexer", but
 * "the indexer cannot lie undetectably, and you can run your own".
 *
 * ADDRESSING NOTE, because it looks like a missing field: an evidence leaf
 * carries no chunk address, and does not need one. Topic derives from
 * (`statementFormat`, `subject`) by the public scheme, and a chunk address is
 * `keccak256(identifier || owner)` where the identifier folds in the version —
 * both of which the leaf already carries. The leaf therefore points at the
 * author's actual signed chunk, by derivation rather than by restating it.
 *
 * That was true of boolean leaves and FALSE of carried-total ones until
 * `CarriedEvidenceLeaf.version` was added: a credit leaf carried `seq`, which
 * is the holder's ordering and continues across the private→public topic
 * migration, while the version is the feed's and restarts at 0. A reader
 * following this note with only `seq` would have derived the wrong identifier
 * and then walked versions from zero to find the right one — the absent-chunk
 * probe class this file is otherwise careful to avoid.
 */

import {
  likeStatementTopic,
  followStatementTopic,
  creditStatementTopic,
  creditPublicSalt,
  creditStatementDigest,
  validateLikeStatementV1,
  validateFollowStatementV1,
  verifyCreditStatement,
  tallyBooleanStatements,
  tallyCarriedTotals,
  booleanEvidenceManifest,
  carriedEvidenceManifest,
  type ObservedStatement,
  type EvidenceManifestV1,
  type BooleanEvidenceLeaf,
  type CarriedEvidenceLeaf,
  type CreditStatementV1,
  type Hex0x,
} from "@woco/shared";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { VersionedFeedRead } from "@woco/shared";
import { readBandedContentFeedJsonResult } from "../swarm/soc-upload.js";
import { participantsFor } from "./participants.js";

export type IndexableFormat = "woco.like.v1" | "woco.follow.v1" | "woco.credit.v1";

/** Every format this indexer can tally, in one place. Read surfaces validate
 *  against it and the publisher sweeps it — a list that exists twice is a list
 *  that will eventually disagree with itself about what gets counted. */
export const INDEXABLE_FORMATS: readonly IndexableFormat[] = ["woco.like.v1", "woco.follow.v1", "woco.credit.v1"];

/**
 * How a participant's feed gets read. Injected for the same reason
 * `SiteConfigReaders` is (`site/service.ts`): the properties worth pinning here
 * are the failure ones — an unreadable feed counted as a GAP rather than as
 * silence, a thrown read not taking the tally down with it — and a live Swarm
 * read cannot be made to fail on demand. Defaults to the real reader, so no
 * call site changes.
 */
export type StatementFeedReader = (
  ownerHex: string,
  topicForBand: (band: number) => string,
) => Promise<VersionedFeedRead & { band: number }>;

export interface IndexResult {
  manifest: EvidenceManifestV1<BooleanEvidenceLeaf> | EvidenceManifestV1<CarriedEvidenceLeaf>;
  /**
   * Participants whose feed could not be READ this pass — distinct from those
   * read and found silent. Deliberately outside the manifest and surfaced
   * alongside it: a count computed over an incomplete read is still the best
   * available answer, but presenting it as complete would be the lie the whole
   * evidence apparatus exists to prevent.
   */
  unreadable: string[];
  /** Holders who signed two statements at one seq. Empty for boolean types. */
  equivocations: string[];
}

/**
 * Does this statement say it is about the subject being tallied?
 *
 * The address already binds it — the topic derives from the subject — so this
 * looks redundant, and for a long time the argument was that a mislabelled
 * write buys its author exactly the one vote a correct write would.
 *
 * That argument does not survive carried totals, and it never survived
 * publication. A rider can sign a statement naming ANOTHER subject with any
 * total they like and store it at this subject's head: the signature verifies,
 * the schema is closed and valid, and the total lands in this coaster's count.
 * Worse, the evidence is now spot-checkable — a reader fetching that entry
 * finds a statement about a different coaster and the page correctly calls it a
 * contradiction, so a manufactured red banner sits over an honest count.
 *
 * An acceptance rule that a verifier disagrees with is not a small
 * inconsistency; it is a way to make the honest path look dishonest. So the
 * indexer checks what the reader checks, for both statement families.
 *
 * Both sides are lowercase already — the frozen topic scheme rejects a subject
 * that is not (`subjectToBytes` throws before a topic exists), and every
 * statement validator pins the same lowercase form. The normalisation here is
 * belt-and-braces against a validator that ever loosens, not a live concern.
 */
function isAboutSubject(statement: { subject: string }, subject: Hex0x): boolean {
  return statement.subject.toLowerCase() === subject.toLowerCase();
}

/**
 * A subject's topic FAMILY, one topic per band.
 *
 * Like and follow feeds never leave band 0 — they are latest-wins, so a feed
 * gains a version per toggle, not per action — and their topic helpers bake
 * that in. Credits genuinely band, so an indexer has to walk to the open one;
 * deriving only band 0 would tally a rider's first 64 laps and silently stop.
 */
function topicForBand(format: IndexableFormat, subject: Hex0x): (band: number) => string {
  switch (format) {
    case "woco.like.v1":
      return () => likeStatementTopic(subject);
    case "woco.follow.v1":
      return () => followStatementTopic(subject);
    case "woco.credit.v1":
      // PUBLIC salt only. A private credit lives at a topic derived from a key
      // only the rider holds, so it is not merely skipped here — it is
      // unaddressable, which is the property the salted topic was for.
      return (band) => creditStatementTopic(creditPublicSalt(), subject, band);
  }
}

/**
 * How many participant feeds are read at once.
 *
 * Deliberately small, and not an arbitrary number. Each read ends in a probe
 * for a version that does not exist, which `swarm/soc.ts:358-367` records as
 * the most expensive read this node performs — and a fan-out that launched one
 * per participant would put the whole participant list on the wire
 * simultaneously. The tally cache bounds how OFTEN a fan-out happens; it does
 * nothing about how WIDE each one is, which is what this bounds.
 *
 * Sized under `beeUploadSem`'s 6 (upload-queue.ts) so a tally cannot crowd out
 * the writes it exists to count.
 */
const READ_CONCURRENCY = 4;

/**
 * Map with a bounded number of in-flight tasks, preserving input order.
 * Sequential workers over a shared cursor — no library, and no batching (which
 * would idle every worker waiting on the slowest member of each batch).
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Content digest of exactly the bytes read — `keccak256(payload)`, over the raw
 * stored bytes with no prefix and no re-encoding.
 *
 * FROZEN by publication, not by the statement schema: a boolean leaf's digest
 * never orders anything (the SOC version does that) and never gates acceptance,
 * so the schema has no opinion on it. But `tally.ts` promises that two indexers
 * with the same inputs publish byte-identical manifests, and a second indexer
 * cannot honour that against a recipe defined only in our source. See
 * BOOLEAN_LEAF_DIGEST_RECIPE in the shared tally module, which states it.
 */
function bytesDigest(bytes: Uint8Array): Hex0x {
  return `0x${bytesToHex(keccak_256(bytes))}` as Hex0x;
}

/**
 * Tally one subject by reading every known participant's feed.
 *
 * One versioned read per participant: the head IS the current statement for
 * boolean types (latest version wins) and the highest `seq` for credits, since
 * both advance together on a given feed. A holder writing from two devices is
 * handled by the tally, which takes the max across feeds.
 */
export async function indexSubject(
  format: IndexableFormat,
  subject: Hex0x,
  readFeed: StatementFeedReader = readBandedContentFeedJsonResult,
): Promise<IndexResult> {
  const participants = participantsFor(format, subject);
  const topics = topicForBand(format, subject);
  const unreadable: string[] = [];

  const reads = await mapLimit(participants, READ_CONCURRENCY, async (owner) => {
    try {
      const res = await readFeed(owner, topics);
      if (res.status === "found") return { owner, bytes: res.bytes, version: res.version, band: res.band };
      // `absent` means read successfully and empty — the participant is
      // declared but contributed nothing. Only `unavailable` is a gap.
      if (res.status === "unavailable") unreadable.push(owner);
      return null;
    } catch {
      unreadable.push(owner);
      return null;
    }
  });

  const found = reads.filter((r): r is NonNullable<typeof r> => r !== null);

  // Gaps arrive from concurrent workers, so their order is a race. They are
  // served as part of the same evidence object as the manifest, and evidence
  // that reshuffles between two identical passes is not comparable — the same
  // reason `tally.ts` sorts its leaves and participants.
  unreadable.sort();

  if (format === "woco.credit.v1") {
    const observed: ObservedStatement<CreditStatementV1>[] = [];
    for (const r of found) {
      const parsed = parseJson(r.bytes);
      // Full acceptance: dispatch, closed-schema validation, then holderSig.
      // A statement naming a holder it was not signed by is exactly what this
      // check exists to reject, and it is the only thing standing between a
      // count and anyone writing anyone else's history into their own feed.
      if (!verifyCreditStatement(parsed)) continue;
      if (!isAboutSubject(parsed, subject)) continue;
      const { holderSig: _sig, ...unsigned } = parsed;
      observed.push({
        feedOwner: r.owner as Hex0x,
        version: r.version,
        band: r.band,
        // The FROZEN digest, not a digest of the bytes: closure 5's tie-break
        // is defined over this exact value, so using anything else would make
        // our tie-breaks disagree with an honest second indexer's.
        digest: `0x${bytesToHex(creditStatementDigest(unsigned))}` as Hex0x,
        statement: parsed,
      });
    }
    const tally = tallyCarriedTotals(observed);
    return {
      manifest: carriedEvidenceManifest({ statementFormat: format, subject, participants: participants as Hex0x[], tally }),
      unreadable,
      equivocations: tally.equivocations,
    };
  }

  const validate = format === "woco.like.v1" ? validateLikeStatementV1 : validateFollowStatementV1;
  const observed: ObservedStatement<{ value: boolean }>[] = [];
  for (const r of found) {
    const parsed = parseJson(r.bytes);
    // No signature check here, and that is not an oversight: for boolean types
    // the author IS the feed owner, so the SOC's own secp256k1 signature —
    // already verified by Bee on retrieval — is the authorship proof. An extra
    // identity signature would be schema surface without a guarantee.
    if (!validate(parsed)) continue;
    if (!isAboutSubject(parsed, subject)) continue;
    observed.push({
      feedOwner: r.owner as Hex0x,
      version: r.version,
      band: r.band,
      digest: bytesDigest(r.bytes),
      statement: parsed,
    });
  }

  const tally = tallyBooleanStatements(observed);
  return {
    manifest: booleanEvidenceManifest({ statementFormat: format, subject, participants: participants as Hex0x[], tally }),
    unreadable,
    equivocations: [],
  };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
