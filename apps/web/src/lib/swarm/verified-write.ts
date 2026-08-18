/**
 * Read-back-verified content-feed write — the client rule frozen at P0
 * (docs/COASTER_CREDITS_PLAN.md, closure 5).
 *
 * `writeContentFeed` refuses when the version probe is INCONCLUSIVE, which
 * closes the case it can close. It cannot close this one: on a CLEAN probe,
 * two devices on the same account both resolve latest = N-1, both write N, and
 * the loser's chunk is silently discarded — a SOC is immutable, so Bee returns
 * 201 and keeps the first payload. The losing device is told it succeeded.
 *
 * That is not hypothetical here. Statements are per-user feeds written from
 * whatever device the user happens to be holding, and the pilot's own
 * recommended setup (a phone plus a warm spare logged into the same account)
 * is exactly two writers on one topic.
 *
 * The check reads back the EXACT version written, never "latest". Reading
 * latest cannot answer the question: a scan that resolves an OLDER version has
 * not shown our write was discarded, it has only failed to retrieve it —
 * a discarded write means our version exists carrying the WINNER's bytes. An
 * earlier revision conflated those and reported `superseded` on a stale scan,
 * which told a rider their ride had not been recorded when it had. They retry,
 * their own landed statement is now the previous one, and the carried total
 * increments twice for a single ride — permanently, in a write-once feed.
 *
 * Three states rather than two, for the same reason `SocReadOutcome` has three
 * — "I could not check" is not "it failed", and collapsing them either cries
 * wolf on a gateway hiccup or hides a genuinely lost write.
 */

import {
  assembleContentFeed,
  contentFeedSocIdentifier,
  versionedSocIdentifier,
  versionedPageIdentifier,
  type SocChunkProbe,
} from "@woco/shared";
import { writeContentFeed } from "./content-feed.js";

export type VerifiedWriteResult =
  /** Our bytes are what this version of the feed holds. */
  | { status: "verified"; version: number }
  /** Another writer's bytes are AT our version — this write is LOST, not late. */
  | { status: "superseded"; version: number }
  /** The write was accepted but could not be confirmed. Not a failure. */
  | { status: "unconfirmed"; version: number; reason: string };

/** Attempts of the read-back before giving up and reporting `unconfirmed`. */
const VERIFY_ATTEMPTS = 3;
/** Gap between read-back attempts (ms). */
const VERIFY_BACKOFF_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One in-flight write per (owner, topic), serialised.
 *
 * A read-modify-write on a feed — which every subject-index update is — has no
 * compare-and-swap underneath it, so two overlapping updates on the SAME device
 * are a straightforward lost update: both read version V, both compute from it,
 * and either the second write is discarded at V+1 or (worse, and staggered) it
 * lands at V+2 carrying a list computed from V, erasing the first update with a
 * write that verifies perfectly. Tapping two like buttons on one page is enough.
 *
 * Serialising per topic removes the same-device case entirely. The cross-device
 * case is structural and cannot be fixed here; it is survivable because SOC
 * versions are immutable, so an enumeration can union across versions later.
 */
const writeChain = new Map<string, Promise<unknown>>();

function serialise<T>(owner: string, topic: string, job: () => Promise<T>): Promise<T> {
  const key = `${owner.toLowerCase()}|${topic}`;
  const prior = writeChain.get(key) ?? Promise.resolve();
  // Chain off settlement, not success — one failed write must not wedge the
  // topic for the rest of the session.
  const next = prior.catch(() => undefined).then(job);
  writeChain.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Write `data` to the caller's own content feed and confirm the bytes landed.
 *
 * `ownerAddress` must be the address of `signerPrivKey` — it is what the
 * read-back addresses, and a mismatch would verify against a feed we did not
 * write. Callers hold both already (`auth.getContentFeedSigner()` returns the
 * key and its address together), so deriving it here would only add a second
 * place for them to disagree.
 */
export async function writeContentFeedVerified(args: {
  signerPrivKey: string;
  ownerAddress: string;
  topic: string;
  data: unknown;
  gatewayUrl?: string;
}): Promise<VerifiedWriteResult> {
  return serialise(args.ownerAddress, args.topic, () => writeAndVerify(args));
}

async function writeAndVerify(args: {
  signerPrivKey: string;
  ownerAddress: string;
  topic: string;
  data: unknown;
  gatewayUrl?: string;
}): Promise<VerifiedWriteResult> {
  const version = await writeContentFeed({
    signerPrivKey: args.signerPrivKey,
    topic: args.topic,
    data: args.data,
    ...(args.gatewayUrl ? { gatewayUrl: args.gatewayUrl } : {}),
  });
  return verifyLanded(args, version);
}

/**
 * Read back the bytes at the version we just wrote.
 *
 * NEVER THROWS. Every path returns a `VerifiedWriteResult`, because callers
 * that let this settle in the background (see {@link writeContentFeedSettling})
 * would otherwise produce an unhandled rejection for a condition that is
 * routine — a gateway having a bad minute.
 */
async function verifyLanded(
  args: { ownerAddress: string; topic: string; data: unknown },
  version: number,
): Promise<VerifiedWriteResult> {
 try {
  // Compare against the bytes we asked for, not the object: the feed stores
  // `JSON.stringify(data)`, and re-stringifying the parsed read-back reproduces
  // that text exactly (JSON.parse preserves the encoded key order).
  const intended = JSON.stringify(args.data);
  const base = contentFeedSocIdentifier(args.topic);
  // `thorough` so a chunk still settling on the public net is not read as
  // missing — the same reason the write path's own probe uses it.
  const { probeSoc } = await import("./client-soc.js");
  const read: SocChunkProbe = (id) => probeSoc(args.ownerAddress, id, { thorough: true });

  let lastReason = "read-back did not resolve";

  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(VERIFY_BACKOFF_MS * attempt);

    const asm = await assembleContentFeed(
      read,
      versionedSocIdentifier(base, version),
      (page) => versionedPageIdentifier(base, version, page),
    );

    if (asm.status === "found") {
      const landed = new TextDecoder().decode(asm.bytes);
      // Bytes at OUR version decide it, and nothing else can. A later version
      // existing is a normal concurrent update and says nothing about ours.
      return landed === intended
        ? { status: "verified", version }
        : { status: "superseded", version };
    }

    // Freshly relayed chunks are gateway-whitelisted asynchronously
    // (soc-upload.ts), so an immediate read can miss bytes that are genuinely
    // there. Absent is as inconclusive as unavailable at this instant — the one
    // moment in this codebase where `absent` may NOT be cached.
    lastReason = asm.status === "absent" ? "written chunk not yet readable" : (asm.reason ?? "feed unavailable");
  }

  return { status: "unconfirmed", version, reason: lastReason };
 } catch (e) {
  // An unconfirmed write is not a failed one: the upload was accepted before
  // this ran. Reporting it as such keeps a background settlement from turning a
  // landed entry into a reported failure.
  return { status: "unconfirmed", version, reason: e instanceof Error ? e.message : "read-back threw" };
 }
}

/**
 * Write, and hand the caller back the moment the UPLOAD is accepted — with the
 * read-back still running.
 *
 * WHY THIS EXISTS. Verification protects against exactly one thing: the silent
 * same-version dedupe where Bee returns 201 and keeps another writer's bytes.
 * Its outcomes are "no change", "still settling", or a retraction — and a
 * retraction is equally actionable two seconds later. Meanwhile the rider is
 * standing in a queue watching a button. Once the upload is accepted the signed
 * entry durably exists; making them wait for a check whose usual answer is "yes"
 * buys nothing.
 *
 * THE TOPIC STAYS SERIALISED. The chain waits for SETTLEMENT, not upload, so a
 * second write on the same topic still cannot race the first one's read-back —
 * which is the whole point of `serialise` and must not be traded away for
 * latency.
 *
 * `settled` never rejects. Callers may ignore it, but a caller that ignores it
 * gives up its only chance to learn the write was superseded.
 */
export interface SettlingWrite {
  /** The version the upload was accepted at. */
  version: number;
  /** Resolves when the read-back finishes. Never rejects. */
  settled: Promise<VerifiedWriteResult>;
}

export function writeContentFeedSettling(args: {
  signerPrivKey: string;
  ownerAddress: string;
  topic: string;
  data: unknown;
  gatewayUrl?: string;
  /**
   * FORWARDED to `writeContentFeed` — see its doc for when this is safe. It is
   * safe through THIS entry point in a way it is not through a bare write: the
   * read-back verifies at exactly this version, so a wrong guess comes back
   * `superseded` instead of silently losing the write.
   *
   * Declared explicitly because it was once omitted here while callers passed
   * it: a spread does not trip excess-property checking, so the value was
   * dropped silently and every write went on probing.
   */
  knownVersion?: number;
}): Promise<SettlingWrite> {
  let accept!: (w: SettlingWrite) => void;
  let refuse!: (e: unknown) => void;
  const uploaded = new Promise<SettlingWrite>((res, rej) => { accept = res; refuse = rej; });

  const job = serialise(args.ownerAddress, args.topic, async () => {
    let version: number;
    try {
      version = await writeContentFeed({
        signerPrivKey: args.signerPrivKey,
        topic: args.topic,
        data: args.data,
        ...(args.gatewayUrl ? { gatewayUrl: args.gatewayUrl } : {}),
        ...(args.knownVersion !== undefined ? { knownVersion: args.knownVersion } : {}),
      });
    } catch (e) {
      // The upload itself failed — there is nothing to settle, and the caller
      // must hear about it rather than paint a count for an entry that does
      // not exist.
      refuse(e);
      throw e;
    }
    const settled = verifyLanded(args, version);
    accept({ version, settled });
    // Returned so the per-topic chain waits for the read-back, not the upload.
    return settled;
  });
  // Failures reach the caller through `uploaded`; this only stops the chain's
  // own rejection from surfacing as unhandled.
  void job.catch(() => undefined);

  return uploaded;
}
