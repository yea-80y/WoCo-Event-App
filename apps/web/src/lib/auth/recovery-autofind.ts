/**
 * Auto-find at recovery time (#157): from the guardian's own account index to
 * ONE account the portal can show as "Protected account found".
 *
 * Pure over injected reads so the walk is unit-tested. Every candidate is
 * confirmed against the CHAIN — `isGuardianRegistered(guardian, kernel)` — not
 * merely "has a recovery route": a backup the account later replaced still
 * lists the account in this guardian's index (the index cannot be rewritten
 * without the backup wallet), and showing that account as found would send the
 * user into a ceremony the hook refuses. The chain check is what the server-side
 * tombstones used to approximate, and it is exact where they were best-effort.
 *
 * Tri-state in, tri-state out. An index we could not read, or a candidate the
 * chain would not answer for, is `unavailable` — the portal then opens manual
 * entry with a "couldn't look it up" note, never "no account found".
 */

import type { GuardianAccountIndex } from "@woco/shared";
import { orderGuardianCandidates } from "@woco/shared";
import type { ContentFeedResult } from "../swarm/content-feed.js";

/** `true` = this guardian is in the account's CURRENT set; `false` = not; `null` = could not read. */
export type GuardianRegisteredCheck = (kernelAddress: string) => Promise<boolean | null>;

export type AutoFindOutcome =
  | { status: "found"; kernelAddress: string; label?: string }
  /** Index absent, empty, or no listed account is still protected by this guardian. */
  | { status: "none" }
  /** Index unreadable, or some candidate could not be checked and none was confirmed. */
  | { status: "unavailable"; reason: string };

/** How many listed accounts the portal will check before falling back to manual entry. */
export const AUTO_FIND_MAX_CANDIDATES = 8;

export async function autoFindAccount(args: {
  index: ContentFeedResult<GuardianAccountIndex>;
  isRegistered: GuardianRegisteredCheck;
  maxCandidates?: number;
}): Promise<AutoFindOutcome> {
  const { index } = args;
  if (index.status === "unavailable") {
    return { status: "unavailable", reason: index.reason ?? "guardian index unreadable" };
  }
  if (index.status === "absent") return { status: "none" };

  const candidates = orderGuardianCandidates(index.value).slice(0, args.maxCandidates ?? AUTO_FIND_MAX_CANDIDATES);
  let unreadable = 0;
  for (const c of candidates) {
    const registered = await args.isRegistered(c.kernelAddress);
    if (registered === true) {
      return { status: "found", kernelAddress: c.kernelAddress, ...(c.label ? { label: c.label } : {}) };
    }
    if (registered === null) unreadable++;
  }
  if (unreadable > 0) {
    return { status: "unavailable", reason: `${unreadable} listed account(s) could not be checked on-chain` };
  }
  return { status: "none" };
}
