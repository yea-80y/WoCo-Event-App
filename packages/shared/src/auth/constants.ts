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
  // Durable RECOVERED-account bindings: a MAP `{ [prfEoaLower]: kernelAddress }`.
  // After recovery the Kernel's sudo owner is rotated but its address is PRESERVED,
  // so the rotated passkey's counterfactual CREATE2 address no longer equals the
  // account address. Each entry records "the passkey whose PRF-EOA = key controls
  // the Kernel at value" so loginPasskey/_ensureKernel rebuild AT the preserved
  // address via the override instead of the (now-divergent) counterfactual. It is a
  // MAP (not a single `{pod,kernel}`) so recovering MULTIPLE accounts on one device
  // doesn't let a later recovery clobber an earlier one's binding — which would send
  // the earlier account's next login to a fresh counterfactual address ("the account
  // address changed"). Persists across logout so re-login works.
  // Legacy single-object blobs are migrated to the map shape on first read.
  RECOVERED_KERNEL_BINDING: "woco:auth:recovered-kernel",
  PASSKEY_CREDENTIAL: "woco:auth:passkey-credential",
  // RETIRED (#501): the sub-ENS `registerWithPermit` session key's slot. Nothing
  // writes it any more — every name is minted by the WoCo sponsor wallet — but
  // devices that used the gasless rail still hold a serialized permission
  // account here, so logout keeps DELETING this key. Do not reuse the name for
  // anything else: an old blob would then be read as the new thing.
  WOCO_AA_SESSION: "woco:auth:aa-session:v3",
  // ZeroDev on-chain session key for EAS likes/following: the scoped, serialized
  // permission account (contains the session private key) encrypted at rest, and
  // scoped to EAS attest/revoke by selector only — no nested-tuple ABI in
  // enable-data, which is what broke paymaster gas estimation when these
  // permissions shared a key with the sub-ENS mint. DISTINCT from SESSION_KEY,
  // which is the EIP-712 HTTP session-delegation key — two unrelated "session"
  // concepts (see ZERODEV_PASSKEY_INTEGRATION_PLAN.md).
  WOCO_AA_EAS_SESSION: "woco:auth:aa-eas-session:v1",
  // LEGACY, swept on logout, never written. Both date from when the content-feed
  // signer was an INDEPENDENT secret: an encrypted key blob established once per
  // account and escrowed (…_KEY), plus a cleartext cache of its address so passive
  // self-reads did not have to re-derive it (…_ADDRESS). The signer is now an HKDF
  // sibling of the identity seed (crypto/feed-signer.ts), so the seed's own slot is
  // the single durable secret and the address is computed on demand. Kept only so
  // `clearAllAuth` can drop what older builds left behind.
  CONTENT_FEED_SIGNER_ADDRESS: "woco:auth:content-feed-signer",
  CONTENT_FEED_SIGNER_KEY: "woco:auth:content-feed-signer-key",
} as const;

/** Fixed salt input for passkey PRF → secp256k1 key derivation */
export const PASSKEY_PRF_SALT_INPUT = "woco-passkey-secp256k1-v1";

/** Fixed nonce for the account-keys derivation. FROZEN with the rest of the
 *  signed message — see ACCOUNT_KEYS_DOMAIN in eip712.ts for what changing it
 *  costs. (Renamed from POD_IDENTITY_NONCE / "WOCO-POD-IDENTITY-V1" on
 *  2026-09-10; the rename is the byte change made visible.) */
export const ACCOUNT_KEYS_NONCE = "WOCO-ACCOUNT-KEYS-V1";

/** Fixed nonce for deterministic guardian recovery-escrow X25519 key derivation */
export const RECOVERY_ENC_NONCE = "WOCO-RECOVERY-ENC-V1";

/** Session delegation expiry duration (30 days in ms) */
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Session delegation purpose string */
export const SESSION_PURPOSE = "session";

/** Maximum age for a passkey / wallet-signed claim signature (5 minutes) */
export const PASSKEY_CLAIM_MAX_AGE_MS = 300_000;
