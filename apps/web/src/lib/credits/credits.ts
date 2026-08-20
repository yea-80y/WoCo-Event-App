/**
 * Coaster credits — the rider's write path (P1 of docs/COASTER_CREDITS_PLAN.md).
 *
 * A ride is a statement the rider signs with their ed25519 POD key — the same
 * identity that owns their tickets — and writes to their OWN Swarm feed. The
 * feed key signs the chunk; the POD key signs the contents. Two keys, two jobs:
 * the SOC signature proves who wrote the feed, and `holderSig` proves whose
 * ride it is, which the SOC signature cannot (anyone may relay a validly-signed
 * SOC naming any holder).
 *
 * ENCRYPTED BY DEFAULT. A first ride writes to the rider's PRIVATE topic,
 * sealed to their own X25519 key, with no publication decision asked — the
 * keepsake must never require a choice from a child standing in a queue.
 * Publishing is a separate, deliberate, ONE-WAY act (see {@link publishSubject}).
 *
 * READS ARE TRI-STATE ON THE WRITE PATH, and that is the load-bearing rule in
 * this file. Every read here feeds a decision about what to write next, and
 * "could not read" is not "not there": treating a transient gateway failure as
 * an absent head restarts a rider's lifetime count at zero, and treating it as
 * an empty index writes a fresh index that erases every other coaster they own.
 * Only a CLEAN absent may mean "nothing here". The display path may be lenient;
 * the write path may not.
 *
 * Counts are not computed here. A total is carried on the statement, so a
 * rider's own total needs one read; everyone else's needs an indexer.
 */

import { auth } from "../auth/auth-store.svelte.js";
import { decideVisibility, type IndexRead, type PartitionRead } from "./partition.js";
import type { CreditVisibility } from "./visibility.js";
import { readBandedContentFeed } from "../swarm/content-feed.js";
import {
  writeContentFeedVerified,
  writeContentFeedSettling,
  type VerifiedWriteResult,
} from "../swarm/verified-write.js";
import { nextCreditStatement } from "./next-statement.js";
import {
  CREDIT_SUBJECT_INDEX_FORMAT,
  creditPublicSalt,
  creditPrivateSalt,
  creditStatementTopic,
  creditSubjectIndexTopic,
  signCreditStatement,
  verifyCreditStatement,
  validateCreditSubjectIndexV2,
  LAST_VERSION_IN_BAND,
  deriveEncryptionKeypairFromPodSeed,
  sealJson,
  openJson,
  type CreditStatementV1,
  type CreditSubjectIndexV2,
  type SealedBox,
  type Hex0x,
} from "@woco/shared";


export type { CreditVisibility } from "./visibility.js";

export interface CreditHead {
  statement: CreditStatementV1;
  visibility: CreditVisibility;
  /** The BAND this head sits in. Carried for the same reason `version` is: a
   *  warm write addresses `(band, version + 1)` directly, and a band alone is
   *  not enough to place a lap once versions restart per band. */
  band: number;
  /**
   * The SOC version this head sits at, so the next write can address
   * `version + 1` directly instead of probing for it. A probe past a feed's
   * latest version is a bee network search for a chunk that does not exist —
   * the most expensive read on Swarm — and it was the last one left on the tap
   * path (#323).
   *
   * `writeContentFeed` documents `knownVersion` as only safe when the caller
   * can PROVE nothing was written there, because a SOC write to an existing
   * address is silently deduped. Here the loss is not silent: the write is
   * verified at that exact version and reports `superseded`, which the caller
   * corrects. That is what makes an unprovable claim safe to act on.
   */
  version: number;
}

/** Re-reads after losing an index write race, before giving up. */
const INDEX_WRITE_ATTEMPTS = 3;

/** The rider's keys for this rail. Held only for the duration of a call. */
interface RiderKeys {
  /** ed25519 POD private key — signs the statement contents. */
  holderPrivKey: Uint8Array;
  /** ed25519 POD public key, hex no 0x — the statement's `holder`. */
  holder: string;
  /** X25519 keys — seal/open the private statement AND derive the private salt. */
  encPrivKey: Uint8Array;
  encPubKeyHex: string;
  /** secp256k1 feed signer — signs the SOC. */
  feedPrivKey: string;
  feedAddress: string;
}

/** `0x`-prefixed or not, in; bare hex out. Tolerant of both because the two
 *  sides of this boundary disagree and only one of them is frozen. */
function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

async function riderKeys(): Promise<RiderKeys> {
  const parent = auth.parent?.toLowerCase();
  if (!parent) throw new Error("Sign in to collect a credit.");

  // Derivation is a key-stretch, not authorship — the one thing the parent is
  // allowed to sign for. Idempotent after the first time on a device.
  await auth.ensurePodIdentity();

  // Through the BOUND accessors, never `getPodKeypair(parent)`. The POD seed is
  // stored under the POD address — the PRF-EOA for passkey, the Web3Auth EOA
  // for web3auth — and `auth.parent` is the KERNEL address for both. Looking it
  // up by parent reads a slot that is never written, so `ensurePodIdentity()`
  // above would succeed (storing under the right address, having just made the
  // rider approve a ceremony) and this would still come back empty: every
  // passkey and web3auth rider taps, signs, and gets "could not unlock".
  // The accessors resolve the address themselves so no caller can pick wrong.
  const [pod, seed, feed] = await Promise.all([
    auth.getPodKeypair(),
    auth.getPodSeed(),
    auth.getContentFeedSigner(),
  ]);
  if (!pod || !seed) throw new Error("Could not unlock your collection identity.");
  if (!feed) throw new Error("Could not unlock your feed signer.");

  const enc = deriveEncryptionKeypairFromPodSeed(seed);
  return {
    holderPrivKey: pod.privateKey,
    // STRIPPED, and the schema is why. `deriveKeypair` returns an 0x-prefixed
    // hex string (pod/keys.ts), the POD ticket rail is happy with that, and
    // `woco.credit.v1` is not: `holder` is validated against /^[0-9a-f]{64}$/
    // and the format is CLOSED (plan, P0 item 4), so the caller conforms rather
    // than the schema loosening. Passing the prefix through made every signing
    // attempt throw "invalid woco.credit.v1 unsigned statement" — invisible
    // until the rail was reachable at all. The indexer agrees with the schema:
    // evidence leaves carry bare 64-hex holders (verify-report `HOLDER_RE`).
    holder: stripHexPrefix(pod.publicKeyHex),
    encPrivKey: enc.privateKey,
    encPubKeyHex: enc.publicKeyHex,
    feedPrivKey: feed.privKey,
    feedAddress: feed.address,
  };
}

function saltFor(keys: RiderKeys, visibility: CreditVisibility): Uint8Array {
  return visibility === "public" ? creditPublicSalt() : creditPrivateSalt(keys.encPrivKey);
}

// ---------------------------------------------------------------------------
// Reading — tri-state throughout, collapsed to null only for display
// ---------------------------------------------------------------------------

type HeadRead =
  | { status: "found"; statement: CreditStatementV1; version: number; band: number }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

/** The index feed is banded too — it grows one version per new subject. */
function indexTopicForBand(keys: RiderKeys, visibility: CreditVisibility): (band: number) => string {
  const salt = saltFor(keys, visibility);
  return (band) => creditSubjectIndexTopic(salt, band);
}

/**
 * Read a partition's subject index, resolving which band of the INDEX is open.
 *
 * Returns that band alongside the entries because a write-back has to land in
 * the same band the read came from — writing band 0 while the live index is at
 * band 2 would strand every subject the rider owns.
 */
interface SubjectIndexRead {
  read: IndexRead;
  /** Which band of the INDEX feed is open. */
  indexBand: number;
  /** Latest version inside that band, or null when the index does not exist. */
  indexVersion: number | null;
  /** Whether the band walk was conclusive — a writer must refuse if not. */
  bandClean: boolean;
}

async function readSubjectIndex(
  keys: RiderKeys,
  visibility: CreditVisibility,
  /**
   * Set by callers whose result feeds a READ-MODIFY-WRITE of this index. Those
   * reads must never trust the gateway's whitelist gate: a false absent there
   * writes a fresh snapshot over a real one and erases every subject added
   * since, with nothing to detect it. `liveVisibility` reads for DISPLAY and
   * leaves this off, so the common cold read stays cheap.
   */
  opts: { thorough?: boolean } = {},
): Promise<SubjectIndexRead> {
  const res = await readBandedContentFeed<unknown>(
    keys.feedAddress,
    indexTopicForBand(keys, visibility),
    { thorough: opts.thorough },
  );
  const at = {
    indexBand: res.band,
    indexVersion: res.status === "found" ? res.version : null,
    bandClean: res.bandClean,
  };
  if (res.status === "absent") return { read: { status: "absent" }, ...at };
  if (res.status === "unavailable") {
    return { read: { status: "unavailable", reason: res.reason ?? "index unavailable" }, ...at };
  }
  // Bytes exist here but are not our index — foreign or corrupt, never "empty".
  if (!validateCreditSubjectIndexV2(res.value)) {
    return { read: { status: "unavailable", reason: "index payload failed validation" }, ...at };
  }
  return { read: { status: "ok", entries: (res.value as CreditSubjectIndexV2).entries }, ...at };
}

/**
 * Which partition holds this subject's live head, `null` for never ridden.
 *
 * The subject index is the authority, not a probe of both topics. That is why
 * the partition rule is load-bearing rather than hygiene: ONE LIVE HEAD per
 * (holder, subject), and the index is how a fresh device learns which one.
 * Probing the other topic would also cost a search for a chunk that does not
 * exist — the most expensive read on Swarm.
 *
 * PUBLIC is checked first. That is the correct tie-break rather than an
 * arbitrary one: a subject appears in both only mid-publish, where the public
 * head is the newer and the private entry is the one being retired.
 *
 * An unreadable index refuses. Reading a published subject as private would
 * continue the RETIRED private head — two live heads, seq equivocation, and
 * rides invisible to every count. That is precisely the fork the one-live-head
 * rule exists to prevent.
 */
async function liveVisibility(keys: RiderKeys, subject: Hex0x): Promise<PartitionRead> {
  const [pub, priv] = await Promise.all([
    readSubjectIndex(keys, "public"),
    readSubjectIndex(keys, "private"),
  ]);
  return decideVisibility(pub.read, priv.read, subject);
}

/** A subject's head feed, as a family of banded topics. */
function headTopicForBand(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): (band: number) => string {
  const salt = saltFor(keys, visibility);
  return (band) => creditStatementTopic(salt, subject, band);
}

async function readHeadAt(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
  hintBand = 0,
): Promise<HeadRead> {
  // `hintBand` is the band the subject index recorded — a lower bound. A stale
  // one costs a short walk over band openers; it can never point at a head that
  // is not the live one, because bands are contiguous and only ever appended.
  const res = await readBandedContentFeed<unknown>(
    keys.feedAddress,
    headTopicForBand(keys, subject, visibility),
    { hintBand },
  );
  if (res.status === "absent") return { status: "absent" };
  if (res.status === "unavailable") return { status: "unavailable", reason: res.reason ?? "head unavailable" };

  // A private head is a SealedBox. Failing to open one is NOT absence — real
  // bytes are at our own address — so it must never read as "never ridden".
  let payload: unknown;
  if (visibility === "private") {
    try {
      payload = await openJson<unknown>(keys.encPrivKey, res.value as SealedBox);
    } catch {
      return { status: "unavailable", reason: "private head could not be opened" };
    }
  } else {
    payload = res.value;
  }

  // verifyCreditStatement is dispatch -> closed-schema -> signature, and never
  // throws. Bytes that fail it are foreign at our address, not an empty feed.
  if (!verifyCreditStatement(payload)) {
    return { status: "unavailable", reason: "head failed statement verification" };
  }
  return { status: "found", statement: payload, version: res.version, band: res.band };
}

/**
 * Whether this rider's keys are ALREADY to hand, established without asking
 * them for anything.
 *
 * The read path needs the same keys the write path does — the private topics
 * are salted by the rider's own key, so there is no reading a private logbook
 * without unlocking it — but {@link riderKeys} ESTABLISHES what it cannot find,
 * and establishing prompts. A screen that read on mount would therefore pop a
 * signing prompt at a rider who had done nothing but open a page, which is
 * both alarming and, on a rail whose whole promise is that nothing happens
 * without a deliberate tap, untrue to the product.
 *
 * So this asks only what is already stored, by exactly the route `riderKeys`
 * would take: `restorePodSeed` reads a device blob, and the feed-signer ADDRESS
 * getter is documented prompt-free and returns null rather than deriving for
 * the kinds that would need a ceremony. True here means a read costs nothing;
 * false means the screen shows its signed-out face and lets the tap unlock.
 */
export async function creditsUnlocked(): Promise<boolean> {
  if (!auth.parent) return false;
  try {
    // Both bound, both prompt-free: the seed getter reads a device blob under
    // the POD address, and the feed-signer ADDRESS getter is documented to
    // return null rather than derive for the kinds that would need a ceremony.
    const [seed, feedAddress] = await Promise.all([
      auth.getPodSeed(),
      auth.getContentFeedSignerAddress(),
    ]);
    return seed !== null && feedAddress !== null;
  } catch {
    return false;
  }
}

/**
 * The rider's current head for a subject, wherever it lives. Display path, so
 * it collapses every failure to `null` — the next visit re-reads. Nothing here
 * may feed a write decision; use the tri-state readers for that.
 */
export async function readMyCredit(subject: Hex0x): Promise<CreditHead | null> {
  try {
    const keys = await riderKeys();
    const where = await liveVisibility(keys, subject);
    if (where.status !== "ok" || !where.visibility) return null;
    const head = await readHeadAt(keys, subject, where.visibility, where.band);
    return head.status === "found"
      ? { statement: head.statement, visibility: where.visibility, version: head.version, band: head.band }
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type RideResult =
  | {
      ok: true;
      statement: CreditStatementV1;
      visibility: CreditVisibility;
      /** The SOC version this statement was written at — the caller's next warm
       *  head must carry it, or the following tap goes back to probing. */
      version: number;
      /** The BAND it was written in, which DIFFERS from the head's band on a
       *  rollover. A warm head carrying the version without the band cannot
       *  address the feed it was just written to. */
      band: number;
      /**
       * How the write ended up, resolving AFTER this result. The ride is
       * already recorded — the upload was accepted — so this is not a gate on
       * showing the count. It is the rider's only chance to learn the write was
       * SUPERSEDED, which is the one outcome meaning the entry did not land.
       * Never rejects.
       */
      settled: Promise<VerifiedWriteResult>;
    }
  | { ok: false; error: string };

/** What a rider is told when a read the write depends on could not be made.
 *  Deliberately identical for every such case: the rider's action is the same,
 *  and naming the internal cause would be noise they cannot act on. */
const CANNOT_READ = "Couldn't reach your collection just now — try again in a moment.";

/**
 * Record `laps` rides on `subject`. Defaults to one — the tap.
 *
 * A first ride goes to the PRIVATE partition with no question asked; later
 * rides follow whichever partition already holds the head, so this never
 * silently changes a rider's visibility. Only {@link publishSubject} does that,
 * and only in one direction.
 */
export async function recordRide(
  subject: Hex0x,
  laps = 1,
  /**
   * A head the CALLER already read cleanly, moments ago, in this session — the
   * page's own mount read. Reusing it skips three feed reads per tap (both
   * subject-index partitions and the head itself), each of which probes past
   * its feed's latest version, and each such probe is a bee network search for
   * a chunk that does not exist (#323).
   *
   * Only a CLEAN FOUND may be passed. `readMyCredit` collapses every failure to
   * null, so a null caller-side head is indistinguishable from "unreadable" and
   * must NOT be treated as "no previous laps" — that is the exact mistake that
   * restarts a rider's lifetime count at zero. Null here therefore takes the
   * full tri-state path rather than assuming anything.
   *
   * Staleness is backstopped, not hoped away: if another device wrote between
   * the page's read and this tap, our write lands on a version that already
   * holds someone else's bytes and comes back `superseded` — at which point we
   * discard the warm head and redo the whole read honestly, once.
   */
  warm?: CreditHead | null,
): Promise<RideResult> {
  if (!Number.isSafeInteger(laps) || laps < 1) return { ok: false, error: "laps must be a positive whole number" };
  try {
    const keys = await riderKeys();

    // No synchronous retry here any more: the write returns at upload-accept, so
    // `superseded` — the only failure a retry could fix — is not known until the
    // read-back settles. The caller reconciles from `settled`; see the card's
    // `settle()`.
    // `return await`, NOT `return`. A bare return hands the promise back before
    // the catch below can see it, so every async failure on the write path —
    // an upload rejection, and `writeContentFeed`'s probe-inconclusive throw,
    // which is live on every first lap — escaped as an unhandled rejection.
    // The card's `collect()` has no catch, so the rider got no message at all:
    // the button simply stopped saying "Saving…".
    return await attemptRide(keys, subject, laps, warm ?? null);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that ride." };
  }
}

/**
 * One honest attempt. `warm` non-null means the caller supplied a clean head
 * and its partition; null means read everything.
 */
/**
 * WHY THIS PATH DOES NOT CHECK `bandClean`, AND THE INDEX WRITERS DO.
 *
 * The asymmetry looks like an oversight and is not, so it is written down here
 * rather than re-argued at every review.
 *
 * A lap is an EXACT-ADDRESS write: `knownVersion` is always supplied when there
 * is a previous head (`prevVersion + 1`, or 0 on a rollover), and the only
 * probing lap writes are a first lap — which requires a CLEAN resolution
 * showing band 0 unopened — and `publishSubject`, which starts a fresh public
 * family at band 0. So a lap computed from ANY stale state (stale band, stale
 * version, stale prev) targets an address that already exists. Bee dedupes, the
 * bytes never land, the read-back at that exact version reports `superseded`,
 * and `shouldRetryCold` redoes it once from a cold read. A mis-banded lap is
 * therefore never a durably-written-but-invisible ride; it is a ride that was
 * NOT written, and the not-writing is detected.
 *
 * An index write is a READ-MODIFY-WRITE of a whole snapshot. Its writer probes
 * for a fresh address independently of the resolution we read from, so a stale
 * snapshot lands at the real latest version and VERIFIES — erasing everything
 * added since. Nothing detects it. That is why those writers refuse and this
 * one proceeds.
 *
 * The rule, generally: exact-address writes whose staleness always collides may
 * proceed on an inconclusive read, because the read-back is their guard.
 * Read-modify-write snapshot writes must refuse.
 *
 * Refusing the tap instead would fail the product's core moment — an unrecorded
 * lap is a lap that did not happen — to defend against a harm the write path
 * already converts into detect-and-retry.
 */
async function attemptRide(
  keys: RiderKeys,
  subject: Hex0x,
  laps: number,
  warm: CreditHead | null,
): Promise<RideResult> {
  // `superseded` cannot be known before returning — the read-back that detects
  // it runs after the upload is accepted — so this no longer advertises a
  // synchronous failure channel for it. The caller reconciles through
  // `settled`; see the card's `settle()`.
  let visibility: CreditVisibility;
  let prev: CreditStatementV1 | null;
  /** The version the PREVIOUS head sits at, when we know it. `undefined` means
   *  the write must probe. */
  let prevVersion: number | undefined;
  /** The band the previous head sits in — where the next lap is written unless
   *  that band is full. Band 0 for a first lap, which is also where a fresh
   *  feed resolves, so there is no first-lap special case. */
  let band = 0;
  /**
   * Whether the subject is taken to be in its partition's index already.
   *
   * A warm head from `readMyCredit` proves it — that value only exists by way
   * of `liveVisibility`, which IS the index read. A warm head handed back from
   * a previous write does not: a first lap's `upsertSubjectBand` failure is
   * deliberately swallowed, so the subject may be unindexed and this will not
   * retry it. The cost is the documented, self-healing one — enumeration on a
   * fresh device, never the count — and the next cold session repairs it.
   */
  let indexed: boolean;

  if (warm) {
    visibility = warm.visibility;
    prev = warm.statement;
    prevVersion = warm.version;
    band = warm.band;
    indexed = true;
  } else {
    const where = await liveVisibility(keys, subject);
    if (where.status !== "ok") return { ok: false, error: CANNOT_READ };
    visibility = where.visibility ?? "private";
    indexed = where.visibility !== null;

    // Only a CLEAN absent may start a new count. An unreadable head that
    // actually holds a lifetime total would otherwise restart the rider at
    // seq 0 / total = laps, at a HIGHER SOC version — their device would show
    // the reset while an indexer (highest seq) kept the real total, and the
    // two would disagree indefinitely.
    const head = await readHeadAt(keys, subject, visibility, where.band);
    if (head.status === "unavailable") return { ok: false, error: CANNOT_READ };
    prev = head.status === "found" ? head.statement : null;
    if (head.status === "found") {
      prevVersion = head.version;
      band = head.band;
    }
  }

  const statement = signCreditStatement(
    nextCreditStatement({ prev, subject, holder: keys.holder, laps }),
    keys.holderPrivKey,
  );
  // Where the lap lands. `prevVersion + 1` when we read the previous head — the
  // last probe on the tap path. A first lap has no previous head and must probe,
  // because version 0 may already exist from a partition we did not read.
  //
  // THE ROLLOVER, and the full-band invariant's writer half: a band is opened
  // only once its predecessor is FULL, so a head sitting at the last slot means
  // the next lap starts band + 1 at version 0. Getting this backwards — opening
  // early, or writing a 65th version into a full band — breaks the reader's
  // right to stop walking, which is the whole basis of the bound.
  // `>=`, not `===`. An overshoot (a dirty walk under-resolves the band and a
  // write lands past the last slot) would otherwise make this false FOREVER —
  // the feed silently stops rolling over and degrades back to unbanded growth.
  const rollover = prevVersion !== undefined && prevVersion >= LAST_VERSION_IN_BAND;
  const writeBand = rollover ? band + 1 : band;
  const knownVersion = rollover ? 0 : prevVersion !== undefined ? prevVersion + 1 : undefined;
  const written = await writeStatement(keys, subject, visibility, statement, writeBand, knownVersion);

  // ONLY when this subject is not already indexed. A non-null partition IS the
  // statement "that partition's index contains this subject" — it is the only
  // way `liveVisibility` can produce one, and a warm head carries the same
  // fact. Calling `upsertSubjectBand` anyway re-reads a whole feed, including
  // a probe past its latest version, to re-learn what this call already knows.
  //
  // Skipping is also SAFER than re-reading: in the race where another device
  // publishes this subject mid-tap, the re-read sees the freshly-swept private
  // index, does not find the subject, and writes it back — undoing the publish.
  // Doing nothing cannot undo anything.
  // A rollover moves the head to a new band, so the index entry that names the
  // band is now stale-low. Correcting it is what keeps the next cold read O(1).
  // Failure is survivable BY DESIGN and must not fail a landed ride: a stale-low
  // band only costs the reader a short forward walk over openers, which is
  // exactly the case the full-band invariant makes safe.
  if (indexed && rollover) {
    try {
      await upsertSubjectBand(keys, subject, visibility, writeBand);
    } catch {
      // Deliberately swallowed — a stale band is a cost, never a wrong answer.
    }
  }

  if (!indexed) {
    // The ride is recorded and valid from here on. An index failure costs
    // enumeration on a fresh device, not the count — so it must never turn a
    // landed ride into a reported failure, because the rider's retry would
    // read their own new statement as `prev` and add the laps a second time.
    try {
      await upsertSubjectBand(keys, subject, visibility, writeBand);
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  return {
    ok: true, statement, visibility, version: written.version,
    band: writeBand, settled: written.settled,
  };
}

async function writeStatement(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
  statement: CreditStatementV1,
  band: number,
  /** The exact SOC version to write at, when the caller read the previous head
   *  and therefore knows it. Omitted means probe — see `knownVersion`. */
  knownVersion?: number,
): Promise<{ version: number; settled: Promise<VerifiedWriteResult> }> {
  const body = visibility === "private"
    ? await sealJson(keys.encPubKeyHex, statement)
    : statement;

  // Returns at UPLOAD-ACCEPT, with the read-back still running. From that
  // moment the rider's signed entry durably exists; the verification only
  // catches the same-version dedupe, whose usual answer is "yes" and whose
  // interesting answer is equally actionable a second later. The rider is
  // standing in a queue, so they get the moment the entry became real.
  const { version, settled } = await writeContentFeedSettling({
    signerPrivKey: keys.feedPrivKey,
    ownerAddress: keys.feedAddress,
    topic: creditStatementTopic(saltFor(keys, visibility), subject, band),
    data: body,
    ...(knownVersion !== undefined ? { knownVersion } : {}),
  });

  // No `ok` flag: this function either returns the write or throws. The only
  // failure a caller could once branch on here — `superseded` — is not knowable
  // until the read-back settles, and lives on `settled`.
  return { version, settled };
}

/**
 * Index maintenance. Subjects are never removed except by publication, which
 * moves the entry between partitions.
 *
 * Read-modify-write with no compare-and-swap underneath, so losing the race is
 * handled rather than assumed away: on `superseded` the only sound move is to
 * re-read and union, since rewriting the list we already computed would put
 * stale data over the winner. An unreadable index REFUSES — writing a fresh
 * one would erase every other coaster the rider owns from this partition.
 */
/**
 * Add a subject to a partition's index, or RAISE the band already recorded for
 * it. Both jobs, because they are the same read-modify-write.
 *
 * Bands merge by MAX, never by last-writer-wins, because the band is a
 * monotonic lower bound and the higher value is the more informative one.
 *
 * Stated precisely, because an earlier version of this comment overstated it: a
 * stale-low band does NOT produce a wrong head. Under the full-band invariant a
 * band the writer has left reads as FULL, which forces the reader to continue —
 * so the cost of taking the lower value is a longer walk, not a wrong answer.
 * Max-merge is right for cost and for keeping the lower-bound semantics honest.
 *
 * The index feed is itself banded, so it rolls over on the same rule the
 * statement feeds do.
 */
async function upsertSubjectBand(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
  band: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
    const existing = await readSubjectIndex(keys, visibility, { thorough: true });
    if (existing.read.status === "unavailable") return false;
    // A dirty band walk cannot bound the family: the band it failed to read may
    // be open, and writing into the one below it lands an update where readers
    // have stopped looking. Refuse, exactly as the version probe does.
    if (!existing.bandClean) return false;
    const entries = existing.read.status === "ok" ? existing.read.entries : [];

    const current = entries.find((e) => e.subject === subject);
    if (current && current.band >= band) return true; // already recorded, at least this high

    const merged = current
      ? entries.map((e) => (e.subject === subject ? { subject, band: Math.max(e.band, band) } : e))
      : [...entries, { subject, band }];

    // The index's own rollover: a full band means the next write opens the next
    // one. No knownVersion — a fresh band's version 0 is probed, which is one
    // probe, and getting it wrong would silently dedupe the write away.
    // `>=` — see the statement path: `===` turns one overshoot into a permanent
    // loss of rollover rather than a transient one.
    const rollover = existing.indexVersion !== null && existing.indexVersion >= LAST_VERSION_IN_BAND;
    const targetBand = rollover ? existing.indexBand + 1 : existing.indexBand;

    const written = await writeContentFeedVerified({
      signerPrivKey: keys.feedPrivKey,
      ownerAddress: keys.feedAddress,
      topic: creditSubjectIndexTopic(saltFor(keys, visibility), targetBand),
      data: { format: CREDIT_SUBJECT_INDEX_FORMAT, entries: merged },
    });
    if (written.status === "verified") return true;
    if (written.status === "unconfirmed") return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Publication — one way, and it says so
// ---------------------------------------------------------------------------

export type PublishResult =
  | { ok: true; statement: CreditStatementV1 | null }
  | { ok: false; error: string };

/**
 * Republish a subject's head at the PUBLIC topic and retire the private one.
 *
 * One-way, structurally: SOC versions are immutable, so public → private is
 * impossible and the UI must say so at the moment of choosing. What this
 * exposes is not only future rides — the carried `total` discloses the full
 * magnitude of prior private riding, and `seq` discloses how many times the
 * rider wrote. That is the point of publishing a lifetime count, but the
 * consent copy has to say it rather than implying only new rides become public.
 *
 * `seq` CONTINUES across the move (versions restart at 0 at the new topic, seq
 * does not): restarting would plant an equivocation the moment any prior
 * private statement was ever selectively disclosed. Note the honest limit — a
 * device that missed the opt-in and writes private at the same seq TIES rather
 * than losing outright, resolved by the digest tie-break, and rides recorded on
 * such a stale fork are never migrated into the public total.
 *
 * The private head is retired by moving its index entry, never by writing a
 * tombstone — old versions stay readable at addresses only the rider can
 * compute, which is exactly the property the salted topic bought.
 *
 * IDEMPOTENT. An interrupted publish can leave the subject in both partitions,
 * so "already public" still sweeps a lingering private entry instead of
 * early-returning — otherwise the stale entry is permanent and no repair path
 * exists.
 */
export async function publishSubject(subject: Hex0x): Promise<PublishResult> {
  try {
    const keys = await riderKeys();
    const where = await liveVisibility(keys, subject);
    if (where.status !== "ok") return { ok: false, error: CANNOT_READ };

    if (where.visibility === "public") {
      const swept = await removeFromSubjectIndex(keys, subject, "private");
      return swept
        ? { ok: true, statement: null }
        : { ok: false, error: "This coaster is already public." };
    }
    if (!where.visibility) return { ok: false, error: "Ride it once before publishing it." };

    const head = await readHeadAt(keys, subject, "private");
    if (head.status !== "found") return { ok: false, error: CANNOT_READ };
    const prev = head.statement;

    // Re-signed rather than re-uploaded: the statement is unchanged in meaning
    // but not in `seq`, and holderSig covers seq. The old signature is dropped
    // by destructuring — the closed-schema validator rejects a `holderSig` key
    // on an unsigned object, so it cannot be carried through by accident.
    const { holderSig: _previous, ...unsigned } = prev;
    const statement = signCreditStatement(
      { ...unsigned, seq: prev.seq + 1, session: { ...prev.session } },
      keys.holderPrivKey,
    );
    // Band 0: opting in republishes at the public topic and versions restart
    // there (closure 6). The private head's band belongs to a retired family.
    const written = await writeStatement(keys, subject, "public", statement, 0);

    // PUBLISH WAITS FOR THE READ-BACK, unlike a lap. The tap returns at
    // upload-accept because a rider is standing in a queue and the interesting
    // settlement is equally actionable a second later. Publish is the opposite:
    // a deliberate, confirm-dialogued, ONE-WAY act with no latency case at all,
    // and what follows it is destructive — the private index entry is swept.
    // Proceeding on an unverified public head could leave the subject in
    // NEITHER partition, which reads as "never ridden" while a public head
    // exists, and republishing then refuses.
    //
    // `superseded` is the one settlement meaning the statement did not land.
    // `unconfirmed` is explicitly NOT a failure — the upload was accepted and
    // the chunk is merely not readable back yet — so it proceeds, which is the
    // same judgement the index writes below already make.
    const settlement = await written.settled;
    if (settlement.status === "superseded") {
      return {
        ok: false,
        error: "Another device changed this count while publishing. Open this coaster again and retry.",
      };
    }

    // The private entry is removed ONLY once the public one is confirmed
    // present. Removing first — or removing after an unconfirmed add — can
    // leave the subject in NEITHER partition, which reads as "never ridden"
    // while a public head exists, and republishing then refuses.
    // Band 0: opting in republishes at the public topic and SOC versions
    // restart there (closure 6). The private head's band does not carry over —
    // it belongs to a topic family the rider has just retired.
    const added = await upsertSubjectBand(keys, subject, "public", 0);
    if (!added) {
      return { ok: false, error: "Published, but we couldn't finish listing it — open this coaster again to retry." };
    }
    await removeFromSubjectIndex(keys, subject, "private");
    return { ok: true, statement };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not publish that." };
  }
}

/** The ONLY removal in this module: publishing moves an entry between
 *  partitions, and leaving it in both would leave two heads claiming to be
 *  live — the fork the one-live-head rule exists to prevent. Returns whether
 *  anything was actually removed. */
async function removeFromSubjectIndex(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): Promise<boolean> {
  for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
    const existing = await readSubjectIndex(keys, visibility, { thorough: true });
    if (existing.read.status !== "ok") return false;
    // Same refusal as `upsertSubjectBand`, and for a sharper reason: this writes
    // a snapshot with a subject REMOVED. Off an inconclusive resolution it can
    // land an older band's snapshot at the live band's next version — verified —
    // erasing every subject added since. A wrong answer, not a slow one.
    if (!existing.bandClean) return false;
    if (!existing.read.entries.some((e) => e.subject === subject)) return false;

    const rollover = existing.indexVersion !== null && existing.indexVersion >= LAST_VERSION_IN_BAND;
    const targetBand = rollover ? existing.indexBand + 1 : existing.indexBand;

    const written = await writeContentFeedVerified({
      signerPrivKey: keys.feedPrivKey,
      ownerAddress: keys.feedAddress,
      topic: creditSubjectIndexTopic(saltFor(keys, visibility), targetBand),
      data: {
        format: CREDIT_SUBJECT_INDEX_FORMAT,
        entries: existing.read.entries.filter((e) => e.subject !== subject),
      },
    });
    if (written.status === "verified") return true;
    if (written.status === "unconfirmed") return false;
  }
  return false;
}
