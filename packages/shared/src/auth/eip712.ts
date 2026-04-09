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
  salt: "0x6f4cd6d4884d2ce64f043d7771738e9e50d62d873557ab8c13d2e219ec7ecbe3",
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
  salt: "0x8aee435983f8f356cb689567d575fe89bbd9f0d85e8e28c0d52c2fc340a9085a",
} as const;

/** EIP-712 types for DerivePodIdentity */
export const POD_IDENTITY_TYPES = {
  DerivePodIdentity: [
    { name: "purpose", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;

/**
 * Domain for ticket-claim signatures (passkey + embed wallet-signed paths).
 * Replaces the legacy EIP-191 personal_sign challenge `woco:claim:<eventId>:<seriesId>:<timestamp>`
 * with a structured EIP-712 envelope, so wallets display each field to the
 * user instead of an opaque string.
 */
export const CLAIM_DOMAIN = {
  name: "WoCo Claim",
  version: "1",
  salt: "0x3065fa744343298ca5fb565b5758daf8c27fc865afaa3be81f9e4981871b57ae",
} as const;

/** EIP-712 types for ClaimTicket */
export const CLAIM_TYPES = {
  ClaimTicket: [
    { name: "eventId", type: "string" },
    { name: "seriesId", type: "string" },
    { name: "claimer", type: "address" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;
