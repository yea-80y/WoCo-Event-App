/**
 * EIP-712 domain and type definitions for WoCo auth signatures.
 *
 * Two separate signatures are required:
 * 1. AuthorizeSession - delegates a random session key (per-session, different each time)
 * 2. DeriveAccountKeys - derives the account's deterministic identity SEED (fixed
 *    nonce, same every time), from which every other account key is a KDF
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

/**
 * Domain for the ONE signature that establishes an account's key material.
 *
 * FROZEN FROM LAUNCH. Every byte here is an input to the seed — and therefore to
 * the X25519 encryption key, the secp256k1 issuing key and the content-feed
 * signer. Change the name, the version, the salt, the type name, a field name,
 * a field type, the purpose string or the nonce, and every existing account
 * derives a DIFFERENT seed: sealed order data stops decrypting, the organiser's
 * issuer identity moves, and every content SOC the user owns is orphaned under
 * an address nobody will look at. There is no migration short of re-publishing
 * everything. Pinned byte for byte by apps/web/test/identity-vectors.test.ts.
 *
 * The name changed once, on 2026-09-10, off its retired predecessor — a deliberate
 * pre-launch break with no users to carry, made so the sheet a person actually
 * signs says what it does. The SALT was deliberately NOT churned: it is opaque
 * to the user and rotating it buys nothing. The constants were renamed
 * alongside, so the byte change is visible at every call site.
 */
export const ACCOUNT_KEYS_DOMAIN = {
  name: "WoCo Account Keys",
  version: "1",
  salt: "0x8aee435983f8f356cb689567d575fe89bbd9f0d85e8e28c0d52c2fc340a9085a",
} as const;

/** EIP-712 types for DeriveAccountKeys. FROZEN — see {@link ACCOUNT_KEYS_DOMAIN}. */
export const ACCOUNT_KEYS_TYPES = {
  DeriveAccountKeys: [
    { name: "purpose", type: "string" },
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;

/**
 * The `purpose` field's value, FROZEN with the rest of the message.
 *
 * It lives here rather than at the call site because it is signed bytes, not
 * copy: a well-meaning edit in `identity-seed.ts` reads like a wording change and
 * is a key migration. Wallets render it, so it has to be a sentence a person can
 * act on — but it is the sentence, exactly, forever.
 */
export const ACCOUNT_KEYS_PURPOSE = "Derive the keys that unlock your WoCo account";

/**
 * Domain for the deterministic signature a guardian signs to derive its X25519
 * recovery-escrow encryption keypair (PASSKEY_RECOVERY_PLAN §11.6). Distinct
 * salt from the account-keys domain so the two derivations can never collide —
 * a guardian's escrow key and an account's own keys are different roles even off
 * the same EOA.
 */
export const RECOVERY_ENC_DOMAIN = {
  name: "WoCo Recovery Encryption",
  version: "1",
  salt: "0x7647dc11f8e77fbd6f190de7b59f8373a46165f670f178763a43b541fa988a20",
} as const;

/** EIP-712 types for DeriveRecoveryEncryptionKey */
export const RECOVERY_ENC_TYPES = {
  DeriveRecoveryEncryptionKey: [
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

/**
 * Domain for WoCo Shop crypto-payment binding signatures.
 *
 * Shop orders are placed anonymously (public endpoint), so a USDC payment — a
 * bare ERC-20 transfer with no memo — has nothing on-chain tying it to an order.
 * An anonymous buyer therefore signs this structured envelope to bind the
 * paying wallet to a specific order before paying; the server recovers the
 * signer and requires `tx.from === payer`. This is the anti-front-running guard
 * (an attacker cannot forge the buyer's wallet signing over a different orderId).
 *
 * EIP-712 (not EIP-191) deliberately: wallets render each labelled field so the
 * user sees exactly what they authorise — the opposite of blind signing — and
 * the domain (name/version/salt) makes the signature non-replayable in any
 * other WoCo context. Logged-in wallet buyers skip this entirely: their session
 * delegation already proves wallet control, so the payment is a single prompt.
 *
 * The binding deliberately OMITS the txHash so it can be pre-signed before the
 * transfer is broadcast (no sign → wait-for-tx → sign-again stall); it commits
 * to `quoteId` instead, which the server-side HMAC quote pins to the exact
 * amount + recipient + order.
 */
export const SHOP_PAYMENT_DOMAIN = {
  name: "WoCo Shop Payment",
  version: "1",
  salt: "0xa2562bedb66f3e39915c2bb23863110406fa11f5c97e4857f65eec064c1df8a7",
} as const;

/** EIP-712 types for the shop crypto-payment binding (anonymous buyers). */
export const SHOP_PAYMENT_TYPES = {
  ShopPayment: [
    { name: "shopId", type: "string" },
    { name: "orderId", type: "string" },
    { name: "quoteId", type: "string" },
    { name: "payer", type: "address" },
    { name: "amount", type: "string" },
    { name: "chainId", type: "uint256" },
  ],
} as const;
