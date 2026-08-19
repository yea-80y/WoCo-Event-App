/**
 * The pure decisions on the credit write path: which partition holds a
 * rider's live head, and when a warm-head attempt must be redone cold.
 *
 * SEPARATED FROM `credits.ts` for the reason `next-statement.ts` already was:
 * that module reaches the auth store, which is a Svelte runes module and cannot
 * be loaded under plain node, so anything worth pinning has to live outside it.
 *
 * And this is worth pinning. `recordRide` SKIPS the subject-index write
 * whenever this returns a partition (#323), because a non-null `visibility`
 * already means "that partition's index contains this subject" — saving a whole
 * feed read, including a probe past the feed's latest version, which is a bee
 * network search for a chunk that does not exist and the most expensive read on
 * Swarm. The skip is sound only while that premise holds, and if it ever stops
 * holding the failure is silent: a subject nothing indexes, costing enumeration
 * on the rider's next device, with the lifetime count still intact so nobody
 * notices.
 *
 * TRI-STATE, like everything on the write path: "could not read" is never "not
 * there". An unavailable read on either side must surface as unavailable rather
 * than resolve to a partition, because `recordRide` refuses on a non-ok status
 * and a guessed partition would write to a topic the rider may have retired.
 */

import type { Hex0x } from "@woco/shared";
import type { CreditVisibility } from "./visibility.js";

/**
 * One index entry: a subject, and the BAND its head currently lives in.
 *
 * The band is why the index read pays for itself twice. The partition rule
 * already forces every read to consult the index before touching a head, so
 * carrying the band here costs nothing extra and removes the walk that made
 * head lookup grow with a rider's lap count.
 *
 * It is a MONOTONIC LOWER BOUND, not a promise: a stale value costs a short
 * forward walk over band openers, never a wrong answer.
 */
export interface SubjectBand {
  subject: Hex0x;
  band: number;
}

export type IndexRead =
  | { status: "ok"; entries: SubjectBand[] }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type PartitionRead =
  | { status: "ok"; visibility: CreditVisibility | null; band: number }
  | { status: "unavailable"; reason: string };

/**
 * Public wins when both list the subject. Publication is one-way
 * (`publishSubject`), so resolving to private would write the next lap to a
 * topic the rider has already retired.
 *
 * Returns the winning partition's recorded band. A subject in neither index has
 * never been ridden, so its head will start at band 0 — the same value a fresh
 * feed resolves to, which keeps the caller from special-casing first laps.
 */
export function decideVisibility(
  pub: IndexRead,
  priv: IndexRead,
  subject: Hex0x,
): PartitionRead {
  if (pub.status === "unavailable") return pub;
  if (priv.status === "unavailable") return priv;
  const inPub = pub.status === "ok" ? pub.entries.find((e) => e.subject === subject) : undefined;
  if (inPub) return { status: "ok", visibility: "public", band: inPub.band };
  const inPriv = priv.status === "ok" ? priv.entries.find((e) => e.subject === subject) : undefined;
  if (inPriv) return { status: "ok", visibility: "private", band: inPriv.band };
  return { status: "ok", visibility: null, band: 0 };
}

/**
 * Whether a finished write should be redone from a full, cold read.
 *
 * ONLY on `superseded`, and only once. Both halves are load-bearing:
 *
 * - `superseded` is the one settlement meaning the statement was NOT written —
 *   another writer's bytes are at our version. Redoing anything else risks
 *   writing a second time on top of a ride that already landed, which would add
 *   the laps twice.
 * - the ONCE is what stops a live race turning into a loop. The retry reads
 *   everything fresh, so a second loss is a genuine race with another device and
 *   the rider should be told rather than spun.
 *
 * Lives here, apart from `credits.ts`, because that module reaches the auth
 * store — a runes module that cannot load under plain node — and this is the
 * predicate most worth testing on the write path.
 */
export function shouldRetryCold(
  settlement: "verified" | "superseded" | "unconfirmed",
  retryAllowed: boolean,
): boolean {
  return settlement === "superseded" && retryAllowed;
}
