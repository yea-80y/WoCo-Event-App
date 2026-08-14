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
 * Counts are not computed here. A total is carried on the statement, so a
 * rider's own total needs one read; everyone else's needs an indexer.
 */

import { auth } from "../auth/auth-store.svelte.js";
import { getPodKeypair, restorePodSeed } from "../auth/pod-identity.js";
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

export type CreditVisibility = "private" | "public";

export interface CreditHead {
  statement: CreditStatementV1;
  visibility: CreditVisibility;
}

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

async function riderKeys(): Promise<RiderKeys> {
  const parent = auth.parent?.toLowerCase();
  if (!parent) throw new Error("Sign in to collect a credit.");

  // Derivation is a key-stretch, not authorship — the one thing the parent is
  // allowed to sign for. Idempotent after the first time on a device.
  await auth.ensurePodIdentity();

  const [pod, seed, feed] = await Promise.all([
    getPodKeypair(parent),
    restorePodSeed(parent),
    auth.getContentFeedSigner(),
  ]);
  if (!pod || !seed) throw new Error("Could not unlock your collection identity.");
  if (!feed) throw new Error("Could not unlock your feed signer.");

  const enc = deriveEncryptionKeypairFromPodSeed(seed);
  return {
    holderPrivKey: pod.privateKey,
    holder: pod.publicKeyHex,
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
// Reading
// ---------------------------------------------------------------------------

/**
 * Which partition holds this subject's live head, or null if the rider has
 * never ridden it.
 *
 * The subject index is the authority here, not a probe of both topics. That is
 * why the partition rule is load-bearing rather than hygiene: ONE LIVE HEAD per
 * (holder, subject), and the index is how a fresh device learns which one.
 * Probing the other topic would also cost a search for a chunk that does not
 * exist — the most expensive read on Swarm.
 */
async function liveVisibility(keys: RiderKeys, subject: Hex0x): Promise<CreditVisibility | null> {
  const [pub, priv] = await Promise.all([
    readSubjectIndex(keys, "public"),
    readSubjectIndex(keys, "private"),
  ]);
  if (pub.includes(subject)) return "public";
  if (priv.includes(subject)) return "private";
  return null;
}

async function readSubjectIndex(keys: RiderKeys, visibility: CreditVisibility): Promise<Hex0x[]> {
  const topic = creditSubjectIndexTopic(saltFor(keys, visibility));
  const res = await readContentFeedResult<unknown>(keys.feedAddress, topic);
  if (res.status !== "found" || !validateCreditSubjectIndexV1(res.value)) return [];
  return (res.value as CreditSubjectIndexV1).subjects;
}

async function readHeadAt(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): Promise<CreditStatementV1 | null> {
  const topic = creditStatementTopic(saltFor(keys, visibility), subject);
  const res = await readContentFeedResult<unknown>(keys.feedAddress, topic);
  if (res.status !== "found") return null;

  // A private head is a SealedBox; anything else at that address is foreign.
  // openJson throws on a wrong shape or a key that cannot decrypt it, and both
  // mean the same thing to a reader: there is no credit of ours here.
  const payload = visibility === "private"
    ? await openJson<unknown>(keys.encPrivKey, res.value as SealedBox).catch(() => null)
    : res.value;

  // verifyCreditStatement is dispatch -> closed-schema -> signature, and never
  // throws. A head that fails it is foreign bytes at our address, not a credit.
  return payload !== null && verifyCreditStatement(payload) ? payload : null;
}

/** The rider's current head for a subject, wherever it lives. */
export async function readMyCredit(subject: Hex0x): Promise<CreditHead | null> {
  const keys = await riderKeys();
  const visibility = await liveVisibility(keys, subject);
  if (!visibility) return null;
  const statement = await readHeadAt(keys, subject, visibility);
  return statement ? { statement, visibility } : null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export type RideResult =
  | { ok: true; statement: CreditStatementV1; visibility: CreditVisibility; confirmed: boolean }
  | { ok: false; error: string };

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
    const visibility = (await liveVisibility(keys, subject)) ?? "private";
    const prev = await readHeadAt(keys, subject, visibility);

    const statement = signCreditStatement(
      nextCreditStatement({ prev, subject, holder: keys.holder, laps }),
      keys.holderPrivKey,
    );
    const written = await writeStatement(keys, subject, visibility, statement);
    if (!written.ok) return written;

    await addToSubjectIndex(keys, subject, visibility);
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
  // version was taken by another device and the count we computed is stale.
  // Retrying blindly would write the wrong total, so the caller re-reads.
  if (res.status === "superseded") {
    return { ok: false, error: "Another device recorded a ride at the same moment. Open again to see your count." };
  }
  return { ok: true, confirmed: res.status === "verified" };
}

/**
 * Index maintenance. Subjects are never removed — the index records which
 * subjects have a live head in THIS partition, and publishing moves the entry
 * across rather than deleting it.
 */
async function addToSubjectIndex(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): Promise<void> {
  const existing = await readSubjectIndex(keys, visibility);
  if (existing.includes(subject)) return;
  await writeContentFeedVerified({
    signerPrivKey: keys.feedPrivKey,
    ownerAddress: keys.feedAddress,
    topic: creditSubjectIndexTopic(saltFor(keys, visibility)),
    data: { format: CREDIT_SUBJECT_INDEX_FORMAT, subjects: [...existing, subject] },
  });
}

// ---------------------------------------------------------------------------
// Publication — one way, and it says so
// ---------------------------------------------------------------------------

export type PublishResult =
  | { ok: true; statement: CreditStatementV1 }
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
 * private statement was ever selectively disclosed.
 *
 * The private head is retired by moving its index entry, never by writing a
 * tombstone — old versions stay readable at addresses only the rider can
 * compute, which is exactly the property the salted topic bought.
 */
export async function publishSubject(subject: Hex0x): Promise<PublishResult> {
  try {
    const keys = await riderKeys();
    const visibility = await liveVisibility(keys, subject);
    if (visibility === "public") return { ok: false, error: "This coaster is already public." };
    if (!visibility) return { ok: false, error: "Ride it once before publishing it." };

    const prev = await readHeadAt(keys, subject, "private");
    if (!prev) return { ok: false, error: "Could not read your private count — try again." };

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

    await addToSubjectIndex(keys, subject, "public");
    await removeFromSubjectIndex(keys, subject, "private");
    return { ok: true, statement };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not publish that." };
  }
}

/** The ONLY removal in this module: publishing moves an entry between
 *  partitions, and leaving it in both would leave two heads claiming to be
 *  live — the fork the one-live-head rule exists to prevent. */
async function removeFromSubjectIndex(
  keys: RiderKeys,
  subject: Hex0x,
  visibility: CreditVisibility,
): Promise<void> {
  const existing = await readSubjectIndex(keys, visibility);
  if (!existing.includes(subject)) return;
  await writeContentFeedVerified({
    signerPrivKey: keys.feedPrivKey,
    ownerAddress: keys.feedAddress,
    topic: creditSubjectIndexTopic(saltFor(keys, visibility)),
    data: { format: CREDIT_SUBJECT_INDEX_FORMAT, subjects: existing.filter((s) => s !== subject) },
  });
}
