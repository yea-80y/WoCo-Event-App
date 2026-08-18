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
import { readContentFeedResult } from "../swarm/content-feed.js";
import { writeContentFeedVerified } from "../swarm/verified-write.js";
import { nextCreditStatement } from "./next-statement.js";
import {
  CREDIT_SUBJECT_INDEX_FORMAT,
  creditPublicSalt,
  creditPrivateSalt,
  creditStatementTopic,
  creditSubjectIndexTopic,
  signCreditStatement,
  verifyCreditStatement,
  validateCreditSubjectIndexV1,
  deriveEncryptionKeypairFromPodSeed,
  sealJson,
  openJson,
  type CreditStatementV1,
  type CreditSubjectIndexV1,
  type SealedBox,
  type Hex0x,
} from "@woco/shared";


export type { CreditVisibility } from "./visibility.js";

export interface CreditHead {
  statement: CreditStatementV1;
  visibility: CreditVisibility;
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
  | { status: "found"; statement: CreditStatementV1 }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

async function readSubjectIndex(keys: RiderKeys, visibility: CreditVisibility): Promise<IndexRead> {
  const topic = creditSubjectIndexTopic(saltFor(keys, visibility));
  const res = await readContentFeedResult<unknown>(keys.feedAddress, topic);
  if (res.status === "absent") return { status: "absent" };
  if (res.status === "unavailable") return { status: "unavailable", reason: res.reason ?? "index unavailable" };
  // Bytes exist here but are not our index — foreign or corrupt, never "empty".
  if (!validateCreditSubjectIndexV1(res.value)) {
    return { status: "unavailable", reason: "index payload failed validation" };
  }
  return { status: "ok", subjects: (res.value as CreditSubjectIndexV1).subjects };
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
  return decideVisibility(pub, priv, subject);
}

async function readHeadAt(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): Promise<HeadRead> {
  const topic = creditStatementTopic(saltFor(keys, visibility), subject);
  const res = await readContentFeedResult<unknown>(keys.feedAddress, topic);
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
  return { status: "found", statement: payload };
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
    const head = await readHeadAt(keys, subject, where.visibility);
    return head.status === "found" ? { statement: head.statement, visibility: where.visibility } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type RideResult =
  | { ok: true; statement: CreditStatementV1; visibility: CreditVisibility; confirmed: boolean }
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
export async function recordRide(subject: Hex0x, laps = 1): Promise<RideResult> {
  if (!Number.isSafeInteger(laps) || laps < 1) return { ok: false, error: "laps must be a positive whole number" };
  try {
    const keys = await riderKeys();

    const where = await liveVisibility(keys, subject);
    if (where.status !== "ok") return { ok: false, error: CANNOT_READ };
    const visibility = where.visibility ?? "private";

    // Only a CLEAN absent may start a new count. An unreadable head that
    // actually holds a lifetime total would otherwise restart the rider at
    // seq 0 / total = laps, at a HIGHER SOC version — their device would show
    // the reset while an indexer (highest seq) kept the real total, and the
    // two would disagree indefinitely.
    const head = await readHeadAt(keys, subject, visibility);
    if (head.status === "unavailable") return { ok: false, error: CANNOT_READ };
    const prev = head.status === "found" ? head.statement : null;

    const statement = signCreditStatement(
      nextCreditStatement({ prev, subject, holder: keys.holder, laps }),
      keys.holderPrivKey,
    );
    const written = await writeStatement(keys, subject, visibility, statement);
    if (!written.ok) return written;

    // ONLY when this subject is not already indexed. `liveVisibility` returning
    // a non-null partition IS the statement "that partition's index contains
    // this subject" — it is the only way it can produce one. Calling
    // `addToSubjectIndex` anyway re-reads a whole feed, including a probe past
    // its latest version, to re-learn a fact this same call established. A
    // probe past the end is a bee network search for a chunk that does not
    // exist, the most expensive read on Swarm (#323).
    //
    // Skipping is also SAFER than re-reading, which is why this is not merely
    // an optimisation. In the race where another device publishes this subject
    // mid-tap, the re-read sees the freshly-swept private index, does not find
    // the subject, and writes it back — undoing the publish. Doing nothing
    // cannot undo anything.
    //
    // The read-modify-write loop still runs for the case it exists for: a first
    // lap on a subject, where `visibility` was null and nothing indexes it yet.
    if (where.visibility === null) {
      // The ride is recorded and valid from here on. An index failure costs
      // enumeration on a fresh device, not the count — so it must never turn a
      // landed ride into a reported failure, because the rider's retry would
      // read their own new statement as `prev` and add the laps a second time.
      try {
        await addToSubjectIndex(keys, subject, visibility);
      } catch {
        // Deliberately swallowed — see above.
      }
    }

    return { ok: true, statement, visibility, confirmed: written.confirmed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save that ride." };
  }
}

async function writeStatement(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
  statement: CreditStatementV1,
): Promise<{ ok: true; confirmed: boolean } | { ok: false; error: string }> {
  const body = visibility === "private"
    ? await sealJson(keys.encPubKeyHex, statement)
    : statement;

  const res = await writeContentFeedVerified({
    signerPrivKey: keys.feedPrivKey,
    ownerAddress: keys.feedAddress,
    topic: creditStatementTopic(saltFor(keys, visibility), subject),
    data: body,
  });

  // `superseded` is the one outcome that means the ride was NOT recorded: our
  // version carries another writer's bytes, so the total we computed is stale.
  // Retrying blindly would write a WRONG number, not a duplicate one.
  if (res.status === "superseded") {
    return { ok: false, error: "Another device recorded a ride at the same moment. Open again to see your count." };
  }
  return { ok: true, confirmed: res.status === "verified" };
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
async function addToSubjectIndex(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): Promise<boolean> {
  for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
    const existing = await readSubjectIndex(keys, visibility);
    if (existing.status === "unavailable") return false;
    const subjects = existing.status === "ok" ? existing.subjects : [];
    if (subjects.includes(subject)) return true;

    const written = await writeContentFeedVerified({
      signerPrivKey: keys.feedPrivKey,
      ownerAddress: keys.feedAddress,
      topic: creditSubjectIndexTopic(saltFor(keys, visibility)),
      data: { format: CREDIT_SUBJECT_INDEX_FORMAT, subjects: [...subjects, subject] },
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
    const written = await writeStatement(keys, subject, "public", statement);
    if (!written.ok) return written;

    // The private entry is removed ONLY once the public one is confirmed
    // present. Removing first — or removing after an unconfirmed add — can
    // leave the subject in NEITHER partition, which reads as "never ridden"
    // while a public head exists, and republishing then refuses.
    const added = await addToSubjectIndex(keys, subject, "public");
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
    const existing = await readSubjectIndex(keys, visibility);
    if (existing.status !== "ok" || !existing.subjects.includes(subject)) return false;

    const written = await writeContentFeedVerified({
      signerPrivKey: keys.feedPrivKey,
      ownerAddress: keys.feedAddress,
      topic: creditSubjectIndexTopic(saltFor(keys, visibility)),
      data: {
        format: CREDIT_SUBJECT_INDEX_FORMAT,
        subjects: existing.subjects.filter((s) => s !== subject),
      },
    });
    if (written.status === "verified") return true;
    if (written.status === "unconfirmed") return false;
  }
  return false;
}
