import type { RecoveryEnvelope, RecoveryGuardianIndex, RecoveryStatus } from "@woco/shared";
import { readFeedPage, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "../swarm/feeds.js";
import { topicRecovery, topicRecoveryStatus, topicRecoveryGuardian } from "../swarm/topics.js";

/**
 * Recovery-escrow persistence (PASSKEY_RECOVERY_PLAN §11.6 / §13).
 *
 * §13: the SEALED `RecoveryEnvelope` is no longer written by the platform. It now
 * lives in a GUARDIAN-owned SOC that the CLIENT signs (`swarm/recovery-feed.ts`);
 * the server only stamps postage for it (`/api/swarm/soc`), so it can neither forge
 * nor withhold a user's escrow. This module now handles only:
 *  - `getRecoveryEnvelope` — LEGACY read of the old platform-signed feed, kept as a
 *    recovery fallback for accounts protected before the migration.
 *  - the untrusted platform HINTS (presence `RecoveryStatus`, guardian reverse index).
 */

/** LEGACY read of the platform-signed envelope feed (pre-§13 recovery fallback). */
export async function getRecoveryEnvelope(kernelAddress: string): Promise<RecoveryEnvelope | null> {
  const page = await readFeedPage(topicRecovery(kernelAddress));
  if (!page) return null;
  return decodeJsonFeed<RecoveryEnvelope>(page);
}

/**
 * Presence hint keyed by Kernel address (§13). Holds no escrow and no key — only a
 * "protected" flag plus display hints. Untrusted, like the guardian reverse index.
 */
export async function getRecoveryStatus(kernelAddress: string): Promise<RecoveryStatus | null> {
  const page = await readFeedPage(topicRecoveryStatus(kernelAddress));
  if (!page) return null;
  return decodeJsonFeed<RecoveryStatus>(page);
}

export async function putRecoveryStatus(kernelAddress: string, status: RecoveryStatus): Promise<void> {
  await writeFeedPage(topicRecoveryStatus(kernelAddress), encodeJsonFeed(status), { deferred: false });
}

/**
 * Guardian → account reverse-lookup hint (RecoveryGuardianIndex). Convenience
 * only: confidentiality and authorisation rest on the sealed envelope, not here.
 * Public read — the guardian↔account link is already on-chain.
 */
export async function getRecoveryByGuardian(
  guardianAddress: string,
): Promise<RecoveryGuardianIndex | null> {
  const page = await readFeedPage(topicRecoveryGuardian(guardianAddress));
  if (!page) return null;
  return decodeJsonFeed<RecoveryGuardianIndex>(page);
}

export async function putRecoveryByGuardian(
  guardianAddress: string,
  index: RecoveryGuardianIndex,
): Promise<void> {
  await writeFeedPage(topicRecoveryGuardian(guardianAddress), encodeJsonFeed(index), { deferred: false });
}
