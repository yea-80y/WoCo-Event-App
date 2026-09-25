/**
 * The banded SUBJECT INDEX read-modify-write, shared by every statement family
 * that has one.
 *
 * Extracted from `social.ts` unchanged when the referral campaign became the
 * second writer of one (#476). A second copy was the alternative and is the
 * worse one: the correctness of this loop lives entirely in the three guards
 * below (`thorough`, `bandClean`, re-read-and-union on `superseded`), each of
 * which was added after a specific failure, and a copy inherits the code
 * without inheriting the next fix.
 */

import { readBandedContentFeed } from "../swarm/content-feed.js";
import type { FeedRoute } from "../swarm/gateways.js";
import { writeContentFeedVerified } from "../swarm/verified-write.js";
import { LAST_VERSION_IN_BAND, type Hex0x, type SubjectIndexV1 } from "@woco/shared";

/** Per-family wiring — the things that differ between one index and another. */
export interface SubjectIndexKind {
  indexTopic: (band: number) => string;
  indexFormat: string;
  validateIndex: (value: unknown) => boolean;
  /** Where this family is stamped. Carried by the kind, never chosen here: the
   *  index is read back through its own family, and the two must never split. */
  route: FeedRoute;
}

/** Re-reads of the index after losing a write race, before giving up. */
const INDEX_WRITE_ATTEMPTS = 3;

/**
 * Add `subject` to the caller's index for this kind, if absent.
 *
 * Subjects are never REMOVED. The index records which subjects have a live head
 * under this salt partition, not which are currently liked — a retraction is a
 * statement at that head, so the head stays live and the entry stays correct.
 * Removing it would hide a `false` the indexer needs in order to stop counting.
 *
 * This is a read-modify-write with no compare-and-swap underneath, so losing
 * the race has to be handled rather than assumed away. `writeContentFeedVerified`
 * serialises same-device writes per topic and reports `superseded` when another
 * writer took our version; the only sound response is to re-read and union,
 * because retrying with the list we already computed would rewrite stale data
 * over the winner.
 *
 * Failures are swallowed after that: the statement is already written and
 * valid, and "your like worked but its index entry did not" is noise the user
 * cannot act on. It costs enumeration of THIS subject until the user next
 * toggles it — a write for a different subject does not repair it.
 */
export async function addToSubjectIndex(
  signer: { privKey: string; address: string },
  subject: Hex0x,
  kind: SubjectIndexKind,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < INDEX_WRITE_ATTEMPTS; attempt++) {
      // BANDED. This index grows one version per new subject and subjects are
      // never removed, so unbanded it was the one structure here whose read cost
      // tracked how much a user had ever liked. Social has no partition rule and
      // so nothing read beforehand to carry a band hint — it is discovered by
      // walking band openers, which the full-band invariant makes sound.
      // `thorough` — this read feeds the read-modify-write below, so it must not
      // trust the gateway's whitelist gate. A tagged 403 is treated as `absent`
      // on ordinary reads (probe-soc.ts), and a lost whitelist entry would
      // therefore arrive here as a CLEAN absent — the one shape the guard below
      // cannot catch, because it checks for INCONCLUSIVE, not for wrong.
      const res = await readBandedContentFeed<unknown>(signer.address, kind.indexTopic, {
        route: kind.route,
        thorough: true,
      });

      // Only `absent` may be treated as "no index yet". Writing a fresh one over
      // an index we merely FAILED to read would drop every subject it holds —
      // the lenient-read-on-a-write-path trap.
      let subjects: Hex0x[];
      if (res.status === "found") {
        // A read-modify-write of a whole snapshot must refuse on an inconclusive
        // resolution: the writer probes for a fresh address independently, and
        // would land this stale list at the real latest — verified — erasing
        // every subject added since. The statement is already written, so
        // stopping here costs enumeration only.
        if (!res.bandClean) return;
        if (!kind.validateIndex(res.value)) return;
        subjects = (res.value as SubjectIndexV1<string>).subjects;
        if (subjects.includes(subject)) return;
        subjects = [...subjects, subject];
      } else if (res.status === "absent") {
        subjects = [subject];
      } else {
        return;
      }

      // The index's own rollover, on the same rule the statement feeds use: a
      // band opens only once its predecessor is full.
      // `>=`: an overshoot must not disable rollover permanently.
      const rollover = res.status === "found" && res.version >= LAST_VERSION_IN_BAND;
      const targetBand = rollover ? res.band + 1 : res.band;

      const written = await writeContentFeedVerified({
        signerPrivKey: signer.privKey,
        ownerAddress: signer.address,
        topic: kind.indexTopic(targetBand),
        data: { format: kind.indexFormat, subjects },
        route: kind.route,
      });
      if (written.status !== "superseded") return;
    }
  } catch {
    // See doc comment — the statement stands regardless.
  }
}
