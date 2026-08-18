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

export type IndexRead =
  | { status: "ok"; subjects: Hex0x[] }
  | { status: "absent" }
  | { status: "unavailable"; reason: string };

export type PartitionRead =
  | { status: "ok"; visibility: CreditVisibility | null }
  | { status: "unavailable"; reason: string };

/**
 * Public wins when both list the subject. Publication is one-way
 * (`publishSubject`), so resolving to private would write the next lap to a
 * topic the rider has already retired.
 */
export function decideVisibility(
  pub: IndexRead,
  priv: IndexRead,
  subject: Hex0x,
): PartitionRead {
  if (pub.status === "unavailable") return pub;
  if (priv.status === "unavailable") return priv;
  if (pub.status === "ok" && pub.subjects.includes(subject)) return { status: "ok", visibility: "public" };
  if (priv.status === "ok" && priv.subjects.includes(subject)) return { status: "ok", visibility: "private" };
  return { status: "ok", visibility: null };
}

/**
 * Whether a failed ride attempt should be retried from a full, cold read.
 *
 * ONLY when a warm head was used AND the write came back `superseded`. Both
 * halves are load-bearing:
 *
 * - `superseded` is the one failure meaning the statement was NOT written —
 *   our version carries another writer's bytes. Retrying anything else risks
 *   writing a second time on top of a ride that already landed, which would
 *   add the laps twice.
 * - the WARM condition is what makes the retry honest rather than hopeful. A
 *   cold attempt that was superseded lost a real race with another device, and
 *   its message stands. A warm one only proves the head the page handed us went
 *   stale between load and tap — which re-reading actually fixes.
 *
 * Never retry more than once: the second attempt reads everything fresh, so a
 * further `superseded` is a live race the rider should be told about, not a
 * loop to spin in.
 */
export function shouldRetryCold(
  attempt: { ok: boolean; superseded?: boolean },
  usedWarmHead: boolean,
): boolean {
  return !attempt.ok && attempt.superseded === true && usedWarmHead;
}
