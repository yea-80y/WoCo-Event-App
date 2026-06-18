import type { RecoveryEnvelope } from "@woco/shared";
import { readFeedPage, writeFeedPage, encodeJsonFeed, decodeJsonFeed } from "../swarm/feeds.js";
import { topicRecovery } from "../swarm/topics.js";

/**
 * Recovery-escrow persistence (PASSKEY_RECOVERY_PLAN §11.6 step 1).
 *
 * Stores the SEALED `RecoveryEnvelope` on the Swarm feed `woco/recovery/{kernel}`.
 * The envelope is ciphertext only (DEK wrapped to the guardian's X25519 key, bundle
 * AEAD'd) so the server — which signs the feed write — never holds plaintext or a
 * key. Non-custodial by construction (§11.3/§11.4). Reads are public: the locked-out
 * user has lost their signer and cannot authenticate during recovery.
 */

export async function getRecoveryEnvelope(kernelAddress: string): Promise<RecoveryEnvelope | null> {
  const page = await readFeedPage(topicRecovery(kernelAddress));
  if (!page) return null;
  return decodeJsonFeed<RecoveryEnvelope>(page);
}

export async function putRecoveryEnvelope(
  kernelAddress: string,
  envelope: RecoveryEnvelope,
): Promise<void> {
  // Synchronous upload — setup reads back the envelope immediately to confirm.
  await writeFeedPage(topicRecovery(kernelAddress), encodeJsonFeed(envelope), { deferred: false });
}
