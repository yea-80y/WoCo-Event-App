/**
 * Go and read one of the entries the working points at.
 *
 * Adding the published working up proves the total is the total the evidence
 * supports. It proves nothing about whether any of those entries exist, or
 * whether a rider ever signed them — a counter that invented a rider and a
 * number would publish a list that recounts perfectly. This closes that gap for
 * ONE entry, which for a challenge count is the whole claim: a lifetime total
 * is not N separate records, it is one current entry carrying the number.
 *
 * WHY THIS IS POSSIBLE WITHOUT ASKING THE COUNTER ANYTHING. A leaf names the
 * logbook and the position in it, and everything else derives by the public
 * scheme: topic from (statement format, subject), identifier from topic and
 * version, address = keccak256(identifier || owner). So the address is computed
 * here, and the bytes are fetched from a storage gateway rather than from the
 * counter that made the claim.
 *
 * WHAT IT ESTABLISHES: that an entry at exactly the derived address carries the
 * rider's own signature over exactly the number the working used. What it does
 * NOT establish: that the rider rode. Nothing establishes that, and nothing on
 * this rail ever will — see the honesty panel on the page.
 *
 * ONE entry, deliberately. Fanning out over every leaf would add a fetch per
 * rider, a failure state per rider, and — worse — would read as this page
 * auditing fans' counts, which is the exact framing the plan forbids. One
 * checked hard, plus "every other row is checkable the same way, here is how",
 * is the honest shape.
 *
 * NEVER ACCUSES ON SILENCE. A gateway that times out, 403s behind a whitelist
 * lag, or 404s a chunk still settling produces "not checked", never "wrong".
 * A false accusation aimed at a real rider's logbook is a worse failure than no
 * check at all.
 */

import {
  creditPublicSalt,
  creditStatementTopic,
  creditStatementDigest,
  verifyCreditStatement,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
  calculateSocAddress,
  isContentFeedManifest,
  splitStoredSoc,
  LEGACY_CONTENT_FEED_VERSION,
  type CarriedEvidenceLeaf,
  type Hex0x,
} from "@woco/shared";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { WOCO_GATEWAY_URL } from "../swarm/gateways.js";

/** Long enough for a cold network search, short enough that a stuck read does
 *  not leave the page saying "checking…" for the length of a stream segment. */
const READ_TIMEOUT_MS = 10_000;

export type SpotCheck =
  /** The entry is there and says what the working said it says. */
  | { state: "confirmed"; address: string; total: number }
  /** Something WAS returned, and it disagrees. The only accusing state. */
  | { state: "contradicted"; address: string; because: string }
  /** Nothing came back from that address. Not proof of anything: a record that
   *  has not settled on the network yet looks exactly like this. */
  | { state: "missing"; address: string }
  /** The check could not be run. Never an accusation. */
  | { state: "unchecked"; address: string | null; because: string };

/** Where a leaf's entry lives, derived from public rules and the leaf alone. */
export function deriveEntryLocation(
  subject: Hex0x,
  leaf: CarriedEvidenceLeaf,
): { identifier: Uint8Array; address: string } {
  // The leaf's BAND, not just its version: versions restart at 0 in each band,
  // so addressing from the version alone would point at band 0's chunk of the
  // same index — a different statement, or nothing at all.
  const topic = creditStatementTopic(creditPublicSalt(), subject, leaf.band);
  const base = contentFeedSocIdentifier(topic);
  // The pre-versioning sentinel means a fixed-identifier chunk: no version is
  // folded in, because there was none when it was written.
  const identifier = leaf.version === LEGACY_CONTENT_FEED_VERSION ? base : versionedSocIdentifier(base, leaf.version);
  const owner = hexToBytes(leaf.feedOwner.slice(2));
  return { identifier, address: bytesToHex(calculateSocAddress(identifier, owner)) };
}

/**
 * Which entry to check, when the page is not showing a named rider's count.
 *
 * The largest, because it is the one carrying most of the headline and
 * therefore the one a sceptic would pick. Not a judgement about the rider: the
 * page says it checked one entry and shows how to check any of them.
 */
export function leafToCheck(leaves: readonly CarriedEvidenceLeaf[], featured: CarriedEvidenceLeaf | null): CarriedEvidenceLeaf | null {
  if (featured) return featured;
  let best: CarriedEvidenceLeaf | null = null;
  for (const leaf of leaves) if (leaf.total > 0 && (!best || leaf.total > best.total)) best = leaf;
  return best;
}

/**
 * Fetch and check one entry.
 *
 * The signature checked is the RIDER's, over the statement — not the storage
 * key's over the chunk. That is the one that matters: the count accrues to the
 * rider's identity, and the logbook a statement was relayed through is not
 * evidence of anything. Checking the storage signature as well would need a
 * secp256k1 recovery in this page for no additional guarantee about the number.
 */
export async function spotCheckLeaf(
  subject: Hex0x,
  leaf: CarriedEvidenceLeaf,
  opts: { gateway?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SpotCheck> {
  const gateway = opts.gateway ?? (import.meta.env?.VITE_GATEWAY_URL || WOCO_GATEWAY_URL);
  const doFetch = opts.fetchImpl ?? fetch;

  let address: string;
  let identifier: Uint8Array;
  try {
    ({ address, identifier } = deriveEntryLocation(subject, leaf));
  } catch {
    return { state: "unchecked", address: null, because: "this entry does not carry enough to find it" };
  }

  let raw: Uint8Array;
  try {
    const resp = await doFetch(`${gateway}/chunks/${address}`, {
      signal: opts.signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (resp.status === 404) return { state: "missing", address };
    // 403 is a routine answer here, not a fault: this gateway serves chunks it
    // has been told about, and an entry whose listing lagged reads exactly like
    // one that was never written. Verified against the live gateway
    // (2026-08-16) — an unlisted address answers 403 "not whitelisted", and
    // CORS is open, so the read itself works from any origin.
    if (resp.status === 403) {
      return { state: "unchecked", address, because: "this storage gateway is not serving that entry" };
    }
    if (!resp.ok) return { state: "unchecked", address, because: `the storage gateway answered HTTP ${resp.status}` };
    raw = new Uint8Array(await resp.arrayBuffer());
  } catch {
    return { state: "unchecked", address, because: "the storage gateway could not be reached" };
  }

  const chunk = splitStoredSoc(raw);
  if (!chunk) return { state: "unchecked", address, because: "what came back is not a stored entry" };

  // The address was derived FROM this identifier, so a stored chunk carrying a
  // different one means the address and its contents were not produced by the
  // same rules — whatever came back, it is not what the working pointed at.
  if (bytesToHex(chunk.identifier) !== bytesToHex(identifier)) {
    return { state: "contradicted", address, because: "what is stored there is filed under a different entry" };
  }

  let parsed: unknown;
  try {
    // Trailing NULs would break the parse and mean nothing — the digest is
    // taken over the decoded object, never over these raw bytes.
    parsed = JSON.parse(new TextDecoder().decode(chunk.payload).replace(/\0+$/, ""));
  } catch {
    return { state: "unchecked", address, because: "what came back is not a readable entry" };
  }

  if (isContentFeedManifest(parsed)) {
    // Split across several chunks. Reassembling is a further read per page and
    // no credit entry is anywhere near large enough to need it, so saying so is
    // better than pretending the check ran.
    return { state: "unchecked", address, because: "this entry is stored in parts, which this page does not reassemble" };
  }

  if (!verifyCreditStatement(parsed)) {
    return { state: "contradicted", address, because: "the entry at that address is not signed by the rider it names" };
  }

  if (parsed.holder !== leaf.holder || parsed.subject.toLowerCase() !== subject.toLowerCase()) {
    return { state: "contradicted", address, because: "the entry at that address belongs to a different rider or coaster" };
  }
  if (parsed.total !== leaf.total || parsed.seq !== leaf.seq) {
    return { state: "contradicted", address, because: "the entry carries a different number from the one that was counted" };
  }

  const { holderSig: _sig, ...unsigned } = parsed;
  if (`0x${bytesToHex(creditStatementDigest(unsigned))}` !== leaf.digest) {
    return { state: "contradicted", address, because: "the entry does not match the one the working named" };
  }

  return { state: "confirmed", address, total: parsed.total };
}

