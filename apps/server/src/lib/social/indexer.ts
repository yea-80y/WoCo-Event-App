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
import { readContentFeedJsonResult } from "../swarm/soc-upload.js";
import { participantsFor } from "./participants.js";

export type IndexableFormat = "woco.like.v1" | "woco.follow.v1" | "woco.credit.v1";

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

function topicFor(format: IndexableFormat, subject: Hex0x): string {
  switch (format) {
    case "woco.like.v1":
      return likeStatementTopic(subject);
    case "woco.follow.v1":
      return followStatementTopic(subject);
    case "woco.credit.v1":
      // PUBLIC salt only. A private credit lives at a topic derived from a key
      // only the rider holds, so it is not merely skipped here — it is
      // unaddressable, which is the property the salted topic was for.
      return creditStatementTopic(creditPublicSalt(), subject);
  }
}

/** Content digest of exactly the bytes read. Used for boolean types, where the
 *  digest only has to distinguish two statements, never to order them. */
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
export async function indexSubject(format: IndexableFormat, subject: Hex0x): Promise<IndexResult> {
  const participants = participantsFor(format, subject);
  const topic = topicFor(format, subject);
  const unreadable: string[] = [];

  const reads = await Promise.all(
    participants.map(async (owner) => {
      try {
        const res = await readContentFeedJsonResult(owner, topic);
        if (res.status === "found") return { owner, bytes: res.bytes, version: res.version };
        // `absent` means read successfully and empty — the participant is
        // declared but contributed nothing. Only `unavailable` is a gap.
        if (res.status === "unavailable") unreadable.push(owner);
        return null;
      } catch {
        unreadable.push(owner);
        return null;
      }
    }),
  );

  const found = reads.filter((r): r is NonNullable<typeof r> => r !== null);

  if (format === "woco.credit.v1") {
    const observed: ObservedStatement<CreditStatementV1>[] = [];
    for (const r of found) {
      const parsed = parseJson(r.bytes);
      // Full acceptance: dispatch, closed-schema validation, then holderSig.
      // A statement naming a holder it was not signed by is exactly what this
      // check exists to reject, and it is the only thing standing between a
      // count and anyone writing anyone else's history into their own feed.
      if (!verifyCreditStatement(parsed)) continue;
      const { holderSig: _sig, ...unsigned } = parsed;
      observed.push({
        feedOwner: r.owner as Hex0x,
        version: r.version,
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
    observed.push({
      feedOwner: r.owner as Hex0x,
      version: r.version,
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
