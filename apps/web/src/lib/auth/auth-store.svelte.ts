import {
  type AuthKind,
  type EIP712Signer,
  StorageKeys,
  type SessionDelegation,
  FEED_SIGNER_DERIVE_DOMAIN,
  FEED_SIGNER_DERIVE_TYPES,
  FEED_SIGNER_DERIVE_NONCE,
} from "@woco/shared";
import { getKV, putKV, delKV } from "./storage/indexeddb.js";
import {
  requestSessionDelegation,
  restoreSession,
  signWithSession,
  getSessionDelegation,
  clearSession,
} from "./session-delegation.js";
import {
  requestPodIdentity,
  restorePodSeed,
  storePodSeed,
  getPodKeypair,
  clearPodIdentity,
} from "./pod-identity.js";
import {
  connectWallet,
  getConnectedAddress,
  onAccountsChanged,
} from "../wallet/connection.js";
import {
  createLocalAccount,
  restoreLocalAccount,
  clearLocalAccount,
} from "./local-account.js";
import {
  authenticatePasskey,
  restorePasskeyAccount,
  createPasskeyAccount,
  hasStoredPasskeyCredential,
} from "./passkey-account.js";
import { createWeb3Signer, createLocalSigner, createPasskeySigner } from "./signers/index.js";
import type { BuiltKernel } from "./kernel-account.js";
import type { ContentFeedSigner } from "../swarm/content-feed.js";
import { signingRequest } from "./signing-request.svelte.js";
import { cacheClearByPrefix, USER_SCOPED_PREFIXES } from "../cache/cache.js";

// ---------------------------------------------------------------------------
// State (Svelte 5 runes)
// ---------------------------------------------------------------------------

let _kind = $state<AuthKind>("none");
let _parent = $state<string | null>(null);
let _sessionAddress = $state<string | null>(null);
let _podPublicKeyHex = $state<string | null>(null);
let _ready = $state(false);
let _busy = $state(false);

// In-memory only — never exposed reactively
let _localPrivateKey: string | null = null;
let _passkeyPrivateKey: string | null = null;
let _web3authPrivateKey: string | null = null;

// ZeroDev Kernel logins (passkey + web3auth). The Kernel smart-account address
// is the parent identity; POD identity stays on the raw signer key + its EOA
// address (invariant #1 — deterministic, wallet-independent).
//  - _podAddress: passkey PRF-EOA address — POD EIP-712 address field + AAD.
//  - _web3authPodAddress: Web3Auth EOA address — the web3auth POD address + AAD
//    (the Kernel parent is NOT the POD key; same invariant #1 as passkey).
//  - _kernel: the built Kernel (account + client + sudo validator), cached in
//    memory after the first key ceremony of a session. Never persisted.
let _podAddress: string | null = null;
let _web3authPodAddress: string | null = null;
let _kernel: BuiltKernel | null = null;

// Cleanup function for wallet event listeners
let _cleanupAccountListener: (() => void) | null = null;

// In-flight singletons — coalesce concurrent ensureSession/ensurePodIdentity
// calls so parallel authGets after login don't each trigger their own EIP-712
// prompt. First caller signs; the rest await the same promise.
let _sessionInFlight: Promise<boolean> | null = null;
let _podInFlight: Promise<string | null> | null = null;
let _feedSignerInFlight: Promise<ContentFeedSigner | null> | null = null;

// In-memory memo of the feed-signer ADDRESS for passive self-reads, always
// validated against the CURRENT parent before use. Never persisted: the only
// durable copy of signer material is the AAD-bound encrypted key blob
// (feed-signer-store), so there is no unauthenticated record that could survive
// an account switch and leak the previous user's signer into this one's reads.
let _feedSignerAddressMemo: { parent: string; address: string } | null = null;

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

const hasSession = $derived(_sessionAddress !== null);
const hasPodIdentity = $derived(_podPublicKeyHex !== null);
const isConnected = $derived(_kind !== "none" && _parent !== null);
const isAuthenticated = $derived(isConnected && hasSession);

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Get the right EIP712Signer based on the current auth kind.
 */
async function _getSigner(): Promise<EIP712Signer> {
  if (_kind === "web3" && _parent) {
    return createWeb3Signer(_parent);
  }
  if (_kind === "local" && _localPrivateKey) {
    return createLocalSigner(_localPrivateKey, (info) =>
      signingRequest.request(info),
    );
  }
  if (_kind === "passkey") {
    // Passkey parent stays the ZeroDev Kernel (identity/EAS attester), but
    // AuthorizeSession is signed by the RAW PRF-EOA key — ecrecover-able, so
    // the server verifies it RPC-free and authorizes by owner-of-Kernel
    // (kernel-owner.ts). Replaces Kernel ERC-1271, which needed deployed +
    // owner==live-key + working RPC and 403-wedged recovered/rotated accounts
    // (2026-07 split-brain fix). Silent (no confirm dialog) like the Kernel
    // signer it replaces. POD uses _getPodSigner() instead (invariant #1).
    await _ensurePasskeyKey();
    if (!_passkeyPrivateKey) throw new Error("Passkey key unavailable for signer");
    return createLocalSigner(_passkeyPrivateKey, async () => true);
  }
  if (_kind === "web3auth") {
    // web3auth parent is the Kernel too; AuthorizeSession is signed by the raw
    // Web3Auth EOA key (same owner-of-Kernel server authorization as passkey).
    if (!_web3authPrivateKey) throw new Error("Web3Auth key unavailable for signer");
    return createLocalSigner(_web3authPrivateKey, async () => true);
  }
  if (_kind === "coinbase" && _parent) {
    const { createCoinbaseSigner } = await import("./signers/coinbase-signer.js");
    return createCoinbaseSigner(_parent);
  }
  throw new Error("No signer available for auth kind: " + _kind);
}

/**
 * Signer used ONLY for POD identity derivation.
 *
 * INVARIANT #1: POD must be derived from a DETERMINISTIC signature. For passkey
 * logins that is the raw PRF-EOA secp256k1 key (ethers Wallet → RFC-6979), NOT
 * the Kernel (smart-account 1271 signatures are non-deterministic and would
 * corrupt the user's encryption + ticket-signing identity). For every other
 * kind the POD signer is the same as the request signer.
 */
async function _getPodSigner(): Promise<EIP712Signer> {
  if (_kind === "passkey") {
    await _ensurePasskeyKey();
    if (!_passkeyPrivateKey) throw new Error("Passkey key unavailable for POD signer");
    return createPasskeySigner(_passkeyPrivateKey, (info) =>
      signingRequest.request(info),
    );
  }
  if (_kind === "web3auth") {
    // INVARIANT #1: POD derives from the raw Web3Auth secp256k1 key (ethers
    // Wallet → RFC-6979 deterministic), NOT the Kernel (`_getSigner` returns the
    // non-deterministic 1271 signer, which would corrupt the ed25519 identity).
    if (!_web3authPrivateKey) throw new Error("Web3Auth key unavailable for POD signer");
    return createLocalSigner(_web3authPrivateKey, (info) => signingRequest.request(info));
  }
  return _getSigner();
}

/**
 * Address used as the POD EIP-712 `address` field + encryption AAD.
 *
 * INVARIANT #1: passkey POD is keyed by the PRF-EOA address (not the Kernel
 * parent), so the derived ed25519 identity is stable across the Option 2 swap.
 * Kind-aware so a stale passkey `_podAddress` can never leak into another
 * login method after an in-tab account switch.
 */
function _getPodAddress(): string | null {
  if (_kind === "passkey") return _podAddress ?? _parent;
  // web3auth POD is keyed by the Web3Auth EOA, NOT the Kernel parent (invariant
  // #1). `_parent` here is the Kernel address, so it must NEVER be the fallback
  // for a logged-in web3auth user — `_web3authPodAddress` is loaded at login and
  // on restore before this is read.
  if (_kind === "web3auth") return _web3authPodAddress ?? _parent;
  return _parent;
}

/**
 * Establish the user's content-feed signer by SIGN-TO-DERIVE — the single
 * construction for every kind that can own client feeds: keccak256 of a
 * deterministic, domain-separated EIP-712 signature. This is IDENTICAL to how the
 * POD seed is derived (`requestPodIdentity`); only the signed domain differs
 * (`FEED_SIGNER_DERIVE_DOMAIN`, distinct salt), so the feed key and POD key are
 * cryptographically independent.
 *
 * Signs with `_getPodSigner()` — the DETERMINISTIC raw-key/wallet signer (raw PRF
 * key for passkey, raw key for web3auth/local, the wallet for web3), NEVER the
 * Kernel 1271 signer, whose signatures are non-deterministic and would orphan the
 * feed across devices.
 *
 * DETERMINISM: raw-key kinds sign via ethers → RFC-6979, deterministic by
 * construction. External wallets (web3) are not under our control, so we sign
 * TWICE and THROW on mismatch — a non-deterministic wallet would make the feed
 * unrecoverable on the next device. Content is NEVER platform-signed as a
 * consolation: a failure here aborts the publish with a clear error instead.
 */
async function _deriveFeedSignerBySigning(parent: string): Promise<ContentFeedSigner> {
  // For kinds whose raw key is already in memory (web3auth, local), the feed-signer
  // derivation is an INTERNAL key-stretch — ethers signs it silently (RFC-6979), so
  // it needs no user confirm dialog. Deriving silently is also what lets us
  // re-establish the signer eagerly on login/restore without popping a prompt on
  // every page load. web3 (external wallet) must sign with the wallet itself (and
  // gets the double-sign determinism check); passkey keeps its own _getPodSigner
  // path (biometric + escrow-backed).
  const silentRawKey =
    _kind === "web3auth" ? _web3authPrivateKey : _kind === "local" ? _localPrivateKey : null;
  const signer712 = silentRawKey
    ? createLocalSigner(silentRawKey, async () => true)
    : await _getPodSigner();
  const message = {
    purpose: "Set up your WoCo content-feed signing key",
    address: parent,
    nonce: FEED_SIGNER_DERIVE_NONCE,
  };
  const sign = () =>
    signer712(
      { ...FEED_SIGNER_DERIVE_DOMAIN },
      FEED_SIGNER_DERIVE_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      message as unknown as Record<string, unknown>,
    );

  const { deriveContentFeedSignerFromSig } = await import("../swarm/content-feed.js");
  const first = deriveContentFeedSignerFromSig(await sign());
  // Only EXTERNAL wallets need the reproducibility self-check: we don't control
  // their nonce generation. Raw-key kinds sign with ethers (RFC-6979) → already
  // deterministic, so a second prompt would be pure friction.
  if (_kind === "web3") {
    const second = deriveContentFeedSignerFromSig(await sign());
    if (first.address !== second.address) {
      throw new Error(
        "Your wallet's signature isn't reproducible, so we can't create a recoverable feed for your content. Try a different wallet.",
      );
    }
  }
  return first;
}

/**
 * The user's content-feed signer (Phase B), or null when this kind/state can't
 * own client-signed feeds. The address is the SOC owner + the registry value.
 *
 * Concurrent callers coalesce onto one establish ceremony (same pattern as
 * ensureSession/ensurePodIdentity): two parallel first-writes would otherwise
 * each fire a derive, and `signingRequest` auto-rejects an overlapping confirm
 * dialog — which surfaces as a signer failure with no visible prompt.
 */
async function _getContentFeedSigner(): Promise<ContentFeedSigner | null> {
  if (_feedSignerInFlight) return _feedSignerInFlight;
  const inFlight = _getContentFeedSignerInner().finally(() => {
    _feedSignerInFlight = null;
  });
  _feedSignerInFlight = inFlight;
  return inFlight;
}

async function _getContentFeedSignerInner(): Promise<ContentFeedSigner | null> {
  const parent = _parent;
  const { contentFeedSignerFromPrivKey } = await import("../swarm/content-feed.js");

  // (1) An established key wins: the feed signer is a STORED secret (escrowed for
  // recovery on kinds whose credential rotates), never re-derived once set — a
  // rotated passkey credential would derive a divergent key and orphan the user's
  // feeds (CROSS_DEVICE_RECOVERY §4).
  if (parent) {
    const { restoreContentFeedSigner } = await import("./feed-signer-store.js");
    const stored = await restoreContentFeedSigner(parent);
    if (stored) {
      const signer = contentFeedSignerFromPrivKey(stored);
      _feedSignerAddressMemo = { parent: parent.toLowerCase(), address: signer.address };
      return signer;
    }
  }

  // (2) No stored key yet → establish one by SIGN-TO-DERIVE, the single
  // construction for every kind that can own client feeds (web3, web3auth, local,
  // passkey), then PERSIST it; from here the stored key wins. On passkey it is
  // additionally escrowed in the guardian bundle at publish time (recovery-escrow).
  // FAIL-LOUD: these kinds MUST own client-signed content, so any failure THROWS
  // (a non-deterministic wallet self-check, a missing key) — we NEVER fall through
  // to a platform signer, which would silently split the user's feeds.
  if (parent && (_kind === "web3" || _kind === "web3auth" || _kind === "local" || _kind === "passkey")) {
    // Anti-divergence guard: a RECOVERED passkey's PRF credential has ROTATED, so
    // sign-to-derive here would produce a DIFFERENT key than the one that owns the
    // account's existing feeds — silently forking them. Its real signer only comes
    // from escrow/portability restore (done at login). Reaching here means that
    // restore didn't happen, so FAIL LOUD rather than fork. Non-recovered passkeys
    // (no binding) derive deterministically and are unaffected.
    if (_kind === "passkey" && (await _recoveryKernelFor(_podAddress))) {
      throw new Error(
        "Recovered passkey feed signer unavailable — restore from recovery escrow required; refusing to derive a divergent key.",
      );
    }
    const signer = await _deriveFeedSignerBySigning(parent);
    const { storeContentFeedSigner } = await import("./feed-signer-store.js");
    await storeContentFeedSigner(parent, signer.privKey);
    _feedSignerAddressMemo = { parent: parent.toLowerCase(), address: signer.address };
    return signer;
  }

  // (3) Coinbase Smart Wallet: 1271/6492 signatures are non-deterministic, so it
  // cannot sign-to-derive — client feeds are PARKED for CSW (random key + escrow,
  // post-launch). Null here is the legacy platform-signed path, the ONLY remaining
  // such exception.
  return null;
}

/**
 * Eagerly (re-)establish the content-feed signer for kinds that can derive it
 * SILENTLY from an in-memory raw key (web3auth, local). This is what makes client
 * feeds actually work across sessions and devices for these kinds:
 *   - logout wipes the on-device signer blob (shared-device hygiene), so a plain
 *     re-login would leave passive reads (avatar/profile) with no signer to resolve
 *     → they'd fall back to the empty legacy feed and show blank;
 *   - a COLD device has never stored it at all.
 * Because the derivation is deterministic (Web3Auth/local key × fixed domain), every
 * session and device re-derives the SAME signer → the same SOCs → the user sees
 * their own content. Runs after the raw key is in memory; silent (no dialog) and
 * NON-FATAL — a failure here must not block login/restore, it just defers to the
 * lazy establish on first write. No-op for web3 (wallet re-sign, would prompt),
 * passkey (biometric + escrow), and CSW (parked).
 */
async function _establishFeedSignerEagerly(): Promise<void> {
  if (_kind !== "web3auth" && _kind !== "local") return;
  try {
    await _getContentFeedSigner();
  } catch (e) {
    console.warn("[auth] eager feed-signer establishment failed (non-fatal):", e);
  }
}

/**
 * The user's content-feed signer ADDRESS for self-reads, resolved WITHOUT a
 * prompt. Under the unified sign-to-derive construction the address can only be
 * computed from a signature (which prompts), so passive callers resolve it from
 * the STORED feed-signer key (a device-key decrypt, never a PRF/wallet prompt).
 * That blob is the SINGLE durable source of truth: AES-GCM AAD-bound to the
 * parent, so it cryptographically cannot resolve for the wrong identity — unlike
 * a plaintext address cache, which once leaked a previous account's signer into
 * the next login's self-reads. A parent-validated in-memory memo skips the
 * decrypt on repeat calls. Returns null for CSW (no client feed — parked) or when
 * the user has never established a feed signer on this device (no self-owned feed
 * to read yet). Never signs — safe to call from passive UI (e.g. rendering your
 * own avatar).
 */
async function _getContentFeedSignerAddress(): Promise<string | null> {
  if (_kind === "coinbase") return null;
  const parent = _parent?.toLowerCase();
  if (!parent) return null;
  if (_feedSignerAddressMemo?.parent === parent) return _feedSignerAddressMemo.address;

  // An established secret may already be stored for this parent (derived here on
  // a prior session, or escrow/portability-restored on a recovered device).
  // Recover its address from the stored key so a fresh session that hasn't
  // published yet still resolves the user's own feeds (e.g. their avatar)
  // instead of falling back to the legacy platform feed.
  const { restoreContentFeedSigner } = await import("./feed-signer-store.js");
  const stored = await restoreContentFeedSigner(parent);
  if (stored) {
    const { contentFeedSignerFromPrivKey } = await import("../swarm/content-feed.js");
    const address = contentFeedSignerFromPrivKey(stored).address;
    _feedSignerAddressMemo = { parent, address };
    return address;
  }

  // No stored key yet, but for kinds whose feed signer is SILENTLY derivable from
  // an in-memory raw key (web3auth, local) we ESTABLISH it on demand rather than
  // returning null. This closes the cold-restore race: `init()` flips isConnected
  // true (→ ProfilePage re-reads) the instant _kind/_parent are set, BEFORE the
  // awaited eager establishment has persisted the signer. A null here would make
  // the self-read fall back to the empty legacy feed AND cache that blank for 5min
  // (profiles.ts) — the exact cold-device symptom. Establishing coalesces onto the
  // in-flight eager ceremony (_getContentFeedSigner) and pops NO dialog (ethers
  // RFC-6979 over the in-memory key). Gated on the raw key actually being in memory
  // so we never take the wrong (POD/passkey-prompt) derive path. Other kinds
  // (passkey/web3) require a prompt to derive and MUST stay prompt-free here, so
  // they return null and defer to lazy establish on first write.
  const silentRawKey =
    _kind === "web3auth" ? _web3authPrivateKey : _kind === "local" ? _localPrivateKey : null;
  if (silentRawKey) {
    const signer = await _getContentFeedSigner().catch(() => null);
    return signer?.address ?? null;
  }
  return null;
}

/**
 * The user's configured recovery backups from their encrypted-to-self manifest
 * (Increment 3a) — the LOGGED-IN comfort layer that lets the "Protect your
 * account" panel show what's already set up. Prompt-free: both the SOC owner
 * address and the seal key come from the STORED feed-signer blob (a device-key
 * decrypt, never a PRF/wallet signature), so passive UI can call it freely.
 * Returns [] when not signed in, no feed signer established, or no manifest yet.
 */
async function getBackupInventory(): Promise<import("@woco/shared").BackupInventoryEntry[]> {
  const parent = _parent;
  if (!parent) return [];
  const address = await _getContentFeedSignerAddress();
  if (!address) return [];
  const { restoreContentFeedSigner } = await import("./feed-signer-store.js");
  const privKey = await restoreContentFeedSigner(parent);
  if (!privKey) return [];
  try {
    const { readBackupInventory } = await import("../manifest/inventory.js");
    return await readBackupInventory({ signer: { privKey, address }, parentAddress: parent });
  } catch {
    return [];
  }
}

/**
 * Restore cached session + POD from IndexedDB (shared by all login methods).
 * Passes the current `_parent` as the expected parent so a stale delegation
 * from a different identity can never be silently re-attached.
 */
async function _restoreCachedAuth(): Promise<void> {
  if (!_parent) return;
  const session = await restoreSession(_parent);
  if (session) {
    _sessionAddress = session.sessionWallet.address;
  }

  // POD is keyed by the PRF-EOA address for passkey (invariant #1), the parent
  // for everyone else. restorePodSeed deletes the blob on an AAD mismatch, so
  // it must never be called with the Kernel address for a passkey user — the
  // PRF-EOA address is loaded from storage in init() before this runs.
  const podAddr = _getPodAddress();
  if (podAddr) {
    const seed = await restorePodSeed(podAddr);
    if (seed) {
      const kp = await getPodKeypair(podAddr);
      _podPublicKeyHex = kp?.publicKeyHex ?? null;
    }
  }
}

/**
 * If the prior `PARENT_ADDRESS` in storage differs from `address`, wipe the
 * cached SESSION before adopting the new account — the session key + delegation
 * are still single-slot, so without this a delegation signed by the previous
 * wallet would be misattributed to the newly-logged-in identity (cross-identity
 * leak). The POD seed + feed signer are now per-account keyed (podSeedKey /
 * feedSignerKey) AND AAD-bound, so they cannot be misattributed and are left in
 * place so a switch back to the prior account restores instantly; each account's
 * blobs are wiped on ITS OWN logout (clearAllAuth). Only the in-memory feed-signer
 * memo must be reset, since it's keyed by the outgoing parent.
 */
async function _clearStaleAuthForSwitch(address: string): Promise<void> {
  const priorParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
  if (priorParent && priorParent.toLowerCase() !== address.toLowerCase()) {
    await clearSession();
    _feedSignerAddressMemo = null;
  }
}

/**
 * Re-derive the raw PRF key + PRF-EOA address via a biometric prompt (if not
 * already in memory). This is the deterministic POD key source (invariant #1)
 * and the Kernel's sudo signer source — it never builds the Kernel itself.
 */
async function _ensurePasskeyKey(): Promise<void> {
  if (_passkeyPrivateKey && _podAddress) return;
  const result = await restorePasskeyAccount();
  _passkeyPrivateKey = result.privateKey;
  _podAddress = result.address; // PRF-EOA address — POD derivation/AAD key
}

/**
 * Recovered-account bindings, as a MAP `{ [prfEoaLower]: kernelAddress }`
 * (see StorageKeys.RECOVERED_KERNEL_BINDING). Each entry means: this device
 * recovered an account whose Kernel address is PRESERVED while its sudo owner was
 * rotated to the passkey whose PRF-EOA is the key. Migrates a legacy single-object
 * `{pod,kernel}` blob to the map shape transparently.
 */
type RecoveryBindings = Record<string, string>;
async function _getRecoveryBindings(): Promise<RecoveryBindings> {
  const raw = await getKV<RecoveryBindings | { pod: string; kernel: string }>(
    StorageKeys.RECOVERED_KERNEL_BINDING,
  );
  if (!raw) return {};
  // Legacy single-object shape → map (one-time transparent migration).
  if (typeof (raw as { pod?: unknown }).pod === "string") {
    const legacy = raw as { pod: string; kernel: string };
    return { [legacy.pod.toLowerCase()]: legacy.kernel };
  }
  return raw as RecoveryBindings;
}

/**
 * The preserved Kernel address bound to the passkey whose PRF-EOA is `podAddress`,
 * or undefined if this device holds no recovery binding for it. Callers use it as
 * the CREATE2 override so a recovered account rebuilds at its real (preserved)
 * address instead of the rotated credential's divergent counterfactual.
 */
async function _recoveryKernelFor(podAddress: string | null): Promise<`0x${string}` | undefined> {
  if (!podAddress) return undefined;
  const kernel = (await _getRecoveryBindings())[podAddress.toLowerCase()];
  return kernel ? (kernel as `0x${string}`) : undefined;
}

/** Upsert the binding for one passkey (never clobbers other accounts' bindings). */
async function _putRecoveryBinding(podAddress: string, kernel: string): Promise<void> {
  const bindings = await _getRecoveryBindings();
  bindings[podAddress.toLowerCase()] = kernel;
  await putKV(StorageKeys.RECOVERED_KERNEL_BINDING, bindings);
}

/** Drop only THIS passkey's binding (e.g. proven stale on-chain), keep the rest. */
async function _deleteRecoveryBinding(podAddress: string): Promise<void> {
  const bindings = await _getRecoveryBindings();
  if (podAddress.toLowerCase() in bindings) {
    delete bindings[podAddress.toLowerCase()];
    await putKV(StorageKeys.RECOVERED_KERNEL_BINDING, bindings);
  }
}

/**
 * NEW-DEVICE recovered-passkey check (CROSS_DEVICE_RECOVERY.md §3). When a passkey
 * logs in with NO local recovery binding, it could still be a recovered account
 * being opened on a second device. Read the PRF-sealed portability envelope, then
 * VERIFY ON-CHAIN that the preserved Kernel's current ECDSA owner equals this
 * device's PRF-EOA before trusting it — the chain, not the blob, is the authority.
 *
 * Pure check: returns `{ preserved, podSeed }` to apply, or null. The caller does
 * the storage writes (storePodSeed + binding) AFTER `_clearStaleAuthForSwitch`,
 * which would otherwise wipe a freshly-stored seed. The read is unauthenticated,
 * so this works during login before any session exists.
 */
async function _verifyPortabilityEnvelope(
  passkeyPrivKey: string,
  podAddress: string,
): Promise<{ preserved: `0x${string}`; podSeed: string; feedSignerPrivKey?: string } | null> {
  try {
    const { readPortabilityEnvelope } = await import("./recovery-portability.js");
    const opened = await readPortabilityEnvelope({ passkeyPrivKey });
    if (!opened) return null;

    // Trust backstop: the override is applied ONLY if the deployed Kernel at the
    // claimed address currently has THIS PRF-EOA as its ECDSA sudo owner. A
    // stale/forged envelope pointing elsewhere fails here and is discarded.
    const { readKernelEcdsaOwner } = await import("./kernel-account.js");
    const owner = await readKernelEcdsaOwner(opened.preservedKernelAddress);
    if (!owner || owner.toLowerCase() !== podAddress.toLowerCase()) {
      console.warn("[auth] portability envelope failed on-chain owner check — ignoring");
      return null;
    }
    return {
      preserved: opened.preservedKernelAddress as `0x${string}`,
      podSeed: opened.podSeed,
      feedSignerPrivKey: opened.feedSignerPrivKey,
    };
  } catch (e) {
    console.warn("[auth] portability envelope check failed (non-fatal):", e);
    return null;
  }
}

/**
 * Best-effort write of the cross-device portability envelope for the CURRENT
 * recovered passkey account. Fire-and-forget from `ensureSession` (needs a
 * session for the authenticated SOC stamp): the first authenticated action after
 * a recovery — or after this code ships, for an already-recovered Account #2 —
 * persists the envelope so the account becomes portable to future devices. Once
 * written it self-skips (the SOC already exists), so this runs at most once per
 * account. No-op for non-recovered accounts (no local binding).
 */
async function _maybeBackfillPortabilityEnvelope(): Promise<void> {
  try {
    if (_kind !== "passkey" || !_passkeyPrivateKey || !_podAddress) return;
    const override = await _recoveryKernelFor(_podAddress);
    if (!override) return; // only recovered accounts carry a binding

    const { derivePortabilityKeys, writePortabilityEnvelope } = await import("./recovery-portability.js");
    const { readSoc } = await import("../swarm/client-soc.js");
    const { portabilitySocIdentifier } = await import("@woco/shared");

    const keys = await derivePortabilityKeys(_passkeyPrivateKey);
    const existing = await readSoc(keys.socOwnerAddress, portabilitySocIdentifier());
    if (existing) return; // already portable

    const seed = await restorePodSeed(_podAddress);
    if (!seed) return;
    // Carry the feed signer too, so a recovered account's FURTHER devices restore
    // it (same role the guardian escrow plays on the recovery device itself).
    const feedSigner = await _getContentFeedSigner();
    await writePortabilityEnvelope({
      passkeyPrivKey: _passkeyPrivateKey,
      preservedKernelAddress: override,
      podSeed: seed,
      feedSignerPrivKey: feedSigner?.privKey,
    });
    console.log("[auth] wrote cross-device recovery portability envelope");
  } catch (e) {
    console.warn("[auth] portability envelope back-fill failed (non-fatal):", e);
  }
}

/**
 * Ensure the ZeroDev Kernel is built and cached in memory. Triggers one PRF
 * ceremony (via _ensurePasskeyKey) on first use of a session, then builds the
 * Kernel from the raw PRF key. The Kernel address is deterministic (CREATE2),
 * so we assert it matches the stored parent — refusing to attach a divergent
 * smart account that would break the user's on-chain + auth identity.
 *
 * EXCEPTION — recovered accounts: the address is preserved while the owner was
 * rotated, so the counterfactual address legitimately diverges. A durable
 * binding (written at recovery, keyed to this PRF-EOA) tells us to rebuild AT
 * the preserved address via the override; the assertion below still holds (the
 * override == the stored parent), so a wrong passkey is still caught.
 */
async function _ensureKernel(): Promise<void> {
  await _ensurePasskeyKey();
  if (_kernel) return;
  if (!_passkeyPrivateKey) throw new Error("Passkey key unavailable — cannot build Kernel");
  const { buildKernelFromPrivateKey } = await import("./kernel-account.js");
  const override = await _recoveryKernelFor(_podAddress);
  const kernel = await buildKernelFromPrivateKey(
    _passkeyPrivateKey,
    override ? { address: override } : undefined,
  );
  if (_parent && kernel.address !== _parent.toLowerCase()) {
    throw new Error(
      "Kernel address mismatch on restore — refusing to attach a divergent smart account.",
    );
  }
  _kernel = kernel;
}

/**
 * Build + cache the ZeroDev Kernel for a web3auth login. The raw Web3Auth key is
 * already in memory (no biometric/prompt, unlike passkey's PRF ceremony), so this
 * is a pure build. The Kernel address is deterministic from that key; assert it
 * matches the stored parent so a key change (or a stale parent) can never silently
 * attach a divergent smart account.
 *
 * RECOVERED accounts: if this web3auth key is the rotated owner of a recovered
 * account, its Kernel address was PRESERVED (≠ this key's counterfactual) — honour
 * the durable binding (mirrors _ensureKernel) so we rebuild at the real account
 * instead of a fresh counterfactual one. Without the override a recovered web3auth
 * account would throw "address mismatch" on the first reload after the ceremony.
 */
async function _ensureKernelForWeb3Auth(): Promise<void> {
  if (_kernel) return;
  if (!_web3authPrivateKey) throw new Error("Web3Auth key unavailable — cannot build Kernel");
  const { buildKernelFromPrivateKey } = await import("./kernel-account.js");
  const override = await _recoveryKernelFor(_getPodAddress());
  const kernel = await buildKernelFromPrivateKey(
    _web3authPrivateKey,
    override ? { address: override } : undefined,
  );
  if (_parent && kernel.address !== _parent.toLowerCase()) {
    throw new Error(
      "Kernel address mismatch (web3auth) — refusing to attach a divergent smart account.",
    );
  }
  _kernel = kernel;
}

/** Build the Kernel for whichever Kernel-backed kind is active (passkey/web3auth). */
async function _ensureKernelForKind(): Promise<void> {
  if (_kind === "passkey") return _ensureKernel();
  if (_kind === "web3auth") return _ensureKernelForWeb3Auth();
  throw new Error("No Kernel available for auth kind: " + _kind);
}

/**
 * After a transient web3auth restore (`unavailable`), keep re-attempting the SDK
 * init off the critical path until the raw key comes back — in dev the second
 * attempt succeeds once the dep-optimizer settles; in prod a network blip clears.
 * Never clears the session: an `expired` result here just stops the retries and
 * leaves the cached WoCo session in place until a key-requiring action forces a
 * re-login. Backs off 2s → 4s → 8s → 16s (capped), giving up after a few tries.
 */
function _retryWeb3AuthKeyInBackground(attempt = 0): void {
  if (_web3authPrivateKey || _kind !== "web3auth") return;
  setTimeout(async () => {
    if (_web3authPrivateKey || _kind !== "web3auth") return;
    try {
      const { restoreWeb3AuthSession } = await import("./web3auth-account.js");
      const r = await restoreWeb3AuthSession();
      if (r.status === "restored") {
        _web3authPrivateKey = r.privateKey;
        return;
      }
      if (r.status === "expired") return; // genuinely logged out — leave cache as-is
    } catch { /* keep trying */ }
    if (attempt < 4) _retryWeb3AuthKeyInBackground(attempt + 1);
  }, Math.min(2000 * 2 ** attempt, 16000));
}

// ---------------------------------------------------------------------------
// Initialisation (call once on app mount)
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (_ready) return;

  try {
    const kind = await getKV<AuthKind>(StorageKeys.AUTH_KIND);

    if (kind === "web3") {
      // getConnectedAddress() can hang if window.ethereum is injected but broken
      // (e.g. MetaMask inpage.js present but extension unavailable) — cap at 3 s.
      let walletAddr = await Promise.race([
        getConnectedAddress(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);

      // No injected wallet — try to silently restore a WalletConnect session.
      // EthereumProvider.init() can hang on network requests, so cap at 3 s.
      if (!walletAddr && typeof window !== "undefined" && !window.ethereum) {
        const { tryRestoreWalletConnectSession } = await import("../wallet/wc-provider.js");
        walletAddr = await Promise.race([
          tryRestoreWalletConnectSession(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
      }

      if (walletAddr && storedParent && walletAddr === storedParent) {
        // Wallet connected and matches stored parent — full restore
        _kind = "web3";
        _parent = storedParent;
        await _restoreCachedAuth();
        _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);
      } else if (walletAddr && storedParent && walletAddr !== storedParent) {
        // Wallet switched to a different account — clear stale session
        await clearAllAuth();
      } else if (!walletAddr && storedParent) {
        // Wallet not accessible: extension locked, uninstalled, or WC
        // pairing lapsed. The 30-day session key alone MUST NOT grant
        // authenticated access — a locked wallet = logged-out UX.
        // Leave encrypted session + POD seed in IndexedDB untouched so the
        // user gets back in with a single wallet unlock (no EIP-712 re-sign)
        // via loginWeb3(), which restores the cached auth if addresses match.
        _kind = "none";
        _parent = null;
        // Background retry: MetaMask can be slow to inject in a fresh tab
        // (e.g. after Stripe onboarding redirect). Try once more via
        // eth_accounts only — never prompts the user.
        setTimeout(async () => {
          if (_kind !== "none") return; // already reconnected elsewhere
          const addr = await getConnectedAddress();
          if (addr && addr.toLowerCase() === storedParent.toLowerCase()) {
            _kind = "web3";
            _parent = storedParent;
            await _restoreCachedAuth();
            _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);
          }
        }, 2000);
      } else {
        await clearAllAuth();
      }
    } else if (kind === "local") {
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const account = await restoreLocalAccount();

      if (account && storedParent && account.address === storedParent) {
        _kind = "local";
        _parent = storedParent;
        _localPrivateKey = account.privateKey;
        await _restoreCachedAuth();
        await _establishFeedSignerEagerly();
      } else {
        await clearAllAuth();
      }
    } else if (kind === "passkey") {
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const storedPodAddr = await getKV<string>(StorageKeys.POD_ADDRESS);
      const hasCredential = await hasStoredPasskeyCredential();

      if (hasCredential && storedParent && storedPodAddr) {
        // Connected state only — the Kernel (and raw PRF key) stay null until
        // first use; the biometric prompt is deferred to ensureSession /
        // ensurePodIdentity. storedParent = Kernel address; storedPodAddr =
        // PRF-EOA address (loaded BEFORE _restoreCachedAuth so POD restore uses
        // the right AAD and never deletes the seed on a Kernel-address mismatch).
        _kind = "passkey";
        _parent = storedParent;
        _podAddress = storedPodAddr;
        await _restoreCachedAuth();
      } else {
        // Missing POD_ADDRESS = a pre-Kernel-upgrade session (parent was the
        // PRF-EOA, not the Kernel). Force a clean re-login so the parent becomes
        // the Kernel address rather than silently mixing identity layers.
        await clearAllAuth();
      }
    } else if (kind === "web3auth") {
      const { restoreWeb3AuthSession } = await import("./web3auth-account.js");
      const restore = await restoreWeb3AuthSession();
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const storedPodAddr = await getKV<string>(StorageKeys.POD_ADDRESS);

      if (restore.status === "restored" && storedParent && storedPodAddr) {
        // Connected state only — the Kernel is rebuilt lazily on first use
        // (deferred-signing), so no eth_call here. storedParent = Kernel address;
        // storedPodAddr = Web3Auth EOA (loaded BEFORE _restoreCachedAuth so POD
        // restore uses the EOA AAD, never the Kernel address — invariant #1).
        _kind = "web3auth";
        _parent = storedParent;
        _web3authPrivateKey = restore.privateKey;
        _web3authPodAddress = storedPodAddr;
        await _restoreCachedAuth();
        // Re-establish the feed signer on cold-restore too (silent). A refresh
        // keeps the blob, but a device that only ever restored (never logged in on
        // this tab) still needs its signer resolvable for passive profile reads.
        await _establishFeedSignerEagerly();
      } else if (restore.status === "unavailable" && storedParent && storedPodAddr) {
        // Web3Auth SDK couldn't init (dev dep-optimizer 504, or a network blip) —
        // a transient failure, NOT a logout. The WoCo session (session key,
        // delegation, POD seed, feed signer) is fully persisted and independent of
        // the live provider, so stay logged in and reconnect the raw key in the
        // background instead of nuking a valid session on every refresh. Actions
        // that genuinely need the key (Kernel build, session renewal) lazily
        // restore it — or prompt — if the retry hasn't landed yet. Mirrors the
        // web3 "wallet not accessible" background-reconnect above.
        _kind = "web3auth";
        _parent = storedParent;
        _web3authPodAddress = storedPodAddr;
        await _restoreCachedAuth();
        await _establishFeedSignerEagerly().catch(() => {}); // best-effort w/o key
        _retryWeb3AuthKeyInBackground();
      } else {
        // status === "expired" (SDK init OK, session genuinely gone) OR a
        // pre-Kernel-upgrade session (missing POD_ADDRESS — parent was the raw
        // EOA, not the Kernel). Force a clean re-login so the parent becomes the
        // Kernel address rather than silently mixing identity layers (mirrors
        // the passkey pre-Kernel migration guard).
        await clearAllAuth();
      }
    } else if (kind === "coinbase") {
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const { restoreCoinbaseSession } = await import("./coinbase-account.js");
      const session = await restoreCoinbaseSession();
      if (session && storedParent && session.address === storedParent) {
        _kind = "coinbase";
        _parent = storedParent;
        await _restoreCachedAuth();
      } else {
        await clearAllAuth();
      }
    }
  } catch (e) {
    console.error("[auth] init failed:", e);
  } finally {
    _ready = true;
  }
}

// ---------------------------------------------------------------------------
// Login — method-specific (connect/create only, NO EIP-712 popups)
// ---------------------------------------------------------------------------

async function loginWeb3(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    const address = await connectWallet();
    if (!address) return false;

    await _clearStaleAuthForSwitch(address);

    await putKV(StorageKeys.AUTH_KIND, "web3" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "web3";
    _parent = address;
    _localPrivateKey = null;

    // Restore any cached session/POD from a previous login with the same
    // parent. When unlocking MetaMask after init() skipped the session-only
    // path, this is the rehydration point — no EIP-712 re-prompt needed.
    await _restoreCachedAuth();

    // Listen for account changes
    _cleanupAccountListener?.();
    _cleanupAccountListener = onAccountsChanged(handleAccountsChanged);

    return true;
  } catch (e) {
    console.error("[auth] web3 login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

async function loginLocal(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    // Try to restore existing local account, or create a new one
    let account = await restoreLocalAccount();
    if (!account) {
      account = await createLocalAccount();
    }

    await _clearStaleAuthForSwitch(account.address);

    await putKV(StorageKeys.AUTH_KIND, "local" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, account.address);
    _kind = "local";
    _parent = account.address;
    _localPrivateKey = account.privateKey;

    // Restore any cached session/POD from a previous login
    await _restoreCachedAuth();
    await _establishFeedSignerEagerly();

    // No account change listener needed for local accounts
    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] local login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

/**
 * Open the Web3Auth PnP modal (email / social login). Extracts the raw key
 * client-side and keeps it in memory as the session signer — same pattern as
 * local account but sourced from Web3Auth's MPC reconstruction instead of
 * IndexedDB. Web3Auth's stored session enables silent restore on page reload.
 */
async function loginWeb3Auth(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    const { loginWithWeb3Auth } = await import("./web3auth-account.js");
    const { address, privateKey } = await loginWithWeb3Auth();

    // Kernelize: build the ZeroDev Kernel from the raw Web3Auth key. The Kernel
    // address (not the EOA) becomes the parent identity, so email users get the
    // gasless on-chain rails (likes/follows) — `attester == parent` holds because
    // the Kernel is msg.sender. POD stays on the raw EOA key (invariant #1).
    //
    // If this web3auth key is the rotated owner of a RECOVERED account, its Kernel
    // address was preserved (≠ this key's counterfactual) — honour the durable
    // binding (mirrors loginPasskey) so an explicit re-login lands on the real
    // account, not a fresh counterfactual one. (No portability-envelope path here:
    // that channel is PRF-sealed and passkey-only; a web3auth account re-opened on a
    // NEW device recovers by re-running the portal.)
    const { buildKernelFromPrivateKey, readKernelEcdsaOwner } = await import("./kernel-account.js");
    let override = await _recoveryKernelFor(address);
    if (override) {
      // Stale-binding guard: only trust the local binding if the preserved Kernel
      // still has THIS EOA as its on-chain ECDSA owner (mirror loginPasskey) —
      // otherwise a never-confirmed recovery tx would lock the user out.
      const onChainOwner = await readKernelEcdsaOwner(override);
      if (onChainOwner !== null && onChainOwner.toLowerCase() !== address.toLowerCase()) {
        console.warn("[auth] local recovery binding stale (web3auth) — on-chain owner is", onChainOwner, "not", address, "— clearing");
        await _deleteRecoveryBinding(address);
        override = undefined;
      }
    }
    const kernel = await buildKernelFromPrivateKey(
      privateKey,
      override ? { address: override } : undefined,
    );

    await _clearStaleAuthForSwitch(kernel.address);

    await putKV(StorageKeys.AUTH_KIND, "web3auth" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, kernel.address);
    // Web3Auth EOA persisted as the POD address so POD restores on reload with
    // the correct AAD (invariant #1) — mirrors passkey's POD_ADDRESS handling.
    await putKV(StorageKeys.POD_ADDRESS, address);
    _kind = "web3auth";
    _parent = kernel.address;
    _web3authPrivateKey = privateKey;
    _web3authPodAddress = address;
    _kernel = kernel;
    _localPrivateKey = null;
    _passkeyPrivateKey = null;

    await _restoreCachedAuth();

    // Establish the client feed signer now (silent, deterministic) so profile +
    // other client feeds resolve immediately — logout wipes the on-device blob, so
    // without this a re-login would read the empty legacy feed until the next write.
    await _establishFeedSignerEagerly();

    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] web3auth login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

/**
 * Idle-prefetch the Coinbase SDK + signer modules so the actual login click
 * doesn't burn its user-gesture token on dynamic imports. Call from
 * CoinbaseLogin button mount / hover / focus — safe to call repeatedly.
 */
let _coinbasePrefetch: Promise<void> | null = null;
function prefetchCoinbaseSdk(): Promise<void> {
  if (!_coinbasePrefetch) {
    _coinbasePrefetch = Promise.all([
      import("./coinbase-account.js"),
      import("./signers/coinbase-signer.js"),
    ]).then(() => undefined);
  }
  return _coinbasePrefetch;
}

/**
 * Open the Coinbase Smart Wallet popup, claim the connected address as the
 * parent. ERC-6492/1271 signature shape is handled transparently at verify time.
 *
 * Two-step UX is intentional. CSW (`@coinbase/wallet-sdk` v4) spawns one
 * popup per RPC call: `eth_requestAccounts` for connect, `eth_signTypedData_v4`
 * for sign. The connect popup self-closes when the user approves, and the
 * SDK's `Communicator.disconnect()` runs in response to the `PopupUnload`
 * event — rejecting any in-flight sign listener with EIP-1193 4001. So we
 * MUST NOT call signTypedData inside the same click as connect. Caller
 * (CoinbaseLogin.svelte) drives the second click for the AuthorizeSession
 * sign explicitly via `ensureSession()`.
 */
async function loginCoinbase(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    await prefetchCoinbaseSdk();
    const { connectCoinbase } = await import("./coinbase-account.js");
    const { address } = await connectCoinbase();

    await _clearStaleAuthForSwitch(address);
    await putKV(StorageKeys.AUTH_KIND, "coinbase" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, address);
    _kind = "coinbase";
    _parent = address;
    _localPrivateKey = null;
    _passkeyPrivateKey = null;

    await _restoreCachedAuth();

    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] coinbase login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

async function loginPasskey(): Promise<boolean> {
  if (_busy) return false;
  _busy = true;

  try {
    // Always use discoverable get() → shows passkey picker → falls back to create
    const account = await authenticatePasskey();

    // Build the ZeroDev Kernel; its deterministic address is the parent identity.
    // The raw PRF key remains the POD source + the Kernel's ECDSA sudo signer.
    // If this passkey is the rotated owner of a RECOVERED account, its Kernel
    // address was preserved (≠ this key's counterfactual) — honour the durable
    // binding so we log into the real account, not a fresh counterfactual one.
    const { buildKernelFromPrivateKey, readKernelEcdsaOwner } = await import("./kernel-account.js");
    let override = await _recoveryKernelFor(account.address);

    // Guard: verify the local binding's Kernel still has this PRF-EOA as its
    // on-chain ECDSA owner before trusting it. A stale binding (recovery tx
    // written to IndexedDB but never confirmed, or owner later rotated away)
    // would otherwise lock the user out — the Kernel's isValidSignature returns
    // false for a key it doesn't own. Mirror: _verifyPortabilityEnvelope already
    // does this guard for the portability path.
    if (override) {
      const onChainOwner = await readKernelEcdsaOwner(override);
      if (onChainOwner !== null && onChainOwner.toLowerCase() !== account.address.toLowerCase()) {
        console.warn("[auth] local recovery binding stale — on-chain owner is", onChainOwner, "not PRF-EOA", account.address, "— clearing");
        await _deleteRecoveryBinding(account.address);
        override = undefined;
      }
    }

    // Recovered-account secret restore. A recovered passkey's PRF credential has
    // ROTATED, so its POD seed + feed signer can NEVER be re-derived from it — they
    // live only in the PRF-sealed portability envelope (written after recovery). We
    // consult that envelope when:
    //   (a) there is NO local binding — this may be the account opened on a 2ND device; OR
    //   (b) a binding exists but the on-device secrets were WIPED on logout
    //       (clearAllAuth drops the POD seed + feed signer). Without (b) a plain
    //       logout→login of a recovered account comes back with no POD seed (→ can't
    //       decrypt its own history, and ensurePodIdentity would re-derive a DIVERGENT
    //       seed from the rotated credential) and no feed signer (→ its content feeds
    //       unreadable / a divergent signer forked). The envelope is the ONLY silent
    //       restore channel — the guardian escrow needs the guardian's signature.
    // The presence probes below double as self-heal: restore* drops a foreign-AAD blob.
    let portabilityRestore:
      | { preserved: `0x${string}`; podSeed: string; feedSignerPrivKey?: string }
      | null = null;
    const { restoreContentFeedSigner } = await import("./feed-signer-store.js");
    const podSeedPresent = !!(await restorePodSeed(account.address));
    const feedSignerPresent = override ? !!(await restoreContentFeedSigner(override)) : false;
    if (!override || !podSeedPresent || !feedSignerPresent) {
      portabilityRestore = await _verifyPortabilityEnvelope(account.privateKey, account.address);
      if (portabilityRestore && !override) override = portabilityRestore.preserved;
    }

    const kernel = await buildKernelFromPrivateKey(
      account.privateKey,
      override ? { address: override } : undefined,
    );

    await _clearStaleAuthForSwitch(kernel.address);

    // Persist the escrow-restored POD seed + feed signer + durable binding (mirrors
    // recoverAndRekey). Runs AFTER _clearStaleAuthForSwitch (which wipes them on an
    // account switch), and covers BOTH first 2nd-device recovery AND a logged-out
    // recovered account whose on-device secrets were wiped.
    if (portabilityRestore) {
      await storePodSeed(account.address, portabilityRestore.podSeed);
      // Restore the feed signer under the PRESERVED parent address so this device
      // owns the recovered account's existing content feeds (mirrors recoverAndRekey).
      if (portabilityRestore.feedSignerPrivKey) {
        const { storeContentFeedSigner } = await import("./feed-signer-store.js");
        await storeContentFeedSigner(portabilityRestore.preserved, portabilityRestore.feedSignerPrivKey);
      }
      await _putRecoveryBinding(account.address, portabilityRestore.preserved);
      _feedSignerAddressMemo = null;
    }

    await putKV(StorageKeys.AUTH_KIND, "passkey" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, kernel.address);
    // PRF-EOA address persisted so POD restores on reload without a biometric
    // and with the correct AAD (invariant #1).
    await putKV(StorageKeys.POD_ADDRESS, account.address);
    _kind = "passkey";
    _parent = kernel.address;
    _passkeyPrivateKey = account.privateKey;
    _podAddress = account.address;
    _kernel = kernel;
    _localPrivateKey = null;

    await _restoreCachedAuth();

    _cleanupAccountListener?.();
    _cleanupAccountListener = null;

    return true;
  } catch (e) {
    console.error("[auth] passkey login failed:", e);
    return false;
  } finally {
    _busy = false;
  }
}

/**
 * Dispatcher: login with specified method, or show method picker.
 */
async function login(method?: "web3" | "local" | "passkey"): Promise<boolean> {
  if (method === "web3") return loginWeb3();
  if (method === "local") return loginLocal();
  if (method === "passkey") return loginPasskey();
  // No method specified — caller should show LoginModal
  return false;
}

// ---------------------------------------------------------------------------
// Deferred signing: ensureSession (lazy EIP-712 session delegation)
// ---------------------------------------------------------------------------

async function ensureSession(): Promise<boolean> {
  if (hasSession) return true;
  if (!isConnected || !_parent) return false;
  // Coalesce concurrent callers (e.g. CreatorHome firing /events/mine,
  // /sites/mine and /stripe/account-status in parallel) so the wallet
  // only ever sees a single AuthorizeSession prompt.
  if (_sessionInFlight) return _sessionInFlight;

  _busy = true;
  const parent = _parent;
  _sessionInFlight = (async () => {
    try {
      const signer = await _getSigner();
      // Kernel-backed kinds sign with the raw owner EOA (ecrecover-able) while
      // message.parent stays the Kernel — tell the local sanity check who the
      // signature should recover to. No Kernel build needed for HTTP sessions
      // any more; on-chain actions still build it lazily.
      const expectedSigner =
        _kind === "passkey"
          ? (_podAddress ?? undefined)
          : _kind === "web3auth"
            ? (_web3authPodAddress ?? undefined)
            : undefined;
      const { sessionAddress } = await requestSessionDelegation(parent, signer, expectedSigner);
      _sessionAddress = sessionAddress;
      // A session now exists — persist the cross-device portability envelope for
      // a recovered passkey account if it hasn't been written yet (covers device A
      // right after recovery + an already-recovered Account #2). Fire-and-forget;
      // never block the session on it.
      if (_kind === "passkey") void _maybeBackfillPortabilityEnvelope();
      return true;
    } catch (e) {
      console.error("[auth] session delegation failed:", e);
      return false;
    } finally {
      _busy = false;
      _sessionInFlight = null;
    }
  })();
  return _sessionInFlight;
}

// ---------------------------------------------------------------------------
// POD identity (lazy — called on first POD action)
// ---------------------------------------------------------------------------

async function ensurePodIdentity(): Promise<string | null> {
  if (_podPublicKeyHex) return _podPublicKeyHex;
  if (!isConnected || !_parent) return null;
  if (_podInFlight) return _podInFlight;

  _busy = true;
  _podInFlight = (async () => {
    try {
      // POD is keyed by the PRF-EOA address for passkey (invariant #1), the
      // parent for every other kind. _getPodAddress() reads the cached value;
      // restorePodSeed below needs no signer, so resolve the address first.
      const podAddr = _getPodAddress();
      if (!podAddr) return null;

      // Prefer an already-stored seed over re-deriving from a fresh signature.
      // CRITICAL after recovery: the passkey credential (PRF-EOA) has rotated, so
      // a fresh requestPodIdentity() would derive a DIVERGENT seed and clobber the
      // escrow-restored original — permanently breaking decryption of historical
      // encrypted data. Reusing the stored seed (escrow-restored, or a prior
      // derivation) also spares the user a redundant signature each session. For a
      // non-rotated credential the re-derived seed would be identical anyway, so
      // this never changes the identity — it only avoids the clobber + the prompt.
      const existing = await getPodKeypair(podAddr);
      if (existing) {
        _podPublicKeyHex = existing.publicKeyHex;
        return _podPublicKeyHex;
      }

      // Anti-clobber guard: a RECOVERED passkey (binding present for this PRF-EOA)
      // has a ROTATED credential, so re-deriving below would produce a DIVERGENT seed
      // and permanently break decryption of its historical data. Its real seed only
      // comes from escrow/portability restore (done at login). If it's absent here,
      // return null (POD unavailable this session) rather than clobber it — login
      // should have restored it; failing soft keeps historical data recoverable once
      // the restore path runs, whereas a divergent derive would corrupt it forever.
      if (_kind === "passkey" && (await _recoveryKernelFor(podAddr))) {
        console.error(
          "[auth] recovered passkey POD seed missing — refusing to re-derive a divergent seed",
        );
        return null;
      }

      // No stored seed (first login on this device, or post-migration) → derive it
      // with the deterministic PRF-EOA signer (passkey) / parent signer (others).
      // _getPodSigner() runs _ensurePasskeyKey() internally, so _podAddress is set.
      const signer = await _getPodSigner();
      const { podPublicKeyHex } = await requestPodIdentity(podAddr, signer);
      _podPublicKeyHex = podPublicKeyHex;
      return podPublicKeyHex;
    } catch (e) {
      console.error("[auth] POD identity derivation failed:", e);
      return null;
    } finally {
      _busy = false;
      _podInFlight = null;
    }
  })();
  return _podInFlight;
}

/**
 * Ensure a scoped on-chain ZeroDev session key exists for the passkey Kernel,
 * minting one (one PRF ceremony, via _ensureKernel) on first use. Returns the
 * Kernel address that owns the session key, for the caller to feed into the
 * permit userOp. Passkey-only — every other login kind uses the sponsor path.
 */
async function ensureWocoSessionKey(): Promise<string> {
  if (_kind !== "passkey") {
    throw new Error("ensureWocoSessionKey: only available for passkey logins");
  }
  await _ensureKernel();
  if (!_kernel) throw new Error("Kernel unavailable — cannot mint session key");
  const { hasWocoSessionKey, createWocoSessionKey } = await import("./kernel-account.js");
  // Kernel-address-aware check: a stored key minted for a DIFFERENT Kernel
  // (pre-pinning recovered-account blob, or an account switch) reports false
  // and is overwritten with a fresh, correctly-pinned key — the heal path for
  // the 2026-07-10 split-brain.
  if (!(await hasWocoSessionKey(_kernel.address))) {
    await createWocoSessionKey(_kernel);
  }
  return _kernel.address;
}

/**
 * Ensure a scoped EAS session key exists for the Kernel, minting one on first
 * use. Independent of ensureWocoSessionKey: EAS likes get their OWN key
 * (selector-scoped to attest/revoke) so they can never poison the sub-ENS key's
 * gas estimation. Returns the Kernel address that owns the key. Available to both
 * Kernel-backed kinds (passkey + web3auth) — email users like/follow gaslessly.
 */
async function ensureEasSessionKey(): Promise<string> {
  if (_kind !== "passkey" && _kind !== "web3auth") {
    throw new Error("ensureEasSessionKey: only available for passkey/web3auth logins");
  }
  await _ensureKernelForKind();
  if (!_kernel) throw new Error("Kernel unavailable — cannot mint EAS session key");
  const { hasEasSessionKey, createEasSessionKey } = await import("./kernel-account.js");
  // Kernel-address-aware check (see ensureWocoSessionKey) — wrong-Kernel blobs
  // are replaced instead of silently attesting from a divergent account.
  if (!(await hasEasSessionKey(_kernel.address))) {
    await createEasSessionKey(_kernel);
  }
  return _kernel.address;
}

// ---------------------------------------------------------------------------
// Shop spend-permission grant (passkey/Kernel only)
// ---------------------------------------------------------------------------

/**
 * Build + sudo-sign a spend-permission approval for the venue spender.
 * Wraps kernel-account.grantShopSpendPermission with the cached _kernel.
 * Returns the serialized approval blob (no private key).
 * Passkey-only — other login kinds use the per-order crypto rail instead.
 */
async function grantSpendPermission(args: {
  shopId: string;
  spenderAddress: string;
  usdcAddress: string;
  recipient: string;
  perDrawCeilingAtomic: string;
  maxDraws: number;
  validUntil: number;
}): Promise<string> {
  if (_kind !== "passkey") {
    throw new Error("Spend permissions require a passkey (Kernel) account");
  }
  await _ensureKernel();
  if (!_kernel) throw new Error("Kernel unavailable — cannot grant spend permission");
  const { grantShopSpendPermission } = await import("./kernel-account.js");
  return grantShopSpendPermission({ builtKernel: _kernel, ...args });
}

// ---------------------------------------------------------------------------
// Account recovery setup (Kernel-backed kinds: passkey + web3auth) — see
// docs/PASSKEY_RECOVERY_PLAN.md and docs/WEB3AUTH_GUARDIAN_ESCROW_HANDOVER_2026-07-02.md
// ---------------------------------------------------------------------------

/**
 * One-shot "protect this account" ceremony for a Kernel-backed user (passkey or
 * web3auth):
 *  1. install the on-chain recovery route pinned to a guardian derived from the
 *     backup wallet (sudo/passkey userOp, sponsored),
 *  2. escrow the POD seed AND the content-feed signer — sealed to an X25519 key
 *     the backup wallet derives by signing a fixed message — so a recovered
 *     account also restores ticket decryption + ownership of its content feeds
 *     (funds recovery alone cannot; §11.1).
 *
 * web3auth is included because its raw key is a `FEED_PRIVATE_KEY`-class EXTERNAL
 * config dependency: if Web3Auth ever repoints its key reconstruction, the user's
 * silent re-derivation yields a DIFFERENT feed signer + POD seed and orphans their
 * data. Escrow restores both verbatim, closing that risk. (Not for web3 wallets:
 * re-sign IS their recovery and the parent identity is lost with the wallet.)
 *
 * The backup wallet is an EXTERNAL signer the UI connects (a normal wallet the
 * user already controls). It only ever SIGNS here — it never sends a tx. We hide
 * all of this behind "add a backup" in the UI.
 */
async function setupAccountRecovery(backup: {
  address: string;
  signTypedData: import("@woco/shared").EIP712Signer;
  recoveryReady?: boolean;
  /**
   * Self-describing labels for the backup-inventory manifest (Increment 3a) — the
   * signer knows only address+signer, so the UI supplies HOW the user added this
   * backup. Non-PII memory-jogs only; never a secret.
   */
  meta?: { method?: import("@woco/shared").BackupMethod; providerLabel?: string; maskedEmail?: string };
}): Promise<{ guardianAddress: string; txHash: string }> {
  if (_kind !== "passkey" && _kind !== "web3auth") {
    throw new Error("Account recovery is only available for passkey or email/social accounts");
  }
  // Refuse to install a backup we could never recover FROM (e.g. a provider that
  // can derive the escrow key but cannot sign the guardian userOp). Installing it
  // would trap the user with an unrecoverable account.
  if (backup.recoveryReady === false) {
    throw new Error("This backup can't be used for recovery yet. Pick a wallet that can sign on Arbitrum.");
  }
  await _ensureKernelForKind();
  if (!_kernel) throw new Error("Account unavailable — please sign in again");
  const kernelAddress = _kernel.address;

  // The POD seed must exist to escrow it; derive it now if this is the first action.
  await ensurePodIdentity();
  const podAddr = _getPodAddress();
  if (!podAddr) throw new Error("Could not access your identity key");
  const seed = await restorePodSeed(podAddr);
  if (!seed) throw new Error("Could not access your identity key — open your dashboard once, then retry");

  const { deriveGuardianKeys, sealRecoveryBundle, openRecoveryBundle } = await import(
    "./recovery-escrow.js"
  );

  // Seal the escrow FIRST and verify it round-trips BEFORE the irreversible
  // on-chain install — so a non-deterministic backup signature (which would make
  // the bundle permanently un-openable) is caught here, with nothing committed.
  // Escrow the content-feed signer ALONGSIDE the POD seed (same guardian bundle):
  // both are root-derived secrets that a rotated passkey credential cannot
  // re-derive, so recovery must restore them verbatim. Establishing it here also
  // ensures the key exists before it is sealed. Non-fatal if absent.
  const feedSigner = await _getContentFeedSigner();
  const secrets: Record<string, string> = { podSeed: seed };
  if (feedSigner) secrets.feedSignerPrivKey = feedSigner.privKey;

  // ONE guardian signature derives BOTH the HPKE escrow key and the SOC signer
  // that OWNS the guardian recovery SOC (§13) — no second wallet prompt.
  const gk = await deriveGuardianKeys(backup.address, backup.signTypedData);
  const envelope = await sealRecoveryBundle({
    bundle: { version: 1, secrets },
    kernelAddress,
    guardianPublicKeysHex: [gk.encryption.publicKeyHex],
  });

  // Determinism self-check (sec-review note #1): re-derive from a SECOND signature
  // and confirm it (a) opens the bundle to the EXACT seed AND (b) reproduces the
  // SAME SOC owner address. A non-deterministic backup signature would otherwise
  // either make the bundle un-openable or orphan the guardian SOC — caught here,
  // failing loudly at setup instead of silently at recovery time.
  const gk2 = await deriveGuardianKeys(backup.address, backup.signTypedData);
  const check = await openRecoveryBundle({ envelope, kernelAddress, guardianKeypair: gk2.encryption });
  if (
    check.secrets.podSeed !== seed ||
    check.secrets.feedSignerPrivKey !== secrets.feedSignerPrivKey ||
    gk2.socSigner.address !== gk.socSigner.address
  ) {
    throw new Error(
      "Your backup wallet's signature isn't reproducible, so recovery couldn't be guaranteed. " +
        "Try a different backup wallet.",
    );
  }

  // Persist the escrow as a GUARDIAN-owned SOC (§13) — client-signed, the platform
  // only stamps postage, so it can no longer forge or withhold it. FATAL: this IS
  // the escrow. Do it BEFORE the irreversible on-chain install so a failed write
  // aborts with nothing committed (an installed recovery route with no escrow blob
  // would leave POD unrecoverable).
  const { uploadRecoveryEnvelopeSoc } = await import("../swarm/recovery-feed.js");
  await uploadRecoveryEnvelopeSoc({
    socSignerPrivKey: gk.socSigner.privKey,
    kernelAddress,
    envelope,
  });

  // Escrow persisted + proven recoverable → now do the irreversible on-chain install.
  const { deriveGuardianAddress, setupRecovery } = await import("./kernel-account.js");
  // v1 = single backup (1-of-1): one signer at full weight. Social M-of-N reuses
  // this shape with more signers + a higher threshold (no rewrite).
  const guardianConfig = { signers: [{ address: backup.address as `0x${string}`, weight: 100 }], threshold: 100 };
  const guardianAddress = await deriveGuardianAddress(guardianConfig);
  const { txHash } = await setupRecovery(_kernel, guardianAddress);

  // Best-effort: record the user's sub-ENS label so recovery can show a
  // human-readable name ("nabil.woco.eth") instead of a hex address. Non-fatal —
  // a user with no name still recovers fine (auto-find shows the address).
  let label: string | undefined;
  try {
    const { getOwnedSubEns } = await import("../api/sub-ens.js");
    const owned = await getOwnedSubEns();
    label = owned.ok ? owned.data?.names?.[0]?.label : undefined;
  } catch {
    /* name lookup is a display nicety, never block setup on it */
  }

  // Register the platform presence + auto-find hints (untrusted convenience; the
  // guardian SOC above is the source of truth). NON-FATAL — the escrow is already
  // persisted, so a hint write failing must not fail the whole protect.
  try {
    const { registerRecoveryHint } = await import("../api/recovery.js");
    const res = await registerRecoveryHint({ guardianAddress, label });
    if (!res.ok) console.warn("[recovery] hint registration failed (non-fatal):", res.error);
  } catch (err) {
    console.warn("[recovery] hint registration failed (non-fatal):", err);
  }

  // Record this backup in the user's encrypted-to-self manifest so a signed-in
  // user can later SEE and manage their backups (Increment 3a). It holds NO
  // secrets — the sealed envelope stays in the guardian SOC; this is self-owned
  // metadata (method + provider label + guardian address + date). NON-FATAL: the
  // escrow + on-chain install already succeeded; a manifest write failing must not
  // undo a completed protect. Skipped when the feed signer is unavailable (nothing
  // to own/seal the manifest with).
  if (feedSigner) {
    try {
      const { upsertBackupEntry } = await import("../manifest/inventory.js");
      await upsertBackupEntry({
        signer: { privKey: feedSigner.privKey, address: feedSigner.address },
        parentAddress: kernelAddress,
        entry: {
          method: backup.meta?.method ?? "wallet",
          providerLabel: backup.meta?.providerLabel ?? backup.meta?.method,
          guardianAddress: guardianAddress.toLowerCase(),
          addedAt: Date.now(),
          maskedEmail: backup.meta?.maskedEmail,
        },
      });
    } catch (err) {
      console.warn("[recovery] backup-inventory manifest write failed (non-fatal):", err);
    }
  }

  return { guardianAddress, txHash };
}

/**
 * "Recover my account" — the irreversible portal ceremony (PASSKEY_RECOVERY_PLAN
 * §11.6). The locked-out user is on a NEW device with no session; they have only
 * their backup wallet and the lost account's address. This:
 *
 *  0. PRE-FLIGHT: decrypts the POD escrow with the backup's derived X25519 key
 *     BEFORE any irreversible step. Only the genuine account's envelope is sealed
 *     to this guardian (the seal key comes from an unforgeable backup signature),
 *     so a failed decrypt — wrong address typed, or a poisoned auto-find hint —
 *     aborts HERE: no passkey minted, no on-chain rotation. This decrypt is the
 *     authoritative ownership proof; the guardian-index lookup is only a hint.
 *  1. Mints a FRESH passkey on this device (its PRF-EOA = the new sudo owner).
 *  2. Has the backup-wallet guardian call `target.doRecovery` — rotating the
 *     deployed Kernel's sudo owner to the new passkey. IRREVERSIBLE; the old
 *     device's passkey is retired (proven: recovery-spike-caller-hook.ts).
 *  3. Rebuilds the Kernel at the OLD address with the NEW owner (address override)
 *     — same address ⇒ funds + on-chain identity intact.
 *  4. Re-stores the ORIGINAL ed25519 seed (recovered in step 0) under the new
 *     identity → tickets + dashboard decryption survive (funds recovery alone
 *     cannot restore them; §11.1).
 *  5. Logs the user in as the recovered account.
 *
 * Funds-critical + irreversible: callers MUST confirm intent first. The guardian
 * config is reconstructed from the backup address (v1 = 1-of-1) and MUST match
 * what was registered at setup, or step 2 reverts at the caller hook.
 */
async function recoverAndRekey(args: {
  backup: import("../wallet/backup-signer.js").BackupWallet;
  targetAddress: string;
  /** Which credential becomes the new Kernel owner. "passkey" mints a fresh passkey
   *  on this device (PRF-EOA = new owner). "web3auth" runs an email/social login and
   *  its EOA becomes the new owner — the account STAYS web3auth rather than being
   *  forced to passkey (owner decision 2026-07-02). The escrow MECHANISM is
   *  credential-driven and unchanged; only the forward credential is a choice. */
  newOwnerKind?: "passkey" | "web3auth";
  /** Progress messages for the UI — emitted right before each wallet prompt so
   *  the user knows what they're approving (the guardian userOp signs an opaque
   *  hash that the wallet can't describe). */
  onProgress?: (msg: string) => void;
}): Promise<{ recoveredAddress: string; txHash: string }> {
  const { backup, targetAddress, onProgress } = args;
  const newOwnerKind = args.newOwnerKind ?? "passkey";
  if (_busy) throw new Error("Please wait — another operation is in progress");
  if (!backup.recoveryReady || !backup.getGuardianSigner) {
    throw new Error("This backup wallet can't complete a recovery. Connect a wallet that can sign on Arbitrum.");
  }
  const target = targetAddress.toLowerCase();

  _busy = true;
  try {
    // (0) PRE-FLIGHT ownership proof: decrypt the escrow BEFORE any irreversible
    // step. ONE guardian signature derives both the SOC owner (which locates the
    // escrow) and the HPKE key (which opens it), so only the true guardian of THIS
    // account can read AND decrypt it. A wrong address or a poisoned auto-find hint
    // fails here — before a passkey is minted or the on-chain owner is rotated.
    // This is the security linchpin of recovery.
    onProgress?.("Confirm the signature in your backup wallet to unlock this account's data");
    const { deriveGuardianKeys, openRecoveryBundle } = await import("./recovery-escrow.js");
    const gk = await deriveGuardianKeys(backup.address, backup.signTypedData);

    // Read the guardian-owned escrow SOC (owner derived LOCALLY from the backup
    // wallet — no platform signer in the loop, §13), falling back to the legacy
    // platform-signed feed for accounts protected before this migration. If there
    // is nothing to restore, recovery would strand the POD identity — refuse before
    // touching the chain.
    const { readRecoveryEnvelopeSoc } = await import("../swarm/recovery-feed.js");
    let envelope = await readRecoveryEnvelopeSoc(gk.socSigner.address, target);
    if (!envelope) {
      const { fetchRecoveryEnvelope } = await import("../api/recovery.js");
      envelope = await fetchRecoveryEnvelope(target);
    }
    if (!envelope) throw new Error("No backup found for that account — recovery isn't possible.");

    let podSeed: string;
    let feedSignerPrivKey: string | undefined;
    try {
      const bundle = await openRecoveryBundle({ envelope, kernelAddress: target, guardianKeypair: gk.encryption });
      if (!bundle.secrets.podSeed) throw new Error("missing podSeed");
      podSeed = bundle.secrets.podSeed;
      // Restored verbatim (not re-derived) so the recovered account keeps owning
      // the feeds it wrote under the original feed-signer address.
      feedSignerPrivKey = bundle.secrets.feedSignerPrivKey;
    } catch {
      // Don't leak whether it was a wrong account vs a corrupt blob.
      throw new Error(
        "That backup wallet can't unlock this account. Check you connected the right backup wallet and chose the right account.",
      );
    }

    // (1) New owner credential on THIS device. passkey → a fresh PRF-EOA;
    // web3auth → an email/social login whose EOA becomes the new sudo owner (the
    // account STAYS web3auth — owner decision 2026-07-02, not forced to passkey).
    // Either branch yields {newOwnerAddress, newOwnerPrivKey}; the POD seed is
    // re-homed under the new owner EOA (PRF-EOA for passkey, Web3Auth EOA otherwise).
    let newOwnerAddress: string;
    let newOwnerPrivKey: `0x${string}`;
    if (newOwnerKind === "web3auth") {
      onProgress?.("Log in with email or social to take ownership on this device…");
      const { loginWithWeb3Auth } = await import("./web3auth-account.js");
      const web3 = await loginWithWeb3Auth();
      newOwnerAddress = web3.address;
      newOwnerPrivKey = web3.privateKey;
    } else {
      onProgress?.("Create a new passkey on this device…");
      const fresh = await createPasskeyAccount();
      newOwnerAddress = fresh.address; // PRF-EOA == ECDSA sudo owner of the rebuilt Kernel
      newOwnerPrivKey = fresh.privateKey;
    }
    const newPodAddress = newOwnerAddress;

    // (2) Guardian (backup wallet) calls doRecovery → rotate sudo to the new owner.
    onProgress?.("Approve in your backup wallet to move this account to your new sign-in…");
    const guardianSigner = await backup.getGuardianSigner();
    const guardianConfig = {
      signers: [{ address: backup.address as `0x${string}`, weight: 100 }],
      threshold: 100,
    };
    const { recoverAccount } = await import("./kernel-account.js");
    const { txHash } = await recoverAccount({
      targetAddress: target,
      guardianConfig,
      guardianSigners: [guardianSigner],
      newOwnerAddress,
    });

    // (3) Rebuild the Kernel at the OLD address with the NEW owner key.
    const { buildKernelFromPrivateKey } = await import("./kernel-account.js");
    const kernel = await buildKernelFromPrivateKey(newOwnerPrivKey, { address: target });
    if (kernel.address !== target) {
      throw new Error("Recovery produced a divergent account address — aborting.");
    }

    // (4) Establish the session as the recovered account (mirrors loginPasskey,
    // but pinned to the preserved address with the escrow-restored POD seed).
    // Clear any stale auth on this device FIRST — `_clearStaleAuthForSwitch`
    // calls `clearPodIdentity()`, so the recovered seed must be stored AFTER it.
    onProgress?.("Restoring your tickets and history…");
    await _clearStaleAuthForSwitch(target);
    await storePodSeed(newPodAddress, podSeed);
    // Restore the original feed signer under the PRESERVED parent address (the
    // AAD key `_getContentFeedSigner` reads), so the recovered account keeps
    // ownership of its existing content feeds instead of deriving a new address
    // from the rotated credential. AFTER _clearStaleAuthForSwitch, which clears it.
    if (feedSignerPrivKey) {
      const { storeContentFeedSigner } = await import("./feed-signer-store.js");
      await storeContentFeedSigner(target, feedSignerPrivKey);
    }
    await putKV(StorageKeys.AUTH_KIND, newOwnerKind as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, target);
    await putKV(StorageKeys.POD_ADDRESS, newPodAddress);
    // Durable recovered-account binding: the new owner EOA (newPodAddress) controls
    // the Kernel at the PRESERVED address `target`, whose counterfactual it does NOT
    // match. loginPasskey/loginWeb3Auth/_ensureKernel*/init read this to rebuild at
    // the preserved address on every future session (survives logout — clearAllAuth).
    await _putRecoveryBinding(newPodAddress, target);
    // Cross-device portability (passkey only): `_maybeBackfillPortabilityEnvelope`
    // writes a PRF-sealed envelope on the first `ensureSession` after this ceremony,
    // so a passkey-recovered account can be re-opened on a THIRD device. A web3auth
    // owner has no PRF channel, so its envelope is not written — re-opening a
    // web3auth-recovered account on a new device means re-running the portal (the
    // web3auth key + guardian escrow are reproducible, so that always works).
    _kind = newOwnerKind;
    _parent = target;
    if (newOwnerKind === "web3auth") {
      _web3authPrivateKey = newOwnerPrivKey;
      _web3authPodAddress = newPodAddress;
      _passkeyPrivateKey = null;
    } else {
      _passkeyPrivateKey = newOwnerPrivKey;
      _web3authPrivateKey = null;
      _web3authPodAddress = null;
    }
    _podAddress = newPodAddress;
    _kernel = kernel;
    _localPrivateKey = null;
    // Cache the POD public key from the escrow-restored seed so the dashboard
    // decrypts immediately and ensurePodIdentity short-circuits (never re-derives
    // a divergent seed from the rotated credential).
    const restoredPod = await getPodKeypair(newPodAddress);
    _podPublicKeyHex = restoredPod?.publicKeyHex ?? null;
    await _restoreCachedAuth();

    return { recoveredAddress: target, txHash };
  } finally {
    _busy = false;
  }
}

// ---------------------------------------------------------------------------
// API request signing
// ---------------------------------------------------------------------------

/**
 * Sign an authenticated request.
 *
 * Produces an EIP-191 signature over a canonical challenge string:
 *   "woco-session-v1\n{method}\n{path}\n{timestamp}\n{nonce}\n{sha256(body)}"
 *
 * The challenge binds the signature to a specific method + path + body + time,
 * so the delegation bundle alone can't be replayed against other endpoints.
 *
 * Callers pass the raw body string (the exact bytes the fetch() body will be),
 * so there's no JSON.stringify canonicalization drift between client and server.
 */
async function signRequest(
  method: string,
  path: string,
  body: string,
): Promise<{
  signature: string;
  nonce: string;
  timestamp: string;
  sessionAddress: string;
  delegation: SessionDelegation;
} | null> {
  // Lazy session establishment
  if (!hasSession) {
    const ok = await ensureSession();
    if (!ok) return null;
  }
  if (!_parent) return null;

  const nonce = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const bodyHash = await sha256Hex(body);
  const challenge = [
    "woco-session-v1",
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");

  // `hasSession` can be true (derived from in-memory _sessionAddress) while the
  // underlying IndexedDB blob is gone (expired, host changed, parent-mismatch,
  // or storage was cleared). `signWithSession` silently returns null in that
  // case, which the caller would see as a missing auth header. Detect and
  // re-establish — and bind to the active `_parent` so a stale delegation
  // belonging to a previous identity can never be sent.
  let result = await signWithSession(challenge, _parent);
  if (!result) {
    _sessionAddress = null;
    const ok = await ensureSession();
    if (!ok) return null;
    result = await signWithSession(challenge, _parent);
    if (!result) return null;
  }

  const delegation = await getSessionDelegation(_parent);
  if (!delegation) return null;

  return {
    signature: result.signature,
    sessionAddress: result.sessionAddress,
    nonce,
    timestamp,
    delegation,
  };
}

/** SHA-256 hex of a UTF-8 string (for request body binding). */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

// ---------------------------------------------------------------------------
// Logout / Forget Identity
// ---------------------------------------------------------------------------

async function logout(): Promise<void> {
  _cleanupAccountListener?.();
  _cleanupAccountListener = null;
  // Disconnect WalletConnect if it was used (no injected wallet present)
  if (_kind === "web3" && typeof window !== "undefined" && !window.ethereum) {
    const { disconnectWalletConnect } = await import("../wallet/wc-provider.js");
    await disconnectWalletConnect();
  }
  if (_kind === "web3auth") {
    const { logoutWeb3Auth } = await import("./web3auth-account.js");
    await logoutWeb3Auth();
  }
  if (_kind === "coinbase") {
    const { logoutCoinbase } = await import("./coinbase-account.js");
    await logoutCoinbase();
  }
  await clearAllAuth();
}

async function clearAllAuth(): Promise<void> {
  // Capture the active account's addresses BEFORE the slot wipes below reset them —
  // needed to target this account's per-account POD-seed / feed-signer slots.
  const podAddr = _getPodAddress() ?? undefined;
  const parentAddr = _parent ?? undefined;
  await clearSession();
  await clearPodIdentity(podAddr);
  // Drop the feed-signer secret on logout (parity with the POD seed). It is
  // restorable from escrow on next login; the on-device copy should not outlive
  // the session on a shared device.
  const { clearContentFeedSigner } = await import("./feed-signer-store.js");
  await clearContentFeedSigner(parentAddr);
  // Drop the legacy PERSISTED feed-signer address cache (pre-2026-07 builds wrote
  // it). It was unauthenticated and outlived logout, leaking the previous
  // account's signer into the next login's self-reads — the live resolver now
  // uses only the AAD-bound key blob + an in-memory memo.
  await delKV(StorageKeys.CONTENT_FEED_SIGNER_ADDRESS);
  // NOTE: we intentionally do NOT clear the local account private key.
  // This lets the user re-login with the same local account later.
  // The key stays in IndexedDB; only the session state is wiped.
  // Same for RECOVERED_KERNEL_BINDING: a recovered passkey MUST re-resolve its
  // preserved Kernel address on next login, so the binding survives logout too.
  await delKV(StorageKeys.AUTH_KIND);
  await delKV(StorageKeys.PARENT_ADDRESS);
  await delKV(StorageKeys.POD_ADDRESS);
  // Drop both scoped ZeroDev session keys (sub-ENS + EAS). Re-login mints fresh.
  await delKV(StorageKeys.WOCO_AA_SESSION);
  await delKV(StorageKeys.WOCO_AA_EAS_SESSION);
  // Shared-device safety: drop all user-scoped caches (creator lists, orders, collection, claim status).
  cacheClearByPrefix(USER_SCOPED_PREFIXES);
  _kind = "none";
  _parent = null;
  _sessionAddress = null;
  _podPublicKeyHex = null;
  _localPrivateKey = null;
  _passkeyPrivateKey = null;
  _web3authPrivateKey = null;
  _podAddress = null;
  _web3authPodAddress = null;
  _kernel = null;
  _sessionInFlight = null;
  _podInFlight = null;
  _feedSignerInFlight = null;
  _feedSignerAddressMemo = null;
}

// ---------------------------------------------------------------------------
// Account change handler (web3 only)
// ---------------------------------------------------------------------------

// WalletConnect emits accountsChanged([]) transiently during chain switches.
// Debounce empty-accounts to avoid logging out mid-chain-switch.
let _emptyAccountsTimer: ReturnType<typeof setTimeout> | null = null;

function handleAccountsChanged(accounts: string[]): void {
  if (_emptyAccountsTimer) {
    clearTimeout(_emptyAccountsTimer);
    _emptyAccountsTimer = null;
  }
  if (accounts.length === 0) {
    // Delay logout — WalletConnect emits empty accounts transiently during chain switching.
    // If accounts repopulate within 3s (chain switch), the logout is cancelled.
    _emptyAccountsTimer = setTimeout(() => {
      _emptyAccountsTimer = null;
      logout();
    }, 3000);
  } else if (accounts[0]?.toLowerCase() !== _parent) {
    logout();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const auth = {
  get kind() { return _kind; },
  get parent() { return _parent; },
  get sessionAddress() { return _sessionAddress; },
  get podPublicKeyHex() { return _podPublicKeyHex; },
  // PRF-EOA address for passkey (where the POD seed + keypair are keyed,
  // invariant #1); the parent address for every other kind. POD seed/keypair
  // lookups MUST use this, NOT auth.parent — for passkey, parent is the Kernel
  // address and the POD seed is not stored there.
  get podAddress() { return _getPodAddress(); },
  get ready() { return _ready; },
  get busy() { return _busy; },
  get hasSession() { return hasSession; },
  get hasPodIdentity() { return hasPodIdentity; },
  get isConnected() { return isConnected; },
  get isAuthenticated() { return isAuthenticated; },

  init,
  login,
  loginWeb3,
  loginLocal,
  loginPasskey,
  loginWeb3Auth,
  loginCoinbase,
  prefetchCoinbaseSdk,
  ensureSession,
  logout,
  ensurePodIdentity,
  ensureWocoSessionKey,
  ensureEasSessionKey,
  grantSpendPermission,
  setupAccountRecovery,
  recoverAndRekey,
  signRequest,
  // Bind to the POD address so callers don't need to pass it (and can't pass
  // the wrong one). For passkey this is the PRF-EOA address, NOT the Kernel
  // parent (invariant #1). Returns null when not logged in.
  getPodKeypair: () => { const a = _getPodAddress(); return a ? getPodKeypair(a) : Promise.resolve(null); },
  // Content-feed signer (Phase B) — the key the user signs their own content
  // feeds with. null = this kind/state can't own feeds (fall back to platform).
  getContentFeedSigner: () => _getContentFeedSigner(),
  // Self-read SOC owner address — no prompt (see _getContentFeedSignerAddress).
  getContentFeedSignerAddress: () => _getContentFeedSignerAddress(),
  // Configured recovery backups from the encrypted-to-self manifest — prompt-free
  // read for the "Protect your account" panel (Increment 3a).
  getBackupInventory: () => getBackupInventory(),
};
