/** IndexedDB database name */
export const IDB_NAME = "woco-auth";

/** IndexedDB object store name */
export const IDB_STORE = "kv";

/** Storage keys for IndexedDB */
export const StorageKeys = {
  DEVICE_KEY: "woco:device-key",
  AUTH_KIND: "woco:auth:kind",
  PARENT_ADDRESS: "woco:auth:parent",
  SESSION_KEY: "woco:auth:session-key",
  SESSION_DELEGATION: "woco:auth:session-delegation",
  POD_SEED: "woco:auth:pod-seed",
  // PRF-EOA address used as the POD derivation/AAD key for passkey logins.
  // The Kernel smart-account address is the parent; POD must stay on the raw
  // PRF-EOA address (invariant #1) so it survives the future Option 2 swap.
  POD_ADDRESS: "woco:auth:pod-address",
  // Durable RECOVERED-account binding: `{ pod, kernel }`. After recovery the
  // Kernel's sudo owner is rotated but its address is PRESERVED, so the rotated
  // passkey's counterfactual CREATE2 address no longer equals the account address.
  // This records "the passkey whose PRF-EOA = `pod` controls the Kernel at
  // `kernel`" so loginPasskey/_ensureKernel rebuild AT the preserved address via
  // the override instead of the (now-divergent) counterfactual. Keyed to the
  // PRF-EOA so it only applies to the matching passkey; persists across logout
  // (like LOCAL_KEY) so re-login works.
  RECOVERED_KERNEL_BINDING: "woco:auth:recovered-kernel",
  LOCAL_KEY: "woco:auth:local-key",
  PASSKEY_CREDENTIAL: "woco:auth:passkey-credential",
  // ZeroDev on-chain session key: the scoped, serialized permission account
  // (contains the session private key) encrypted at rest. DISTINCT from
  // SESSION_KEY, which is the EIP-712 HTTP session-delegation key — these are
  // two unrelated "session" concepts (see ZERODEV_PASSKEY_INTEGRATION_PLAN.md).
  // :v3 — invalidates any session key minted with EAS attest/revoke baked into
  // its call policy (the nested-tuple ABI broke paymaster gas estimation and
  // poisoned sub-ENS claims). This key is now registerWithPermit-only; a fresh
  // one mints on next use. EAS likes get their own key (WOCO_AA_EAS_SESSION).
  WOCO_AA_SESSION: "woco:auth:aa-session:v3",
  // EAS likes/following session key — scoped to EAS attest/revoke (selector-only,
  // no nested-tuple ABI in enable-data). Kept SEPARATE from WOCO_AA_SESSION so a
  // change to one can never poison the other's gas estimation.
  WOCO_AA_EAS_SESSION: "woco:auth:aa-eas-session:v1",
  // Phase B content-feed signer ADDRESS (public — the SOC owner of the user's
  // own content feeds). Cached so self-reads (e.g. their own profile/avatar)
  // resolve the owner WITHOUT re-deriving the key — which for passkey would
  // trigger a WebAuthn PRF prompt. Writes still derive the private key on demand
  // (an explicit user action where a prompt is acceptable). Address only, never
  // the key.
  CONTENT_FEED_SIGNER_ADDRESS: "woco:auth:content-feed-signer",
  // Phase B content-feed signer PRIVATE KEY — the user's INDEPENDENT, escrowed
  // feed-signer secret (encrypted at rest, AAD-bound to the parent address, same
  // as POD_SEED). Established once per account, then ESCROWED + restored on any
  // device — NEVER re-derived (recovery-stability requires escrow, not
  // derivation; a rotated passkey credential would derive a divergent key and
  // orphan the user's feeds). Distinct from CONTENT_FEED_SIGNER_ADDRESS, which
  // holds only the public address for no-prompt self-reads.
  CONTENT_FEED_SIGNER_KEY: "woco:auth:content-feed-signer-key",
} as const;

/** Fixed salt input for passkey PRF → secp256k1 key derivation */
export const PASSKEY_PRF_SALT_INPUT = "woco-passkey-secp256k1-v1";

/** Fixed nonce for deterministic POD identity derivation */
export const POD_IDENTITY_NONCE = "WOCO-POD-IDENTITY-V1";

/** Fixed nonce for deterministic guardian recovery-escrow X25519 key derivation */
export const RECOVERY_ENC_NONCE = "WOCO-RECOVERY-ENC-V1";

/** Session delegation expiry duration (30 days in ms) */
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Session delegation purpose string */
export const SESSION_PURPOSE = "session";

/** Maximum age for a passkey / wallet-signed claim signature (5 minutes) */
export const PASSKEY_CLAIM_MAX_AGE_MS = 300_000;
