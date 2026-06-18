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
