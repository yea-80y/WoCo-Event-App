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
 * authenticates it implicitly, so a declared version cannot be flipped to select
 * another AAD. MUST stay byte-identical at seal and open. Only the CURRENT version
 * opens; every other one throws a typed error saying which way it is wrong, because
 * the callers act on "older" and "newer" in opposite ways.
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
 * `envelope.v` names a format this app no longer opens: v1 and v2 wrapped the DEK
 * with X25519 alone, and #642 retired them (pre-launch, no compat path). Unlike a
 * NEWER envelope this one is stale, not someone else's work — the portability
 * self-heal may rewrite it — and the user's way out is to set recovery up again.
 */
export class RetiredRecoveryEnvelopeVersionError extends Error {
  readonly envelopeVersion: number;
  constructor(v: number) {
    super(
      `This backup was made with an older version of WoCo (format ${v}) that can no longer be opened. ` +
        "If you can still sign in, set up account recovery again to replace it.",
    );
    this.name = "RetiredRecoveryEnvelopeVersionError";
    this.envelopeVersion = v;
  }
}

/**
 * The AAD for one (role, envelope version, bound address) triple. Namespaced
 * (never a bare address) so the tag is unambiguous, lowercased so casing
 * variation cannot break the bind.
 *
 *  - v3 (current, #642): `woco/recovery/{role}/v3:{addr}`, X-Wing-wrapped DEK.
 *  - v1, v2: retired → {@link RetiredRecoveryEnvelopeVersionError}.
 *  - anything else → {@link UnknownRecoveryEnvelopeVersionError}.
 */
export function recoveryAadBytes(
  role: RecoveryAadRole,
  envelopeVersion: number,
  boundAddress: string,
): Uint8Array {
  const addr = boundAddress.toLowerCase();
  if (envelopeVersion === RECOVERY_ENVELOPE_VERSION) {
    return new TextEncoder().encode(`woco/recovery/${role}/v${envelopeVersion}:${addr}`);
  }
  if (Number.isInteger(envelopeVersion) && envelopeVersion >= 1 && envelopeVersion < RECOVERY_ENVELOPE_VERSION) {
    throw new RetiredRecoveryEnvelopeVersionError(envelopeVersion);
  }
  throw new UnknownRecoveryEnvelopeVersionError(envelopeVersion);
}
