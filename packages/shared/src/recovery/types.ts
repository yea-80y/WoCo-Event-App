/**
 * Recovery-escrow wire types (PASSKEY_RECOVERY_PLAN §11).
 *
 * Only the SEALED envelope crosses the client↔server boundary and lands on the
 * public Swarm feed `woco/recovery/{kernelAddress}`. The plaintext bundle
 * (`RecoveryBundle`, the decrypted secrets) is defined client-side only and is
 * NEVER serialised to the server — the server stores ciphertext, never holds a
 * key or a sufficient share set (non-custodial, §11.3/§11.4).
 */

/**
 * Current envelope format. v2 binds a ROLE into the AEAD additional-data
 * (`woco/recovery/{role}/v2:{addr}`) so the guardian escrow and the portability
 * envelope can never authenticate each other's ciphertexts (#166 item 3). v1
 * (legacy, still openable) bound `woco/recovery/v1:{addr}` with no role. The
 * DEK scheme is unchanged across both: 1-of-1 backup-EOA escrow, single wrapped
 * DEK; M-of-N is a future version. AAD construction + the version allowlist
 * live client-side in `apps/web/src/lib/auth/recovery-aad.ts`.
 */
export const RECOVERY_ENVELOPE_VERSION = 2 as const;

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

/** Current presence-hint format. */
export const RECOVERY_STATUS_VERSION = 1 as const;

/**
 * Platform-signed PRESENCE HINT keyed by Kernel address (§13). Since the sealed
 * escrow envelope moved to a GUARDIAN-owned SOC — which cannot be read without the
 * backup-wallet signature — the UI can no longer probe "is this account protected?"
 * by fetching the envelope. This tiny doc fills that gap: it records only that a
 * protect happened. It NEVER holds the escrow, a key, the guardian or a name (#157:
 * it used to carry the guardian address and sub-ENS label, which linked a public
 * Kernel to its backup for anyone who asked the public endpoint).
 *
 * SECURITY: an untrusted convenience. The platform signs it, so it is forgeable/
 * withholdable — but a wrong value only mis-renders the setup screen ("on record"
 * vs "add a backup"), and it can attest presence only, never absence. It carries
 * no authority: real recoverability is proven ONLY by decrypting the guardian SOC.
 * Auto-find lives in the guardian-owned index (`guardian-index.ts`), not here.
 */
export interface RecoveryStatus {
  /** Format version (see RECOVERY_STATUS_VERSION). */
  v: number;
  /** True once a protect ceremony completed (on-chain install + guardian SOC). */
  configured: boolean;
  /** ms-epoch of the last protect write (display only). */
  updatedAt?: number;
}
