/**
 * EIP-712 domain and type definitions for WoCo auth signatures.
 *
 * Two separate signatures are required:
 * 1. AuthorizeSession - delegates a random session key (per-session, different each time)
 * 2. DerivePodIdentity - derives deterministic ed25519 POD key (fixed nonce, same every time)
 */

/** Domain for session delegation signatures */
export const SESSION_DOMAIN = {
  name: "WoCo Session",
  version: "1",
} as const;

/** EIP-712 types for AuthorizeSession */
export const SESSION_TYPES = {
  AuthorizeSession: [
    { name: "host", type: "string" },
    { name: "parent", type: "address" },
    { name: "session", type: "address" },
    { name: "purpose", type: "string" },
    { name: "nonce", type: "string" },
    { name: "issuedAt", type: "string" },
    { name: "expiresAt", type: "string" },
    { name: "sessionProof", type: "bytes" },
    { name: "clientCodeHash", type: "bytes32" },
    { name: "statement", type: "string" },
  ],
} as const;

/** Domain for POD identity derivation signatures */
export const POD_IDENTITY_DOMAIN = {
  name: "WoCo POD Identity",
  version: "1",
} as const;

/** EIP-712 types for DerivePodIdentity */
export const POD_IDENTITY_TYPES = {
  DerivePodIdentity: [
    { name: "purpose", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;
