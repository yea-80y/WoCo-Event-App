/**
 * The guardian-owned account index on Swarm (#157) — write at protect time, read
 * at recovery time. See `GuardianAccountIndex` in shared for what it is and why
 * it is owned by the guardian's SOC signer rather than written by the server.
 *
 * Transport is the versioned content-feed rail (`writeContentFeed` /
 * `readContentFeedResult`): the index is rewritten whole on every change, and a
 * rewrite is based on a THOROUGH, clean read of the current version — a write on
 * top of a version we could not fully see could drop an account this backup
 * also guards, which is worse than not adding the new one.
 */

import {
  GUARDIAN_ACCOUNT_INDEX_TOPIC,
  isGuardianAccountIndex,
  upsertGuardianAccount,
  type GuardianAccountIndex,
} from "@woco/shared";
import { readContentFeedResult, writeContentFeed, type ContentFeedResult } from "./content-feed.js";

/**
 * Read the index a guardian SOC signer owns. Tri-state; bytes that are not an
 * index (a foreign payload at our topic) are `unavailable`, never "no accounts".
 * `thorough` is for the write path; the portal's discovery read leaves it off.
 */
export async function readGuardianAccountIndex(
  socOwnerAddress: string,
  opts: { thorough?: boolean } = {},
): Promise<ContentFeedResult<GuardianAccountIndex>> {
  // The index postdates content-feed versioning, so there is no legacy chunk to
  // probe for — one fewer missing-chunk search per recovery.
  const res = await readContentFeedResult<unknown>(socOwnerAddress, GUARDIAN_ACCOUNT_INDEX_TOPIC, {
    skipLegacy: true,
    thorough: opts.thorough,
  });
  if (res.status !== "found") return res;
  if (!isGuardianAccountIndex(res.value)) {
    return { status: "unavailable", reason: "payload at the guardian index topic is not an index" };
  }
  return { ...res, value: res.value };
}

export type GuardianIndexUpsertOutcome =
  | { status: "written"; version: number }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string };

/**
 * Add (or re-label) one account in the guardian's index. Non-throwing on the
 * read side by design — this runs inside the protect ceremony AFTER the
 * irreversible on-chain install, where it is a discovery nicety and must never
 * fail the protect; the caller logs `skipped`. The WRITE may still throw (relay
 * refused, network), and the caller treats that the same way.
 */
export async function upsertGuardianAccountIndex(args: {
  socSignerPrivKey: string;
  socOwnerAddress: string;
  entry: { kernelAddress: string; label?: string; addedAt: number };
}): Promise<GuardianIndexUpsertOutcome> {
  const current = await readGuardianAccountIndex(args.socOwnerAddress, { thorough: true });
  if (current.status === "unavailable") {
    return { status: "skipped", reason: `index unreadable: ${current.reason ?? "unknown"}` };
  }
  if (current.status === "found" && !current.scanClean) {
    // A dirty scan's "latest" is a lower bound. Rewriting from it could silently
    // drop an account added in a version we did not see.
    return { status: "skipped", reason: "index version scan was not conclusive" };
  }
  const next = upsertGuardianAccount(current.status === "found" ? current.value : null, args.entry);
  if (next.kind === "refused") return { status: "skipped", reason: next.reason };
  if (next.kind === "unchanged") return { status: "unchanged" };
  const version = await writeContentFeed({
    signerPrivKey: args.socSignerPrivKey,
    topic: GUARDIAN_ACCOUNT_INDEX_TOPIC,
    data: next.index,
  });
  return { status: "written", version };
}
