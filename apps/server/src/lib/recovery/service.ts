import type { RecoveryEnvelope, RecoveryStatus } from "@woco/shared";
import { readFeedPage, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "../swarm/feeds.js";
import { topicRecovery, topicRecoveryStatus } from "../swarm/topics.js";

/**
 * Recovery-escrow persistence (PASSKEY_RECOVERY_PLAN §11.6 / §13).
 *
 * §13: the SEALED `RecoveryEnvelope` is no longer written by the platform. It now
 * lives in a GUARDIAN-owned SOC that the CLIENT signs (`swarm/recovery-feed.ts`);
 * the server only stamps postage for it (`/api/swarm/soc`), so it can neither forge
 * nor withhold a user's escrow. This module now handles only:
 *  - `getRecoveryEnvelope` — LEGACY read of the old platform-signed feed, kept as a
 *    recovery fallback for accounts protected before the migration.
 *  - the untrusted platform presence hint (`RecoveryStatus`).
 * The guardian→account reverse index that used to live here is now a SOC the
 * GUARDIAN owns and the client reads directly (#157, `guardian-index.ts` in shared):
 * the server neither writes nor serves it.
 */

/** LEGACY read of the platform-signed envelope feed (pre-§13 recovery fallback). */
export async function getRecoveryEnvelope(kernelAddress: string): Promise<RecoveryEnvelope | null> {
  const page = await readFeedPage(topicRecovery(kernelAddress));
  if (!page) return null;
  return decodeJsonFeed<RecoveryEnvelope>(page);
}

/**
 * Presence hint keyed by Kernel address (§13). Holds no escrow, no key, no guardian
 * and no name — only a "protected" flag. Untrusted: presence only, never absence.
 */
export async function getRecoveryStatus(kernelAddress: string): Promise<RecoveryStatus | null> {
  const page = await readFeedPage(topicRecoveryStatus(kernelAddress));
  if (!page) return null;
  return decodeJsonFeed<RecoveryStatus>(page);
}

export async function putRecoveryStatus(kernelAddress: string, status: RecoveryStatus): Promise<void> {
  await writeFeedPage(topicRecoveryStatus(kernelAddress), encodeJsonFeed(status), { deferred: false });
}
