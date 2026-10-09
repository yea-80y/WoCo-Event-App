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
  IDENTITY_SEED: "woco:auth:identity-seed",
  // PRF-EOA address used as the seed derivation/AAD key for passkey logins.
  // The Kernel smart-account address is the parent; the seed must stay on the raw
  // PRF-EOA address (invariant #1) so it survives the future Option 2 swap.
  SEED_ADDRESS: "woco:auth:seed-address",
  // A passkey account's seed, locked under a key from its PRF output (#746 fix 1):
  // per seed address, opens only with that passkey. Survives sign-out.
  IDENTITY_SEED_LOCKED: "woco:auth:identity-seed-locked",
  // PUBLIC values derived from a locked seed `{ parent, feedSignerAddress }`, per
  // seed address, so own-profile reads work while the seed is locked.
  PUBLIC_KEYS: "woco:auth:public-keys",
  // The unlock window (#746): a passkey seed copy under the device key that opens
  // without the passkey until its `expiresAt`. Per seed address; never the only copy.
  IDENTITY_SEED_WINDOW: "woco:auth:identity-seed-window",
  // A passkey account's content-feed signer key under the device key, per seed
  // address (#746): everyday posts sign with it while the seed is locked. An HKDF
  // child of the seed, so it opens neither the seed nor the attendee-data key.
  FEED_SIGNER_CACHE: "woco:auth:feed-signer-cache",
  // A passkey account's LATER account secrets (#186): generations 1..g, which a key
  // ring handed this passkey after a passkey was removed. Locked like the seed (same
  // PRF-derived key, its own AAD), per seed address; survives sign-out.
  ACCOUNT_CHAIN_LOCKED: "woco:auth:account-chain-locked",
  // Their unlock-window copy under the device key, beside the seed's (#186).
  ACCOUNT_CHAIN_WINDOW: "woco:auth:account-chain-window",
  // Durable RECOVERED-account bindings: a MAP `{ [prfEoaLower]: kernelAddress }`.
  // After recovery the Kernel's sudo owner is rotated but its address is PRESERVED,
  // so the rotated passkey's counterfactual CREATE2 address no longer equals the
  // account address. Each entry records "the passkey whose PRF-EOA = key controls
  // the Kernel at value" so loginPasskey/_ensureKernel rebuild AT the preserved
  // address via the override instead of the (now-divergent) counterfactual. It is a
  // MAP (not a single `{seedAddress,kernel}`) so recovering MULTIPLE accounts on one device
  // doesn't let a later recovery clobber an earlier one's binding — which would send
  // the earlier account's next login to a fresh counterfactual address ("the account
  // address changed"). Persists across logout so re-login works.
  // Legacy single-object blobs are migrated to the map shape on first read.
  RECOVERED_KERNEL_BINDING: "woco:auth:recovered-kernel",
  // ADDED-passkey bindings (#746 step 3): a MAP `{ [prfEoaLower]: kernelAddress }`,
  // "this passkey is a device of the Kernel at value" - written when the server
  // accepted the passkey's session as a device, or could not be reached (the first
  // request then says). Separate from the recovered
  // map because the chain names someone else as owner here BY DESIGN, so the
  // recovered paths' owner checks would refuse it as an orphan. Like it: the
  // Kernel override, and never a seed derived from this passkey.
  DEVICE_KERNEL_BINDING: "woco:auth:device-kernel",
  PASSKEY_CREDENTIAL: "woco:auth:passkey-credential",
  // RETIRED (#501): the sub-ENS `registerWithPermit` session key's slot. Nothing
  // writes it any more — every name is minted by the WoCo sponsor wallet — but
  // devices that used the gasless rail still hold a serialized permission
  // account here, so logout keeps DELETING this key. Do not reuse the name for
  // anything else: an old blob would then be read as the new thing.
  WOCO_AA_SESSION: "woco:auth:aa-session:v3",
  // The referral campaign's scoped on-chain session key had a slot here until
  // the EAS rail was deleted (#476). Unlike WOCO_AA_SESSION above, the name is
  // dropped outright rather than kept for the logout sweep: pre-launch, the only
  // devices holding a blob under it are ours, so the orphaned IndexedDB entry
  // costs a few hundred bytes and nothing else. Do not revive the name.

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

/**
 * Fixed salt input for the passkey PRF evaluation. FROZEN twice over: its output is
 * the root of the Kernel owner key AND (since #642) of the passkey account's identity
 * seed and portability keys (crypto/passkey-prf.ts). The "secp256k1" in the string is
 * history, not a description — do not "correct" it.
 */
export const PASSKEY_PRF_SALT_INPUT = "woco-passkey-secp256k1-v1";

/** Fixed nonce for the account-keys derivation. FROZEN with the rest of the
 *  signed message — see ACCOUNT_KEYS_DOMAIN in eip712.ts for what changing it
 *  costs. (Both the constant and its value were renamed off the retired
 *  identity nonce on 2026-09-10; the rename is that byte change made visible.) */
export const ACCOUNT_KEYS_NONCE = "WOCO-ACCOUNT-KEYS-V1";

/** Fixed nonce for the deterministic guardian recovery-escrow key derivation (wallet
 *  and email guardians; a passkey guardian derives from its PRF output, #642) */
export const RECOVERY_ENC_NONCE = "WOCO-RECOVERY-ENC-V1";

/** Session delegation expiry duration (30 days in ms) */
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Session delegation purpose string */
export const SESSION_PURPOSE = "session";

/** Maximum age for a passkey / wallet-signed claim signature (5 minutes) */
export const PASSKEY_CLAIM_MAX_AGE_MS = 300_000;
