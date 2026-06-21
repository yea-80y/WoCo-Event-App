import { type AuthKind, type EIP712Signer, StorageKeys, type SessionDelegation } from "@woco/shared";
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
    // Passkey parent is the ZeroDev Kernel — it signs AuthorizeSession as an
    // ERC-1271/6492 signature (server verify-delegation.ts handles it). NOT the
    // raw PRF key. POD uses _getPodSigner() instead (invariant #1).
    await _ensureKernel();
    if (!_kernel) throw new Error("Kernel unavailable for passkey signer");
    const { createKernelTypedDataSigner } = await import("./kernel-account.js");
    return createKernelTypedDataSigner(_kernel.account);
  }
  if (_kind === "web3auth") {
    // web3auth parent is the ZeroDev Kernel (like passkey) — it signs
    // AuthorizeSession as an ERC-1271/6492 sig (server verify-delegation.ts
    // accepts it). The raw Web3Auth key is used ONLY for POD (_getPodSigner,
    // invariant #1), never for request signing.
    await _ensureKernelForWeb3Auth();
    if (!_kernel) throw new Error("Kernel unavailable for web3auth signer");
    const { createKernelTypedDataSigner } = await import("./kernel-account.js");
    return createKernelTypedDataSigner(_kernel.account);
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
 * cached session + POD identity before adopting the new account. Without
 * this, a session delegation signed by the previous wallet would be
 * misattributed to the newly-logged-in identity (cross-identity leak).
 */
async function _clearStaleAuthForSwitch(address: string): Promise<void> {
  const priorParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
  if (priorParent && priorParent.toLowerCase() !== address.toLowerCase()) {
    await clearSession();
    await clearPodIdentity();
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
 * Read the durable recovered-account binding (see StorageKeys.RECOVERED_KERNEL_BINDING).
 * Present ⇒ this device recovered an account whose Kernel address is PRESERVED
 * while its sudo owner was rotated to the bound passkey (`pod` = that passkey's
 * PRF-EOA). Returned only as a hint; callers gate on `pod` matching the live key.
 */
async function _getRecoveryBinding(): Promise<{ pod: string; kernel: string } | null> {
  return (await getKV<{ pod: string; kernel: string }>(StorageKeys.RECOVERED_KERNEL_BINDING)) ?? null;
}

/** True iff the binding applies to the passkey whose PRF-EOA is `podAddress`. */
function _bindingAddressFor(
  binding: { pod: string; kernel: string } | null,
  podAddress: string | null,
): `0x${string}` | undefined {
  if (!binding || !podAddress) return undefined;
  return binding.pod.toLowerCase() === podAddress.toLowerCase()
    ? (binding.kernel as `0x${string}`)
    : undefined;
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
): Promise<{ preserved: `0x${string}`; podSeed: string } | null> {
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
    return { preserved: opened.preservedKernelAddress as `0x${string}`, podSeed: opened.podSeed };
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
    const override = _bindingAddressFor(await _getRecoveryBinding(), _podAddress);
    if (!override) return; // only recovered accounts carry a binding

    const { derivePortabilityKeys, writePortabilityEnvelope } = await import("./recovery-portability.js");
    const { readSoc } = await import("../swarm/client-soc.js");
    const { portabilitySocIdentifier } = await import("@woco/shared");

    const keys = await derivePortabilityKeys(_passkeyPrivateKey);
    const existing = await readSoc(keys.socOwnerAddress, portabilitySocIdentifier());
    if (existing) return; // already portable

    const seed = await restorePodSeed(_podAddress);
    if (!seed) return;
    await writePortabilityEnvelope({
      passkeyPrivKey: _passkeyPrivateKey,
      preservedKernelAddress: override,
      podSeed: seed,
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
  const override = _bindingAddressFor(await _getRecoveryBinding(), _podAddress);
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
 * attach a divergent smart account. No recovery binding/override — email recovery
 * is "log in again" (same login → same key → same Kernel).
 */
async function _ensureKernelForWeb3Auth(): Promise<void> {
  if (_kernel) return;
  if (!_web3authPrivateKey) throw new Error("Web3Auth key unavailable — cannot build Kernel");
  const { buildKernelFromPrivateKey } = await import("./kernel-account.js");
  const kernel = await buildKernelFromPrivateKey(_web3authPrivateKey);
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
      const session = await restoreWeb3AuthSession();
      const storedParent = await getKV<string>(StorageKeys.PARENT_ADDRESS);
      const storedPodAddr = await getKV<string>(StorageKeys.POD_ADDRESS);

      if (session && storedParent && storedPodAddr) {
        // Connected state only — the Kernel is rebuilt lazily on first use
        // (deferred-signing), so no eth_call here. storedParent = Kernel address;
        // storedPodAddr = Web3Auth EOA (loaded BEFORE _restoreCachedAuth so POD
        // restore uses the EOA AAD, never the Kernel address — invariant #1).
        _kind = "web3auth";
        _parent = storedParent;
        _web3authPrivateKey = session.privateKey;
        _web3authPodAddress = storedPodAddr;
        await _restoreCachedAuth();
      } else {
        // Missing POD_ADDRESS = a pre-Kernel-upgrade session (parent was the raw
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
    const { buildKernelFromPrivateKey } = await import("./kernel-account.js");
    const kernel = await buildKernelFromPrivateKey(privateKey);

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
    const { buildKernelFromPrivateKey } = await import("./kernel-account.js");
    let override = _bindingAddressFor(await _getRecoveryBinding(), account.address);

    // No LOCAL binding, but this could be a RECOVERED account opened on a SECOND
    // device. Check the PRF-sealed portability envelope + on-chain owner; if it
    // verifies, adopt the preserved address and restore the POD seed below
    // (AFTER _clearStaleAuthForSwitch, which would otherwise wipe it).
    let portabilityRestore: { preserved: `0x${string}`; podSeed: string } | null = null;
    if (!override) {
      portabilityRestore = await _verifyPortabilityEnvelope(account.privateKey, account.address);
      if (portabilityRestore) override = portabilityRestore.preserved;
    }

    const kernel = await buildKernelFromPrivateKey(
      account.privateKey,
      override ? { address: override } : undefined,
    );

    await _clearStaleAuthForSwitch(kernel.address);

    // New-device recovery: persist the escrow-restored POD seed + the durable
    // binding so future sessions rebuild at the preserved address (mirrors
    // recoverAndRekey). Order matters — this runs AFTER _clearStaleAuthForSwitch.
    if (portabilityRestore) {
      await storePodSeed(account.address, portabilityRestore.podSeed);
      await putKV(StorageKeys.RECOVERED_KERNEL_BINDING, {
        pod: account.address.toLowerCase(),
        kernel: portabilityRestore.preserved,
      });
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
      if (_kind === "passkey") await _ensureKernel();
      const signer = await _getSigner();
      const { sessionAddress } = await requestSessionDelegation(parent, signer);
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
  if (!(await hasWocoSessionKey())) {
    await createWocoSessionKey(_kernel);
  }
  return _kernel.address;
}

/**
 * Ensure a scoped EAS session key exists for the passkey Kernel, minting one on
 * first use. Independent of ensureWocoSessionKey: EAS likes get their OWN key
 * (selector-scoped to attest/revoke) so they can never poison the sub-ENS key's
 * gas estimation. Returns the Kernel address that owns the key. Passkey-only.
 */
async function ensureEasSessionKey(): Promise<string> {
  if (_kind !== "passkey") {
    throw new Error("ensureEasSessionKey: only available for passkey logins");
  }
  await _ensureKernel();
  if (!_kernel) throw new Error("Kernel unavailable — cannot mint EAS session key");
  const { hasEasSessionKey, createEasSessionKey } = await import("./kernel-account.js");
  if (!(await hasEasSessionKey())) {
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
// Account recovery setup (passkey/Kernel only) — see docs/PASSKEY_RECOVERY_PLAN.md
// ---------------------------------------------------------------------------

/**
 * One-shot "protect this account" ceremony for a passkey user:
 *  1. install the on-chain recovery route pinned to a guardian derived from the
 *     backup wallet (sudo/passkey userOp, sponsored),
 *  2. escrow the POD seed — sealed to an X25519 key the backup wallet derives by
 *     signing a fixed message — so a recovered account also restores ticket
 *     decryption (funds recovery alone cannot; §11.1).
 *
 * The backup wallet is an EXTERNAL signer the UI connects (a normal wallet the
 * user already controls). It only ever SIGNS here — it never sends a tx. We hide
 * all of this behind "add a backup" in the UI.
 */
async function setupAccountRecovery(backup: {
  address: string;
  signTypedData: import("@woco/shared").EIP712Signer;
  recoveryReady?: boolean;
}): Promise<{ guardianAddress: string; txHash: string }> {
  if (_kind !== "passkey") {
    throw new Error("Account recovery is only available for passkey accounts");
  }
  // Refuse to install a backup we could never recover FROM (e.g. a provider that
  // can derive the escrow key but cannot sign the guardian userOp). Installing it
  // would trap the user with an unrecoverable account.
  if (backup.recoveryReady === false) {
    throw new Error("This backup can't be used for recovery yet. Pick a wallet that can sign on Arbitrum.");
  }
  await _ensureKernel();
  if (!_kernel) throw new Error("Account unavailable — please sign in again");
  const kernelAddress = _kernel.address;

  // The POD seed must exist to escrow it; derive it now if this is the first action.
  await ensurePodIdentity();
  const podAddr = _getPodAddress();
  if (!podAddr) throw new Error("Could not access your identity key");
  const seed = await restorePodSeed(podAddr);
  if (!seed) throw new Error("Could not access your identity key — open your dashboard once, then retry");

  const { deriveGuardianEncryptionKeypair, sealRecoveryBundle, openRecoveryBundle } = await import(
    "./recovery-escrow.js"
  );

  // Seal the escrow FIRST and verify it round-trips BEFORE the irreversible
  // on-chain install — so a non-deterministic backup signature (which would make
  // the bundle permanently un-openable) is caught here, with nothing committed.
  const gk = await deriveGuardianEncryptionKeypair(backup.address, backup.signTypedData);
  const envelope = await sealRecoveryBundle({
    bundle: { version: 1, secrets: { podSeed: seed } },
    kernelAddress,
    guardianPublicKeysHex: [gk.publicKeyHex],
  });

  // Determinism self-check (sec-review note #1): re-derive the escrow key from a
  // SECOND signature and confirm it opens the bundle to the EXACT seed. If the
  // backup's typed-data signature is non-deterministic, the second key differs and
  // this throws — failing loudly at setup instead of silently at recovery time.
  const gk2 = await deriveGuardianEncryptionKeypair(backup.address, backup.signTypedData);
  const check = await openRecoveryBundle({ envelope, kernelAddress, guardianKeypair: gk2 });
  if (check.secrets.podSeed !== seed) {
    throw new Error(
      "Your backup wallet's signature isn't reproducible, so recovery couldn't be guaranteed. " +
        "Try a different backup wallet.",
    );
  }

  // Escrow proven recoverable → now do the irreversible on-chain install.
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

  // Store the sealed envelope + the guardian→account auto-find hint together.
  const { putRecoveryEnvelope } = await import("../api/recovery.js");
  const res = await putRecoveryEnvelope(envelope, { guardianAddress, label });
  if (!res.ok) throw new Error(res.error || "Could not save your backup — please try again");

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
  /** Progress messages for the UI — emitted right before each wallet prompt so
   *  the user knows what they're approving (the guardian userOp signs an opaque
   *  hash that the wallet can't describe). */
  onProgress?: (msg: string) => void;
}): Promise<{ recoveredAddress: string; txHash: string }> {
  const { backup, targetAddress, onProgress } = args;
  if (_busy) throw new Error("Please wait — another operation is in progress");
  if (!backup.recoveryReady || !backup.getGuardianSigner) {
    throw new Error("This backup wallet can't complete a recovery. Connect a wallet that can sign on Arbitrum.");
  }
  const target = targetAddress.toLowerCase();

  // Fetch the escrow up front: if there's nothing to restore, recovery would
  // strand the POD identity — refuse before touching the chain.
  const { fetchRecoveryEnvelope } = await import("../api/recovery.js");
  const envelope = await fetchRecoveryEnvelope(target);
  if (!envelope) throw new Error("No backup found for that account — recovery isn't possible.");

  _busy = true;
  try {
    // (0) PRE-FLIGHT ownership proof: decrypt the escrow BEFORE any irreversible
    // step. The seal key derives from the backup wallet's (deterministic)
    // signature, so only the true guardian of THIS account can open it. A wrong
    // address or a poisoned auto-find hint fails here — before a passkey is minted
    // or the on-chain owner is rotated. This is the security linchpin of recovery.
    onProgress?.("Confirm the signature in your backup wallet to unlock this account's data");
    const { deriveGuardianEncryptionKeypair, openRecoveryBundle } = await import("./recovery-escrow.js");
    const gk = await deriveGuardianEncryptionKeypair(backup.address, backup.signTypedData);
    let podSeed: string;
    try {
      const bundle = await openRecoveryBundle({ envelope, kernelAddress: target, guardianKeypair: gk });
      if (!bundle.secrets.podSeed) throw new Error("missing podSeed");
      podSeed = bundle.secrets.podSeed;
    } catch {
      // Don't leak whether it was a wrong account vs a corrupt blob.
      throw new Error(
        "That backup wallet can't unlock this account. Check you connected the right backup wallet and chose the right account.",
      );
    }

    // (1) Fresh passkey on this device → its PRF-EOA is the new sudo owner.
    onProgress?.("Create a new passkey on this device…");
    const fresh = await createPasskeyAccount();
    const newOwnerAddress = fresh.address; // PRF-EOA == ECDSA sudo owner of the rebuilt Kernel

    // (2) Guardian (backup wallet) calls doRecovery → rotate sudo to the new owner.
    onProgress?.("Approve in your backup wallet to move this account to your new passkey…");
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
    const kernel = await buildKernelFromPrivateKey(fresh.privateKey, { address: target });
    if (kernel.address !== target) {
      throw new Error("Recovery produced a divergent account address — aborting.");
    }

    // (4) Establish the session as the recovered account (mirrors loginPasskey,
    // but pinned to the preserved address with the escrow-restored POD seed).
    // Clear any stale auth on this device FIRST — `_clearStaleAuthForSwitch`
    // calls `clearPodIdentity()`, so the recovered seed must be stored AFTER it.
    onProgress?.("Restoring your tickets and history…");
    await _clearStaleAuthForSwitch(target);
    await storePodSeed(fresh.address, podSeed);
    await putKV(StorageKeys.AUTH_KIND, "passkey" as AuthKind);
    await putKV(StorageKeys.PARENT_ADDRESS, target);
    await putKV(StorageKeys.POD_ADDRESS, fresh.address);
    // Durable recovered-account binding: the new passkey (PRF-EOA = fresh.address)
    // controls the Kernel at the PRESERVED address `target`, whose counterfactual
    // it does NOT match. loginPasskey/_ensureKernel read this to rebuild at the
    // preserved address on every future session (survives logout — see clearAllAuth).
    await putKV(StorageKeys.RECOVERED_KERNEL_BINDING, {
      pod: fresh.address.toLowerCase(),
      kernel: target,
    });
    // Cross-device portability envelope: written by `_maybeBackfillPortabilityEnvelope`
    // on the first `ensureSession` after this ceremony (the SOC stamp needs a
    // session). We do NOT force a session mid-recovery — the deferred-signing
    // invariant holds; the envelope persists as soon as the user takes an
    // authenticated action, making the recovered account portable to new devices.
    _kind = "passkey";
    _parent = target;
    _passkeyPrivateKey = fresh.privateKey;
    _podAddress = fresh.address;
    _kernel = kernel;
    _localPrivateKey = null;
    // Cache the POD public key from the escrow-restored seed so the dashboard
    // decrypts immediately and ensurePodIdentity short-circuits (never re-derives
    // a divergent seed from the rotated passkey credential).
    const restoredPod = await getPodKeypair(fresh.address);
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
  await clearSession();
  await clearPodIdentity();
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
};
