/**
 * Recovery-escrow wire types (PASSKEY_RECOVERY_PLAN §11).
 *
 * Only the SEALED envelope crosses the client↔server boundary and lands on the
 * public Swarm feed `woco/recovery/{kernelAddress}`. The plaintext bundle
 * (`RecoveryBundle`, the decrypted secrets) is defined client-side only and is
 * NEVER serialised to the server — the server stores ciphertext, never holds a
 * key or a sufficient share set (non-custodial, §11.3/§11.4).
 */

/** Current envelope format. v1 = 1-of-1 backup-EOA escrow (single wrapped DEK). */
export const RECOVERY_ENVELOPE_VERSION = 1 as const;

/**
 * Sealed escrow envelope. Confidentiality rests entirely on `wrappedDeks`
 * (libsodium sealed boxes to guardian X25519 keys) — every other field is
 * public. `kernelAddress` is also bound as AEAD additional-data so a stolen
 * envelope cannot be replayed against a different account.
 */
export interface RecoveryEnvelope {
  /** Envelope format version (see RECOVERY_ENVELOPE_VERSION). */
  v: number;
  /** Lowercased Kernel address this bundle belongs to; also the AEAD AAD. */
  kernelAddress: string;
  /** XChaCha20-Poly1305 nonce (24 bytes, hex). */
  nonce: string;
  /** AEAD ciphertext of the bundle JSON (hex). */
  ciphertext: string;
  /**
   * The data-encryption key (DEK) sealed to each guardian's X25519 public key
   * via `crypto_box_seal`. v1 = 1-of-1, so a single entry; any listed guardian
   * can recover the full DEK (1-of-N). True M-of-N threshold escrow is a future
   * envelope version using verifiable secret sharing over the DEK (§11.6 step 2).
   */
  wrappedDeks: string[];
}

/**
 * Reverse lookup written at setup so a connected backup wallet can AUTO-FIND the
 * account it protects — sparing a locked-out user from recalling a hex address.
 *
 * Keyed on the guardian address, whose guardian↔account link is ALREADY public
 * on-chain (the Kernel's recovery config), so this index discloses nothing new.
 *
 * SECURITY: this is an untrusted CONVENIENCE HINT, never an authorisation. The
 * guardian address derives from a public backup address, so the index is
 * poisonable (anyone can claim a guardian maps to their own account). It cannot
 * cause harm: recovery decrypts the escrow envelope FIRST, and only the genuine
 * account's envelope is sealed to the real guardian's X25519 key (from an
 * unforgeable backup-wallet signature). A wrong/poisoned hit fails to decrypt and
 * aborts before any on-chain action. The manual name/address entry is the fallback.
 */
export interface RecoveryGuardianIndex {
  /** Lowercased Kernel address this guardian can recover. */
  kernelAddress: string;
  /** Optional sub-ENS label ({label}.woco.eth) for a human-readable confirmation. */
  label?: string;
}

/** Current presence-hint format. */
export const RECOVERY_STATUS_VERSION = 1 as const;

/**
 * Platform-signed PRESENCE HINT keyed by Kernel address (§13). Since the sealed
 * escrow envelope moved to a GUARDIAN-owned SOC — which cannot be read without the
 * backup-wallet signature — the UI can no longer probe "is this account protected?"
 * by fetching the envelope. This tiny doc fills that gap: it records only that a
 * protect happened, plus display hints. It NEVER holds the escrow or a key.
 *
 * SECURITY: an untrusted convenience, exactly like {@link RecoveryGuardianIndex}.
 * The platform signs it, so it is forgeable/withholdable — but a wrong value only
 * mis-renders the setup screen ("on record" vs "add a backup"). It carries no
 * authority: real recoverability is proven ONLY by decrypting the guardian SOC.
 */
export interface RecoveryStatus {
  /** Format version (see RECOVERY_STATUS_VERSION). */
  v: number;
  /** True once a protect ceremony completed (on-chain install + guardian SOC). */
  configured: boolean;
  /** Guardian (weighted-ECDSA) address pinned on-chain — display hint only. */
  guardianAddress?: string;
  /** Optional sub-ENS label ({label}.woco.eth) for a human-readable confirmation. */
  label?: string;
  /** ms-epoch of the last protect write (display only). */
  updatedAt?: number;
}
