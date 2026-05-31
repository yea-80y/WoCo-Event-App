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
  LOCAL_KEY: "woco:auth:local-key",
  PASSKEY_CREDENTIAL: "woco:auth:passkey-credential",
  // ZeroDev on-chain session key: the scoped, serialized permission account
  // (contains the session private key) encrypted at rest. DISTINCT from
  // SESSION_KEY, which is the EIP-712 HTTP session-delegation key — these are
  // two unrelated "session" concepts (see ZERODEV_PASSKEY_INTEGRATION_PLAN.md).
  WOCO_AA_SESSION: "woco:auth:aa-session",
} as const;

/** Fixed salt input for passkey PRF → secp256k1 key derivation */
export const PASSKEY_PRF_SALT_INPUT = "woco-passkey-secp256k1-v1";

/** Fixed nonce for deterministic POD identity derivation */
export const POD_IDENTITY_NONCE = "WOCO-POD-IDENTITY-V1";

/** Session delegation expiry duration (30 days in ms) */
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Session delegation purpose string */
export const SESSION_PURPOSE = "session";

/** Maximum age for a passkey / wallet-signed claim signature (5 minutes) */
export const PASSKEY_CLAIM_MAX_AGE_MS = 300_000;
