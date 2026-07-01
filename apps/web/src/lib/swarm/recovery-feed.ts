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

import { recoveryContentTopic, contentFeedSocIdentifier, type RecoveryEnvelope } from "@woco/shared";
import { signAndUploadSoc, readSoc } from "./client-soc.js";

/**
 * Sign + upload the sealed recovery envelope as a guardian-owned SOC.
 * `socSignerPrivKey` is the guardian-derived SOC signer (from `deriveGuardianKeys`).
 * Throws on failure — this IS the escrow, so a failed write must abort the protect.
 */
export async function uploadRecoveryEnvelopeSoc(args: {
  socSignerPrivKey: string;
  kernelAddress: string;
  envelope: RecoveryEnvelope;
}): Promise<void> {
  const identifier = contentFeedSocIdentifier(recoveryContentTopic(args.kernelAddress));
  const payload = new TextEncoder().encode(JSON.stringify(args.envelope));
  await signAndUploadSoc({ signerPrivKey: args.socSignerPrivKey, identifier, payload });
}

/**
 * Read the guardian-owned recovery envelope SOC. `socOwnerAddress` is the guardian
 * SOC signer address the client derives LOCALLY from the connected backup wallet
 * (`deriveGuardianKeys().socSigner.address`) — no platform lookup in the loop. The
 * read is self-verifying (see `readSoc`). Returns null if absent (e.g. a
 * pre-§13 account whose envelope is still on the legacy platform feed).
 */
export async function readRecoveryEnvelopeSoc(
  socOwnerAddress: string,
  kernelAddress: string,
): Promise<RecoveryEnvelope | null> {
  const identifier = contentFeedSocIdentifier(recoveryContentTopic(kernelAddress));
  const raw = await readSoc(socOwnerAddress, identifier);
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as RecoveryEnvelope;
  } catch {
    return null;
  }
}
