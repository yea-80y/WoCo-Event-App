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
  LOCAL_KEY: "woco:auth:local-key",
} as const;

/** Fixed nonce for deterministic POD identity derivation */
export const POD_IDENTITY_NONCE = "WOCO-POD-IDENTITY-V1";

/** Session delegation expiry duration (1 year in ms) */
export const SESSION_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

/** Session delegation purpose string */
export const SESSION_PURPOSE = "session";
