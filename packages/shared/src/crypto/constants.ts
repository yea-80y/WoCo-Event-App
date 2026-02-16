/**
 * EIP-712 domain and types for encryption key derivation.
 *
 * Follows the same deterministic pattern as POD identity derivation
 * (see auth/eip712.ts) but produces an X25519 keypair for encryption
 * instead of an Ed25519 keypair for signing.
 *
 * wallet.signTypedData(ENCRYPTION_DOMAIN, ENCRYPTION_TYPES, message)
 *   → keccak256(signature)
 *   → 32-byte seed
 *   → X25519 private key (seed used directly as scalar)
 */

/** EIP-712 domain for encryption key derivation */
export const ENCRYPTION_DOMAIN = {
  name: "WoCo Encryption",
  version: "1",
} as const;

/** EIP-712 types for DeriveEncryptionKey */
export const ENCRYPTION_TYPES = {
  DeriveEncryptionKey: [
    { name: "purpose", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;

/** Fixed nonce for deterministic encryption key derivation */
export const ENCRYPTION_NONCE = "WOCO-ENCRYPTION-V1";

/** HKDF info string used in ECIES key derivation */
export const ECIES_INFO = "woco/order/v1";
