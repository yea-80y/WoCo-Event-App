/**
 * Which partition holds a rider's live head for a subject — the pure half.
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
