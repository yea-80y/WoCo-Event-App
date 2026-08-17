/**
 * Recovery-envelope AAD construction (#166 item 3).
 *
 * The AEAD additional-data binds a sealed `RecoveryEnvelope` to one account AND
 * to the ROLE it was sealed for. Two roles share the escrow construction today:
 *
 *  - "guardian":    the recovery escrow, bound to a Kernel address
 *                   (auth-store.setupAccountRecovery / recovery ceremony);
 *  - "portability": the cross-device envelope, bound to a PRF-derived
 *                   socOwnerAddress pseudonym (recovery-portability.ts).
 *
 * Before v2 the two were separated only incidentally — independent recipient
 * keys, no address ever used in both roles. A future change sealing one bundle
 * to both recipient sets (explicitly anticipated in both modules) would have
 * removed that barrier with no signal. Baking the role into the AAD makes the
 * separation cryptographic: a ciphertext sealed for one role can never
 * authenticate under the other's AAD, whatever keys it was wrapped to.
 *
 * The version component is driven by `envelope.v` AT OPEN, and the AEAD tag
 * authenticates it implicitly: flipping a v2 envelope's declared version to 1
 * selects the legacy AAD, under which the tag cannot verify — so the version
 * field is downgrade-proof without any extra check. MUST stay byte-identical at
 * seal and open; versions are an explicit allowlist, and an unknown one throws
 * the typed error below rather than guessing an AAD that can only fail opaquely.
 */

import { RECOVERY_ENVELOPE_VERSION } from "@woco/shared";

export type RecoveryAadRole = "guardian" | "portability";

/**
 * `envelope.v` names a format this client does not know — almost always an
 * envelope written by a NEWER app version. Callers must treat it as "cannot
 * act", never as corruption: a self-heal that rewrites on this error would
 * DOWNGRADE a newer client's envelope (the #166-comment back-fill hazard).
 */
export class UnknownRecoveryEnvelopeVersionError extends Error {
  readonly envelopeVersion: unknown;
  constructor(v: unknown) {
    super(
      `Recovery envelope version ${String(v)} is newer than this app understands — ` +
        "update the app to use this backup.",
    );
    this.name = "UnknownRecoveryEnvelopeVersionError";
    this.envelopeVersion = v;
  }
}

/**
 * The AAD for one (role, envelope version, bound address) triple. Namespaced
 * (never a bare address) so the tag is unambiguous, lowercased so casing
 * variation cannot break the bind.
 *
 * Version allowlist — one branch per format ever sealed, never a template:
 *  - v1 (legacy): `woco/recovery/v1:{addr}` — no role component. Envelopes
 *    sealed before roles existed; their role separation rests, as it always
 *    did, on the two roles' independent recipient keys. Kept openable so
 *    pre-v2 escrows still recover.
 *  - v2 (current): `woco/recovery/{role}/v2:{addr}`.
 * Anything else throws {@link UnknownRecoveryEnvelopeVersionError}.
 */
export function recoveryAadBytes(
  role: RecoveryAadRole,
  envelopeVersion: number,
  boundAddress: string,
): Uint8Array {
  const addr = boundAddress.toLowerCase();
  if (envelopeVersion === 1) {
    return new TextEncoder().encode(`woco/recovery/v1:${addr}`);
  }
  if (envelopeVersion === RECOVERY_ENVELOPE_VERSION) {
    return new TextEncoder().encode(`woco/recovery/${role}/v${envelopeVersion}:${addr}`);
  }
  throw new UnknownRecoveryEnvelopeVersionError(envelopeVersion);
}
