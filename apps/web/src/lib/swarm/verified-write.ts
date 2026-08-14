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
 * So: write, then read back, and report which of the three things happened.
 * Three states rather than two, for the same reason `SocReadOutcome` has three
 * — "I could not check" is not "it failed", and collapsing them either cries
 * wolf on a gateway hiccup or hides a genuinely lost write.
 */

import { writeContentFeed, readContentFeedResult } from "./content-feed.js";

export type VerifiedWriteResult =
  /** Our bytes are what the feed holds. */
  | { status: "verified"; version: number }
  /** Someone else's bytes are at our version — this write is LOST, not late. */
  | { status: "superseded"; version: number }
  /** The write was accepted but could not be confirmed. Not a failure. */
  | { status: "unconfirmed"; version: number; reason: string };

/** Attempts of the read-back before giving up and reporting `unconfirmed`. */
const VERIFY_ATTEMPTS = 3;
/** Gap between read-back attempts (ms). */
const VERIFY_BACKOFF_MS = 400;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const version = await writeContentFeed({
    signerPrivKey: args.signerPrivKey,
    topic: args.topic,
    data: args.data,
    ...(args.gatewayUrl ? { gatewayUrl: args.gatewayUrl } : {}),
  });

  // Compare against the bytes we asked for, not the object: the feed stores
  // `JSON.stringify(data)`, and re-stringifying the parsed read-back reproduces
  // that text exactly (JSON.parse preserves the encoded key order).
  const intended = JSON.stringify(args.data);
  let lastReason = "read-back did not resolve";

  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(VERIFY_BACKOFF_MS * attempt);
    const res = await readContentFeedResult<unknown>(args.ownerAddress, args.topic);

    if (res.status === "found") {
      if (JSON.stringify(res.value) === intended) return { status: "verified", version };
      // A HIGHER version means someone wrote after us and our bytes may still
      // be intact underneath — that is a normal concurrent update, not a lost
      // write, and the caller's next read gets the current truth either way.
      // Only a different payload AT OUR VERSION proves we were discarded.
      if (res.version > version) {
        return { status: "unconfirmed", version, reason: `feed advanced to version ${res.version} during verification` };
      }
      return { status: "superseded", version };
    }

    // Freshly relayed chunks are gateway-whitelisted asynchronously
    // (soc-upload.ts), so an immediate read can miss bytes that are genuinely
    // there. Absent is as inconclusive as unavailable at this instant — the one
    // moment in this codebase where `absent` may NOT be cached.
    lastReason = res.status === "absent" ? "written chunk not yet readable" : (res.reason ?? "feed unavailable");
  }

  return { status: "unconfirmed", version, reason: lastReason };
}
