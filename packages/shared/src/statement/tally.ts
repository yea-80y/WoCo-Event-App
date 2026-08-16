/**
 * The tally rules — how a set of signed statements becomes a public count.
 *
 * Pure and dependency-free on purpose. `SWARM_SOCIAL_PLAN` commitment 6 says
 * nothing may depend on data that exists only inside our server, and the
 * strongest form of that is a tally anyone can recompute in a browser from
 * public chunks. Everything here is a deterministic function of the statements
 * handed in.
 *
 * THE HONEST STATEMENT OF WHAT DETERMINISM BUYS, because it is routinely
 * overclaimed: the index is a deterministic function of the statements
 * INGESTED. No rule can canonicalise the input set — statements are
 * self-authenticating and re-hostable, so indexer A can hold one that B never
 * saw. That is what the evidence manifest is for: it publishes the inputs, so
 * two indexers' results are comparable and a missing statement is visible to
 * the person who wrote it. "Rebuildable identically" is true GIVEN THE SAME
 * INPUTS, and false as an unconditional claim.
 *
 * Two tally shapes, because the two statement families order differently:
 *
 *  - BOOLEAN (likes, follows). The author IS the feed owner, so the SOC version
 *    is a signed sequence number and latest-wins is just "highest version".
 *    Retraction is `value: false`, never a deletion.
 *  - CARRIED TOTAL (credits). The author is the ed25519 holder, who is NOT the
 *    feed owner, so ordering comes from the signed `seq` and ties resolve on
 *    the lower canonical digest.
 */

import type { Hex0x } from "../types.js";

/**
 * One statement as an indexer actually saw it: the payload plus where it was
 * read from. The provenance is not decoration — `version` is the ordering
 * authority for owner-authored types, and `digest` is both the tie-break input
 * and what an auditor re-derives to check the evidence.
 */
export interface ObservedStatement<T> {
  /** secp256k1 address owning the SOC the statement was read from. */
  feedOwner: Hex0x;
  /** SOC version it was read at. Contiguous and immutable, so it orders. */
  version: number;
  /** Canonical digest of the statement, lowercase 0x-prefixed bytes32. */
  digest: Hex0x;
  statement: T;
}

// ---------------------------------------------------------------------------
// Boolean statements — likes, follows
// ---------------------------------------------------------------------------

/** What the tally used for one participant, so a reader can re-derive it. */
export interface BooleanEvidenceLeaf {
  feedOwner: Hex0x;
  version: number;
  digest: Hex0x;
  value: boolean;
}

export interface BooleanTally {
  /** Participants whose CURRENT statement is `true`. */
  count: number;
  /** Every participant considered, including retractions — commitment 4's
   *  spot-check needs the whole input set, not only the ones that counted. */
  evidence: BooleanEvidenceLeaf[];
}

/**
 * Tally a boolean statement type for ONE subject.
 *
 * Latest-wins per feed owner: exactly one statement per owner survives, the one
 * at the highest SOC version. A same-version collision cannot happen on one
 * feed — a SOC is immutable, so the first write at a version is the only write
 * at that version — so unlike the carried-total case there is no tie to break.
 * If two arrive anyway the input is not from one feed and something upstream is
 * wrong, so it throws rather than silently picking.
 *
 * Retractions are COUNTED AS INPUT and excluded from the total. Dropping them
 * would make an unlike indistinguishable from never having liked, and an
 * auditor checking "am I in the count?" needs to see their `false` was read.
 */
export function tallyBooleanStatements<T extends { value: boolean }>(
  observed: readonly ObservedStatement<T>[],
): BooleanTally {
  const latest = new Map<string, ObservedStatement<T>>();

  for (const o of observed) {
    const key = o.feedOwner.toLowerCase();
    const held = latest.get(key);
    if (!held) {
      latest.set(key, o);
      continue;
    }
    if (o.version === held.version && o.digest !== held.digest) {
      throw new Error(
        `two different statements at version ${o.version} for ${key}: a SOC is immutable, so these cannot both have been read from one feed`,
      );
    }
    if (o.version > held.version) latest.set(key, o);
  }

  const evidence = [...latest.values()]
    .map((o) => ({
      feedOwner: o.feedOwner.toLowerCase() as Hex0x,
      version: o.version,
      digest: o.digest,
      value: o.statement.value,
    }))
    // Sorted so two indexers with the same inputs publish byte-identical
    // evidence — otherwise the manifests differ and nothing is comparable.
    .sort((a, b) => (a.feedOwner < b.feedOwner ? -1 : a.feedOwner > b.feedOwner ? 1 : 0));

  return { count: evidence.filter((e) => e.value).length, evidence };
}

// ---------------------------------------------------------------------------
// Carried totals — credits
// ---------------------------------------------------------------------------

/** The shape the carried-total tally needs. Structural, so it applies to any
 *  future holder-signed counting type without importing the credit schema. */
export interface CarriedTotalStatement {
  holder: string;
  seq: number;
  total: number;
}

export interface CarriedEvidenceLeaf {
  /** ed25519 holder key, hex no 0x — the identity the count accrues to. */
  holder: string;
  feedOwner: Hex0x;
  seq: number;
  /**
   * SOC version the statement was read at — NOT `seq`, and the distinction is
   * the whole reason this field exists. `seq` is the holder's own ordering and
   * continues across the private→public topic migration; the version is the
   * feed's, and restarts at 0 on the new topic. So a reader holding only `seq`
   * cannot address the chunk, and would have to walk versions from zero, ending
   * in the absent-chunk probe that is the most expensive read on the network.
   *
   * With it, a leaf points at the author's actual signed chunk by derivation:
   * topic from (statementFormat, subject), identifier from topic + version,
   * address = keccak256(identifier || owner). That is what makes an evidence
   * leaf spot-checkable by a stranger rather than merely re-addable.
   *
   * Legal to add because the manifest form is deliberately unfrozen (P0 item 7,
   * view plane) — unlike the statement schema, which is closed forever.
   */
  version: number;
  digest: Hex0x;
  /**
   * The value this leaf contributed. Commitment 4's "count = list length"
   * spot-check does NOT hold when a total is carried rather than summed, so the
   * manifest has to carry the per-statement values it used or it proves nothing.
   */
  total: number;
}

export interface CarriedTotalTally {
  /** Distinct holders with at least one statement — "how many people". */
  holders: number;
  /** Sum of each holder's current total — "how many rides, all told". */
  total: number;
  evidence: CarriedEvidenceLeaf[];
  /**
   * Holders who signed two different statements at the same `seq`. Surfaced,
   * never hidden: the tie-break keeps the index deterministic, but repeated
   * equivocation by one holder is a signal worth seeing rather than smoothing.
   */
  equivocations: string[];
}

/**
 * Tally a carried-total statement type for ONE subject.
 *
 * Keyed by `holder`, not by feed owner: `holderSig` is what binds a statement
 * to an identity, and the feed it was relayed through is not evidence of
 * anything. A holder writing from two devices is ordinary.
 *
 * Highest `seq` wins. On a tie, the LOWER canonical digest wins — deterministic,
 * lossless (rejecting both would discard a real count over an ordinary device
 * race), and grindable only by a holder who already controls their own number,
 * so it buys an attacker nothing at tier 1.
 *
 * Totals are CARRIED. The winner's `total` is the holder's count; nothing is
 * ever summed across a holder's own writes, which is what makes eight taps read
 * as eight rides rather than the sum of eight running totals.
 */
export function tallyCarriedTotals<T extends CarriedTotalStatement>(
  observed: readonly ObservedStatement<T>[],
): CarriedTotalTally {
  const winners = new Map<string, ObservedStatement<T>>();
  const equivocating = new Set<string>();

  for (const o of observed) {
    const holder = o.statement.holder.toLowerCase();
    const held = winners.get(holder);
    if (!held) {
      winners.set(holder, o);
      continue;
    }
    if (o.statement.seq > held.statement.seq) {
      winners.set(holder, o);
      continue;
    }
    if (o.statement.seq === held.statement.seq && o.digest !== held.digest) {
      equivocating.add(holder);
      // Lexicographic over the 0x-prefixed lowercase hex, which orders
      // identically to the raw 32 bytes it encodes.
      if (o.digest < held.digest) winners.set(holder, o);
    }
  }

  const evidence = [...winners.values()]
    .map((o) => ({
      holder: o.statement.holder.toLowerCase(),
      feedOwner: o.feedOwner.toLowerCase() as Hex0x,
      seq: o.statement.seq,
      version: o.version,
      digest: o.digest,
      total: o.statement.total,
    }))
    .sort((a, b) => (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0));

  return {
    holders: evidence.length,
    total: evidence.reduce((n, e) => n + e.total, 0),
    evidence,
    equivocations: [...equivocating].sort(),
  };
}

// ---------------------------------------------------------------------------
// Evidence manifest
// ---------------------------------------------------------------------------

/**
 * What an indexer publishes alongside a count so the count can be disbelieved
 * productively. An indexer that lies is provably lying; one that omits is
 * detectable by the person omitted.
 *
 * `participants` is the load-bearing and least obvious field. A from-scratch
 * rebuilder cannot compute a single feed address without knowing whose feeds to
 * read, so the input set has to be published or "rebuildable by anyone" is not
 * true. Publishing it does not make the indexer trusted — every statement it
 * names is independently verifiable, and the only power it retains is omission,
 * which is exactly what a reader checks by looking for themselves in it.
 */
export interface EvidenceManifestV1<L> {
  format: "woco.evidence.v1";
  /** The statement format this manifest tallies, e.g. `woco.like.v1`. */
  statementFormat: string;
  /** The subject tallied. */
  subject: Hex0x;
  /** Feed owners the indexer read, sorted — the declared input set. */
  participants: Hex0x[];
  /** Per-statement leaves, carrying the VALUES used, not just addresses. */
  leaves: L[];
  /** The published number this manifest justifies. */
  count: number;
}

export const EVIDENCE_MANIFEST_FORMAT = "woco.evidence.v1" as const;

/** A leaf carrying something a recount can add up — a boolean that counts as
 *  one, or a carried total. Both shapes are needed because a manifest's
 *  headline means different things for the two families. */
export type CountableLeaf = { value: boolean } | { total: number };

/**
 * How a BOOLEAN leaf's `digest` is computed — stated here rather than left in
 * an indexer's source, because a second indexer cannot produce a comparable
 * manifest against a recipe it cannot read.
 *
 *   digest = "0x" + hex(keccak256(rawStoredPayloadBytes))
 *
 * The raw bytes as stored, with no domain prefix and no re-encoding. It is
 * deliberately NOT the identity-signature digest recipe: a boolean statement
 * carries no identity signature, and this value neither orders anything (the
 * SOC version does) nor gates acceptance. Its only jobs are distinguishing two
 * statements and letting a reader confirm they fetched the same bytes we did.
 *
 * A CARRIED-TOTAL leaf is different and uses the FROZEN statement digest, since
 * closure 5's tie-break is defined over that exact value — using anything else
 * would make two honest indexers resolve ties differently.
 */
export const BOOLEAN_LEAF_DIGEST_RECIPE =
  "keccak256(raw stored payload bytes), 0x-prefixed lowercase hex" as const;

/** Build the manifest for a boolean tally. */
export function booleanEvidenceManifest(args: {
  statementFormat: string;
  subject: Hex0x;
  participants: readonly Hex0x[];
  tally: BooleanTally;
}): EvidenceManifestV1<BooleanEvidenceLeaf> {
  return {
    format: EVIDENCE_MANIFEST_FORMAT,
    statementFormat: args.statementFormat,
    subject: args.subject,
    participants: [...args.participants].map((p) => p.toLowerCase() as Hex0x).sort(),
    leaves: args.tally.evidence,
    count: args.tally.count,
  };
}

/** Build the manifest for a carried-total tally. `count` is the SUM, since that
 *  is the number a counter displays; holder count is recoverable from the
 *  leaves, so publishing both would be a second thing to keep consistent. */
export function carriedEvidenceManifest(args: {
  statementFormat: string;
  subject: Hex0x;
  participants: readonly Hex0x[];
  tally: CarriedTotalTally;
}): EvidenceManifestV1<CarriedEvidenceLeaf> {
  return {
    format: EVIDENCE_MANIFEST_FORMAT,
    statementFormat: args.statementFormat,
    subject: args.subject,
    participants: [...args.participants].map((p) => p.toLowerCase() as Hex0x).sort(),
    leaves: args.tally.evidence,
    count: args.tally.total,
  };
}

/**
 * Recount a manifest from its own leaves. This is the reader's side of
 * commitment 4 — it needs no network and no trust, and a manifest whose
 * declared count disagrees with its leaves is self-refuting.
 *
 * It does NOT verify signatures or that the leaves exist on Swarm; those are
 * separate, heavier checks. What it catches is the cheapest lie: a headline
 * number that the published evidence does not support.
 */
export function recountManifest(
  // Structural rather than generic: a caller holding the UNION of the two
  // manifest types (which any dispatching route does) cannot infer a single `L`,
  // and the recount does not need one — it only reads a countable field.
  manifest: EvidenceManifestV1<CountableLeaf>,
): { consistent: boolean; recounted: number } {
  const recounted = manifest.leaves.reduce((n, leaf) => {
    if ("total" in leaf) return n + leaf.total;
    return n + (leaf.value ? 1 : 0);
  }, 0);
  return { consistent: recounted === manifest.count, recounted };
}
