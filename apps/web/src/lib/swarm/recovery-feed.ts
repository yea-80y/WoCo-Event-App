/**
 * Guardian-owned recovery-escrow SOC (PASSKEY_RECOVERY_PLAN §13).
 *
 * The sealed `RecoveryEnvelope` is stored as a Single-Owner Chunk SIGNED by a
 * signer the GUARDIAN derives from the backup wallet (`deriveGuardianKeys` →
 * `socSigner`), not by the platform feed key. The server only stamps postage
 * (`signAndUploadSoc` → `/api/swarm/soc`), so it can neither forge nor withhold
 * the envelope: the SOC is self-verifying (a reader rejects any chunk whose
 * recovered signer ≠ the guardian owner), and once uploaded it is retrievable by
 * computed address from any gateway.
 *
 * Confidentiality is unchanged — the payload is the SAME sealed ciphertext
 * (`recovery-escrow.ts`); the owner is irrelevant to the seal. This module only
 * changes WHO owns the storage slot.
 *
 * Honest caveat: client-SIGNED ≠ client-UPLOADED. The write is still stamped with
 * the platform postage batch, so this removes platform SIGNER control only, not
 * the postage dependency (that is the separate per-user-batch track). Do not claim
 * "fully decentralised storage" on the strength of this change alone.
 */

import { recoveryContentTopic, type RecoveryEnvelope } from "@woco/shared";
import { writeContentFeed, readContentFeed } from "./content-feed.js";

/**
 * Sign + upload the sealed recovery envelope as a guardian-owned SOC.
 * `socSignerPrivKey` is the guardian-derived SOC signer (from `deriveGuardianKeys`).
 * Throws on failure — this IS the escrow, so a failed write must abort the protect.
 *
 * Written through the VERSIONED content-feed rail: re-writes (new recipients /
 * rotation) would otherwise be silently discarded (a SOC at a fixed identifier is
 * immutable). Legacy pre-versioning envelopes remain readable via the fallback.
 */
export async function uploadRecoveryEnvelopeSoc(args: {
  socSignerPrivKey: string;
  kernelAddress: string;
  envelope: RecoveryEnvelope;
}): Promise<void> {
  await writeContentFeed({
    signerPrivKey: args.socSignerPrivKey,
    topic: recoveryContentTopic(args.kernelAddress),
    data: args.envelope,
  });
}

/**
 * Read the guardian-owned recovery envelope SOC. `socOwnerAddress` is the guardian
 * SOC signer address the client derives LOCALLY from the connected backup wallet
 * (`deriveGuardianKeys().socSigner.address`) — no platform lookup in the loop. The
 * read is self-verifying (see `readSoc`). Resolves the latest version and falls
 * back to the legacy fixed identifier. Returns null if absent (e.g. a pre-§13
 * account whose envelope is still on the legacy platform feed).
 */
export async function readRecoveryEnvelopeSoc(
  socOwnerAddress: string,
  kernelAddress: string,
): Promise<RecoveryEnvelope | null> {
  return readContentFeed<RecoveryEnvelope>(socOwnerAddress, recoveryContentTopic(kernelAddress));
}
